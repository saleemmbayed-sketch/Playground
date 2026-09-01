import Stripe from 'stripe';
import { config } from '../config.js';
import { db, logEvent, nowIso } from './db.js';
import {
  confirmSubscriber, createSubscriber, getSubscriber, getSubscriberByCustomer,
  setSubscriberStatus, updateProfile,
} from './subscribers.js';

let client: Stripe | null = null;

/** Paid tiers. 'pro' = daily alerts; 'edge' = alerts + Re-tender Radar + buyer intel. */
export type Tier = 'pro' | 'edge';

export function priceIdFor(tier: Tier): string {
  return tier === 'edge' ? config.stripe.edgePriceId : config.stripe.priceId;
}

/** Maps a Stripe price back to a plan so webhook upgrades/downgrades stick. */
export function tierForPrice(priceId: string | null | undefined): Tier | null {
  if (!priceId) return null;
  if (config.stripe.edgePriceId && priceId === config.stripe.edgePriceId) return 'edge';
  if (config.stripe.priceId && priceId === config.stripe.priceId) return 'pro';
  return null;
}

/** True when the Edge tier is sellable (a price has been provisioned for it). */
export function edgeEnabled(): boolean {
  return Boolean(config.stripe.secretKey && config.stripe.edgePriceId);
}

/** Radar is the paid hero feature: Edge subscribers in good standing only. */
export function hasRadarAccess(
  sub: { plan?: string | null; status?: string | null } | null | undefined,
): boolean {
  if (!sub) return false;
  return sub.plan === 'edge' && (sub.status === 'active' || sub.status === 'trialing');
}

export function stripeEnabled(): boolean {
  return Boolean(config.stripe.secretKey && config.stripe.priceId);
}

export function stripe(): Stripe {
  if (!client) {
    if (!config.stripe.secretKey) throw new Error('STRIPE_SECRET_KEY is not set');
    client = new Stripe(config.stripe.secretKey);
  }
  return client;
}

export async function createCheckoutSession(email: string, tier: Tier = 'pro'): Promise<string> {
  const sub = createSubscriber(email);
  const price = priceIdFor(tier);
  if (!price) throw new Error(`No Stripe price configured for the "${tier}" tier`);
  const session = await stripe().checkout.sessions.create({
    mode: 'subscription',
    line_items: [{ price, quantity: 1 }],
    metadata: { tier },
    customer_email: sub.stripe_customer_id ? undefined : sub.email,
    customer: sub.stripe_customer_id ?? undefined,
    client_reference_id: String(sub.id),
    allow_promotion_codes: true,
    subscription_data: {
      metadata: { tier },
      ...(config.billing.trialDays > 0 ? { trial_period_days: config.billing.trialDays } : {}),
    },
    success_url: `${config.baseUrl}/welcome?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${config.baseUrl}/pricing?canceled=1`,
    automatic_tax: { enabled: false },
  });
  logEvent('stripe.checkout.created', { subscriberId: sub.id, sessionId: session.id, tier });
  if (!session.url) throw new Error('Stripe returned no checkout URL');
  return session.url;
}

export async function createPortalSession(customerId: string): Promise<string> {
  const session = await stripe().billingPortal.sessions.create({
    customer: customerId,
    return_url: `${config.baseUrl}${config.stripe.portalReturnPath}`,
  });
  return session.url;
}

const STATUS_MAP: Record<string, string> = {
  trialing: 'trialing',
  active: 'active',
  past_due: 'past_due',
  unpaid: 'past_due',
  canceled: 'canceled',
  incomplete: 'free',
  incomplete_expired: 'free',
  paused: 'canceled',
};

/** Verifies the signature and applies the subscription lifecycle to our DB. */
export async function handleWebhook(
  rawBody: Buffer | string,
  signature: string,
): Promise<{ handled: string; duplicate?: boolean }> {
  if (!config.stripe.webhookSecret) throw new Error('STRIPE_WEBHOOK_SECRET is not set');
  const event = stripe().webhooks.constructEvent(rawBody, signature, config.stripe.webhookSecret);

  // Stripe guarantees at-least-once delivery and retries for up to 3 days, so the same
  // event will arrive more than once. Claim it exactly once via a UNIQUE insert.
  try {
    db()
      .prepare('INSERT INTO stripe_events (id, type, received_at) VALUES (?, ?, ?)')
      .run(event.id, event.type, nowIso());
  } catch {
    logEvent('stripe.webhook.duplicate', { type: event.type, id: event.id });
    return { handled: event.type, duplicate: true };
  }

  logEvent('stripe.webhook', { type: event.type, id: event.id });

  switch (event.type) {
    case 'checkout.session.completed': {
      const s = event.data.object as Stripe.Checkout.Session;
      const email = s.customer_details?.email ?? s.customer_email ?? '';
      // Resolve in order of reliability: our own reference, then the Stripe email.
      // (The buyer may pay with a different address than the one they signed up with.)
      const byRef = s.client_reference_id ? getSubscriber(Number(s.client_reference_id)) : null;
      const subscriber = byRef ?? (email ? createSubscriber(email) : null);
      const boughtTier: Tier = s.metadata?.tier === 'edge' ? 'edge' : 'pro';
      if (subscriber) {
        setSubscriberStatus(subscriber.id, {
          status: config.billing.trialDays > 0 ? 'trialing' : 'active',
          plan: boughtTier,
          stripe_customer_id: typeof s.customer === 'string' ? s.customer : (s.customer?.id ?? null),
          stripe_sub_id: typeof s.subscription === 'string' ? s.subscription : (s.subscription?.id ?? null),
        });
        // Paying is unambiguous consent; skip the double opt-in gate for customers.
        confirmSubscriber(subscriber.id);
        // Paid customers default to daily delivery — that is the product they bought.
        updateProfile(subscriber.id, { cadence: 'daily' });
        logEvent('stripe.subscription.started', {
          subscriberId: subscriber.id, email: subscriber.email, tier: boughtTier,
        });
      } else {
        logEvent('stripe.checkout.unmatched', { sessionId: s.id, email });
      }
      break;
    }
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      const sub = event.data.object as Stripe.Subscription;
      const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer.id;
      const local = getSubscriberByCustomer(customerId);
      if (!local) {
        logEvent('stripe.subscription.unmatched', { customerId, subId: sub.id });
      }
      if (local) {
        const status = event.type === 'customer.subscription.deleted'
          ? 'canceled'
          : (STATUS_MAP[sub.status] ?? 'free');
        const periodEndTs = (sub as unknown as { current_period_end?: number }).current_period_end;
        // The price on the subscription is the source of truth for the tier,
        // so upgrades and downgrades made in the billing portal are honoured.
        const priceTier = tierForPrice(sub.items?.data?.[0]?.price?.id) ?? (local.plan as Tier) ?? 'pro';
        const paid = status === 'active' || status === 'trialing';
        setSubscriberStatus(local.id, {
          status,
          plan: paid ? priceTier : 'free',
          stripe_sub_id: sub.id,
          current_period_end: periodEndTs ? new Date(periodEndTs * 1000).toISOString() : null,
        });
      }
      break;
    }
    case 'invoice.payment_failed': {
      const inv = event.data.object as Stripe.Invoice;
      const customerId = typeof inv.customer === 'string' ? inv.customer : inv.customer?.id;
      const local = customerId ? getSubscriberByCustomer(customerId) : null;
      if (local) setSubscriberStatus(local.id, { status: 'past_due' });
      break;
    }
    default:
      break;
  }
  return { handled: event.type };
}
