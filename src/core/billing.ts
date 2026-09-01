import Stripe from 'stripe';
import { config } from '../config.js';
import { logEvent } from './db.js';
import {
  createSubscriber, getSubscriberByCustomer, getSubscriberByEmail, setSubscriberStatus,
} from './subscribers.js';

let client: Stripe | null = null;

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

export async function createCheckoutSession(email: string): Promise<string> {
  const sub = createSubscriber(email);
  const session = await stripe().checkout.sessions.create({
    mode: 'subscription',
    line_items: [{ price: config.stripe.priceId, quantity: 1 }],
    customer_email: sub.stripe_customer_id ? undefined : sub.email,
    customer: sub.stripe_customer_id ?? undefined,
    client_reference_id: String(sub.id),
    allow_promotion_codes: true,
    subscription_data: config.billing.trialDays > 0 ? { trial_period_days: config.billing.trialDays } : undefined,
    success_url: `${config.baseUrl}/welcome?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${config.baseUrl}/pricing?canceled=1`,
    automatic_tax: { enabled: false },
  });
  logEvent('stripe.checkout.created', { subscriberId: sub.id, sessionId: session.id });
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
export async function handleWebhook(rawBody: Buffer | string, signature: string): Promise<{ handled: string }> {
  if (!config.stripe.webhookSecret) throw new Error('STRIPE_WEBHOOK_SECRET is not set');
  const event = stripe().webhooks.constructEvent(rawBody, signature, config.stripe.webhookSecret);
  logEvent('stripe.webhook', { type: event.type, id: event.id });

  switch (event.type) {
    case 'checkout.session.completed': {
      const s = event.data.object as Stripe.Checkout.Session;
      const email = s.customer_details?.email ?? s.customer_email ?? '';
      const subscriber =
        (s.client_reference_id ? getSubscriberByEmail(email) ?? null : null) ??
        (email ? createSubscriber(email) : null);
      if (subscriber) {
        setSubscriberStatus(subscriber.id, {
          status: config.billing.trialDays > 0 ? 'trialing' : 'active',
          plan: 'pro',
          stripe_customer_id: typeof s.customer === 'string' ? s.customer : (s.customer?.id ?? null),
          stripe_sub_id: typeof s.subscription === 'string' ? s.subscription : (s.subscription?.id ?? null),
        });
      }
      break;
    }
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      const sub = event.data.object as Stripe.Subscription;
      const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer.id;
      const local = getSubscriberByCustomer(customerId);
      if (local) {
        const status = event.type === 'customer.subscription.deleted'
          ? 'canceled'
          : (STATUS_MAP[sub.status] ?? 'free');
        const periodEndTs = (sub as unknown as { current_period_end?: number }).current_period_end;
        setSubscriberStatus(local.id, {
          status,
          plan: status === 'active' || status === 'trialing' ? 'pro' : 'free',
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
