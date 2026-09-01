import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Resilience: the failure modes that would silently break an unattended service.
 *
 * Mail here goes to a dead SMTP port, so every send raises a REAL transport error
 * (ECONNREFUSED) rather than a mock — this is what an ESP outage actually looks like.
 */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tenderping-res-'));
process.env.DB_FILE = path.join(tmp, 'test.db');
process.env.MAIL_TRANSPORT = 'smtp';
process.env.SMTP_URL = 'smtp://127.0.0.1:1';
process.env.TED_OFFLINE = 'true';
process.env.APP_SECRET = 'test-secret';
process.env.BASE_URL = 'https://example.test';
process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_dummy';
process.env.STRIPE_PRICE_ID = 'price_dummy';

const { upsertNotices } = await import('../src/core/notices.ts');
const { createSubscriber, updateProfile, setSubscriberStatus, confirmSubscriber, getSubscriber } =
  await import('../src/core/subscribers.ts');
const { runDailyDigest } = await import('../src/jobs/index.ts');
const { normalizeNotice } = await import('../src/ingest/ted.ts');
const { db, closeDb } = await import('../src/core/db.ts');
const { verifyMailConfig } = await import('../src/core/mailer.ts');
const { handleWebhook } = await import('../src/core/billing.ts');
const Stripe = (await import('stripe')).default;

const iso = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString().slice(0, 10);

function seed(n: number) {
  upsertNotices(
    Array.from({ length: n }, (_, i) =>
      normalizeNotice({
        'publication-number': `res-${i}-2026`,
        'notice-title': { eng: [`Cloud platform services ${i}`] },
        'buyer-name': { deu: ['Stadt Ulm'] },
        'buyer-country': ['DEU'],
        'classification-cpv': ['72212000'],
        'publication-date': `${iso(-1)}Z`,
        'deadline-receipt-tender-date-lot': [`${iso(30)}+02:00`],
        'total-value': [{ amount: 300_000, currency: 'EUR' }],
        'description-lot': { eng: ['Kubernetes platform engineering.'] },
      })!,
    ),
  );
}

function makePro(email: string) {
  const s = createSubscriber(email);
  confirmSubscriber(s.id);
  updateProfile(s.id, { cpv_prefixes: '72', countries: 'DEU', cadence: 'daily', min_score: 0.3 });
  setSubscriberStatus(s.id, { status: 'active', plan: 'pro' });
  return s;
}

test('an SMTP outage degrades the run instead of crashing it', async () => {
  seed(4);
  const subs = ['a@example.com', 'b@example.com', 'c@example.com', 'd@example.com'].map(makePro);

  const run = await runDailyDigest();

  assert.equal(run.ok, true, 'the job must complete, not throw');
  assert.equal(run.result!.recipients, 4);
  assert.equal(
    run.result!.failed,
    4,
    'all four were attempted — proof the loop continued past the first failure instead of aborting',
  );
  assert.equal(run.result!.emailsSent, 0);

  // Nothing was marked as delivered, so the next run retries them all.
  for (const s of subs) {
    const row = db().prepare('SELECT COUNT(*) c FROM deliveries WHERE subscriber_id = ?').get(s.id) as { c: number };
    assert.equal(Number(row.c), 0, `${s.email} must remain undelivered and be retried`);
  }

  // The operator can see exactly who failed and why.
  const logged = db()
    .prepare("SELECT payload FROM events WHERE kind = 'digest.recipient.failed'")
    .all() as Array<{ payload: string }>;
  assert.equal(logged.length, 4);
  assert.match(logged[0]!.payload, /ECONNREFUSED|connect/i);

  // And the failure is recorded on the job run itself, so /healthz surfaces it.
  const jobRow = db()
    .prepare("SELECT stats FROM job_runs WHERE job = 'digest.daily' ORDER BY id DESC LIMIT 1")
    .get() as { stats: string };
  assert.match(jobRow.stats, /"failed":4/);
});

test('once the transport recovers, the retried digest goes out', async () => {
  // Point the mailer at the safe outbox to simulate the provider coming back.
  process.env.MAIL_TRANSPORT = 'outbox';
  const { config } = await import('../src/config.ts');
  (config.mail as { transport: string }).transport = 'outbox';
  // Force the cached transporter to be rebuilt.
  const mailer = await import('../src/core/mailer.ts');
  mailer.resetTransport();

  const run = await runDailyDigest();
  assert.equal(run.result!.failed, 0);
  assert.equal(run.result!.emailsSent, 4, 'every subscriber missed by the outage is caught up');
  assert.ok(run.result!.matchesSent >= 4);
});

test('verifyMailConfig reports a broken transport rather than pretending', async () => {
  const { config } = await import('../src/config.ts');
  (config.mail as { transport: string }).transport = 'smtp';
  const mailer = await import('../src/core/mailer.ts');
  mailer.resetTransport();
  const res = await verifyMailConfig();
  assert.equal(res.ok, false);
  assert.match(res.detail, /ECONNREFUSED|connect/i);
  (config.mail as { transport: string }).transport = 'outbox';
  mailer.resetTransport();
});

test('duplicate Stripe webhook deliveries are processed exactly once', async () => {
  const sub = createSubscriber('billing@example.com');
  const payload = JSON.stringify({
    id: 'evt_duplicate_1',
    object: 'event',
    type: 'checkout.session.completed',
    data: {
      object: {
        id: 'cs_test_1',
        object: 'checkout.session',
        client_reference_id: String(sub.id),
        customer: 'cus_dup_1',
        subscription: 'sub_dup_1',
        customer_details: { email: 'billing@example.com' },
      },
    },
  });
  const header = Stripe.webhooks.generateTestHeaderString({ payload, secret: 'whsec_test_dummy' });

  const first = await handleWebhook(Buffer.from(payload), header);
  assert.equal(first.duplicate, undefined);
  assert.equal(getSubscriber(sub.id)!.plan, 'pro');

  const second = await handleWebhook(Buffer.from(payload), header);
  assert.equal(second.duplicate, true, 'the replay must be recognised and skipped');

  const rows = db()
    .prepare("SELECT COUNT(*) c FROM events WHERE kind = 'stripe.subscription.started'")
    .get() as { c: number };
  assert.equal(Number(rows.c), 1, 'the side effect ran exactly once');
});

test('closeDb flushes the WAL and is safe to call twice', () => {
  db().prepare("INSERT INTO kv (key, value, updated_at) VALUES ('shutdown','1',datetime('now'))").run();
  closeDb();
  closeDb(); // idempotent — SIGTERM after SIGINT must not throw
  const value = db().prepare("SELECT value FROM kv WHERE key = 'shutdown'").get() as { value: string };
  assert.equal(value.value, '1', 'data committed before shutdown survives');
});

test.after(() => {
  closeDb();
  fs.rmSync(tmp, { recursive: true, force: true });
});
