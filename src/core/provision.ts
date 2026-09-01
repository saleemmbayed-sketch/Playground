/**
 * One-command Stripe provisioning.
 *
 * Creates the product, the recurring price, the webhook endpoint (with exactly the events the
 * app handles) and the customer portal, then writes the resulting IDs back into .env. That
 * replaces roughly fifteen dashboard clicks and removes the step most likely to be
 * misconfigured by hand — a wrong webhook secret means subscriptions silently never activate.
 *
 * Idempotent: re-running finds what already exists instead of creating duplicates.
 */
import fs from 'node:fs';
import path from 'node:path';
import Stripe from 'stripe';
import { stripe } from './billing.js';
import { config } from '../config.js';

const WEBHOOK_EVENTS: Stripe.WebhookEndpointCreateParams.EnabledEvent[] = [
  'checkout.session.completed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'invoice.payment_failed',
];

export interface StripeSetupResult {
  productId: string;
  priceId: string;
  webhookId: string;
  webhookSecret: string | null;
  portalConfigured: boolean;
  reused: string[];
}

/** Idempotent: re-running finds the existing product/price/webhook instead of duplicating. */
export async function setupStripe(opts: {
  amountCents?: number;
  currency?: string;
  productName?: string;
} = {}): Promise<StripeSetupResult> {
  if (!config.stripe.secretKey) {
    throw new Error('STRIPE_SECRET_KEY is not set — add it to .env first (npm run setup).');
  }
  const s = stripe();
  const amount = opts.amountCents ?? 2900;
  const currency = (opts.currency ?? 'eur').toLowerCase();
  const productName = opts.productName ?? `${config.brand.name} Pro`;
  const reused: string[] = [];

  // --- product ------------------------------------------------------------
  const products = await s.products.list({ limit: 100, active: true });
  let product = products.data.find((p) => p.name === productName);
  if (product) {
    reused.push('product');
  } else {
    product = await s.products.create({
      name: productName,
      description: 'Daily email alerts for EU public IT and software tenders, filtered to your sectors, regions and keywords.',
      metadata: { app: 'tenderping' },
    });
  }

  // --- price --------------------------------------------------------------
  const prices = await s.prices.list({ product: product.id, active: true, limit: 100 });
  let price = prices.data.find(
    (p) => p.unit_amount === amount && p.currency === currency && p.recurring?.interval === 'month',
  );
  if (price) {
    reused.push('price');
  } else {
    price = await s.prices.create({
      product: product.id,
      unit_amount: amount,
      currency,
      recurring: { interval: 'month' },
      metadata: { app: 'tenderping' },
    });
  }

  // --- webhook ------------------------------------------------------------
  const webhookUrl = `${config.baseUrl}/stripe/webhook`;
  const hooks = await s.webhookEndpoints.list({ limit: 100 });
  let webhook = hooks.data.find((w) => w.url === webhookUrl);
  let webhookSecret: string | null = null;
  if (webhook) {
    reused.push('webhook');
    await s.webhookEndpoints.update(webhook.id, { enabled_events: WEBHOOK_EVENTS });
  } else {
    webhook = await s.webhookEndpoints.create({
      url: webhookUrl,
      enabled_events: WEBHOOK_EVENTS,
      description: `${config.brand.name} subscription lifecycle`,
    });
    webhookSecret = webhook.secret ?? null;
  }

  // --- customer portal (so cancellations never reach your inbox) ----------
  let portalConfigured = false;
  try {
    const configs = await s.billingPortal.configurations.list({ limit: 1 });
    const params: Stripe.BillingPortal.ConfigurationCreateParams = {
      business_profile: { headline: `${config.brand.name} — manage your subscription` },
      features: {
        customer_update: { enabled: true, allowed_updates: ['email', 'address', 'tax_id'] },
        invoice_history: { enabled: true },
        payment_method_update: { enabled: true },
        subscription_cancel: { enabled: true, mode: 'at_period_end' },
      },
    };
    if (configs.data.length && configs.data[0]) {
      await s.billingPortal.configurations.update(configs.data[0].id, params);
    } else {
      await s.billingPortal.configurations.create(params);
    }
    portalConfigured = true;
  } catch {
    portalConfigured = false; // Portal can also be enabled with one click in the dashboard.
  }

  return {
    productId: product.id,
    priceId: price.id,
    webhookId: webhook.id,
    webhookSecret,
    portalConfigured,
    reused,
  };
}

/** Writes/updates keys in .env in place, preserving comments and ordering. */
export function patchEnvFile(updates: Record<string, string>, envPath = path.resolve('.env')): boolean {
  if (!fs.existsSync(envPath)) return false;
  let text = fs.readFileSync(envPath, 'utf8');
  for (const [key, value] of Object.entries(updates)) {
    if (!value) continue;
    const re = new RegExp(`^${key}=.*$`, 'm');
    if (re.test(text)) text = text.replace(re, `${key}=${value}`);
    else text += `\n${key}=${value}\n`;
  }
  fs.writeFileSync(envPath, text);
  return true;
}
