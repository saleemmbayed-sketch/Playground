/**
 * One-command provisioning + preflight checks.
 *
 * `setup-stripe` creates the product, the recurring price, the webhook endpoint and turns on
 * the customer portal via the Stripe API, then prints the three env values to paste. That
 * replaces roughly fifteen clicks in the Stripe dashboard and is the step most likely to be
 * misconfigured by hand.
 *
 * `doctor` verifies every external dependency the business needs before launch.
 */
import fs from 'node:fs';
import path from 'node:path';
import Stripe from 'stripe';
import { config } from '../config.js';
import { stripe, stripeEnabled } from './billing.js';
import { verifyMailConfig } from './mailer.js';
import { countNotices, noticeStats } from './notices.js';
import { subscriberStats } from './subscribers.js';
import { fetchNotices, buildQuery } from '../ingest/ted.js';

export interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
  fatal: boolean;
}

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

/* -------------------------------------------------------------------------- */
/* doctor                                                                     */
/* -------------------------------------------------------------------------- */

export async function runDoctor(): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const add = (name: string, ok: boolean, detail: string, fatal = false) =>
    results.push({ name, ok, detail, fatal });

  // 1. Configuration sanity
  const secretOk =
    config.security.secret !== 'dev-insecure-secret-change-me' && config.security.secret.length >= 32;
  add(
    'APP_SECRET',
    secretOk,
    config.security.secret === 'dev-insecure-secret-change-me'
      ? 'still the insecure default — run `npm run setup` or set APP_SECRET'
      : secretOk
        ? 'set, 32+ chars'
        : `only ${config.security.secret.length} chars — use 32+ (openssl rand -hex 32)`,
    true,
  );
  add(
    'BASE_URL',
    /^https?:\/\/.+/.test(config.baseUrl) && !config.baseUrl.endsWith('/'),
    config.baseUrl,
    true,
  );
  const isProdUrl = config.baseUrl.startsWith('https://');
  add('HTTPS', isProdUrl, isProdUrl ? 'https base URL' : 'http base URL — fine locally, not for launch', false);
  add(
    'Legal details',
    !config.brand.legalAddress.includes('Set LEGAL_ADDRESS'),
    config.brand.legalAddress.includes('Set LEGAL_ADDRESS')
      ? 'LEGAL_ADDRESS not set — required for a German Impressum'
      : `${config.brand.legalName}, ${config.brand.legalAddress}`,
    false,
  );

  // 2. Live data source
  if (config.ted.offline) {
    add('TED API', false, 'TED_OFFLINE=true — running on fixtures, not live EU data', false);
  } else {
    try {
      const res = await fetchNotices({ lookbackDays: 3 });
      add(
        'TED API',
        res.notices.length > 0,
        res.notices.length
          ? `${res.notices.length} notices over ${res.pages} page(s); fields used: ${res.fieldsUsed.length}${res.degraded ? ' (some fields dropped)' : ''}`
          : `reachable but returned 0 notices — check the query: ${buildQuery(3)}`,
        true,
      );
    } catch (err) {
      add('TED API', false, err instanceof Error ? err.message : String(err), true);
    }
  }

  // 3. Database
  try {
    const stats = noticeStats();
    add(
      'Database',
      true,
      `${stats.total} notices, ${stats.last7} in the last 7 days, ${subscriberStats().total} subscribers`,
      false,
    );
    add(
      'Archive depth',
      countNotices() >= 50,
      countNotices() >= 50
        ? 'enough content for the public archive to rank'
        : 'thin archive — run `npm run cli -- ingest --days 30` before launch',
      false,
    );
  } catch (err) {
    add('Database', false, err instanceof Error ? err.message : String(err), true);
  }

  // 4. Email
  const mail = await verifyMailConfig();
  add(
    'Email transport',
    mail.ok && config.mail.transport === 'smtp',
    config.mail.transport === 'outbox'
      ? 'outbox mode — emails are written to data/outbox, nothing is delivered'
      : mail.detail,
    false,
  );
  add(
    'From address',
    !config.brand.fromEmail.endsWith('@localhost'),
    config.brand.fromEmail,
    false,
  );

  // 5. Payments
  if (!stripeEnabled()) {
    add('Stripe', false, 'STRIPE_SECRET_KEY / STRIPE_PRICE_ID missing — nobody can pay yet', false);
  } else {
    try {
      const price = await stripe().prices.retrieve(config.stripe.priceId);
      const amount = price.unit_amount ? (price.unit_amount / 100).toFixed(2) : '?';
      add('Stripe price', price.active, `${amount} ${price.currency?.toUpperCase()} / ${price.recurring?.interval ?? 'one-off'}`, false);
      const hooks = await stripe().webhookEndpoints.list({ limit: 100 });
      const hook = hooks.data.find((w) => w.url === `${config.baseUrl}/stripe/webhook`);
      add(
        'Stripe webhook',
        Boolean(hook && hook.status === 'enabled'),
        hook ? `${hook.url} (${hook.status})` : `no endpoint for ${config.baseUrl}/stripe/webhook — run \`setup-stripe\``,
        false,
      );
      add(
        'Webhook secret',
        Boolean(config.stripe.webhookSecret),
        config.stripe.webhookSecret ? 'set' : 'STRIPE_WEBHOOK_SECRET missing — subscription updates will be rejected',
        false,
      );
    } catch (err) {
      add('Stripe', false, err instanceof Error ? err.message : String(err), false);
    }
  }

  // 6. Scheduling
  add(
    'Scheduler',
    config.jobs.enabled,
    config.jobs.enabled
      ? `ingest ${config.jobs.ingestHourUtc}:00 UTC, digests ${config.jobs.digestHourUtc}:00 UTC`
      : 'disabled — you must trigger /ops/* from external cron',
    false,
  );

  return results;
}
