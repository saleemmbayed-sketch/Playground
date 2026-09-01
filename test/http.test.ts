/**
 * Full-stack HTTP tests: every public route, the double opt-in gate, rate limiting,
 * admin auth, and a genuinely signature-verified Stripe webhook.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tenderping-http-'));
process.env.DB_FILE = path.join(tmp, 'http.db');
process.env.MAIL_TRANSPORT = 'outbox';
process.env.TED_OFFLINE = 'true';
process.env.APP_SECRET = 'http-test-secret';
process.env.BASE_URL = 'https://example.test';
process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_dummy';
process.env.STRIPE_PRICE_ID = 'price_dummy';
process.env.LEGAL_ADDRESS = 'Teststr. 1, 89073 Ulm';

const { buildServer } = await import('../src/server.ts');
const { upsertNotices, countNotices } = await import('../src/core/notices.ts');
const { normalizeNotice } = await import('../src/ingest/ted.ts');
const { getSubscriberByEmail, getProfile, isConfirmed, isSuppressed, createSubscriber, setSubscriberStatus } =
  await import('../src/core/subscribers.ts');
const { resetRateLimits } = await import('../src/web/ratelimit.ts');
const { signToken } = await import('../src/core/tokens.ts');

const app = buildServer();
await app.ready();

const iso = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString().slice(0, 10);

upsertNotices(
  Array.from({ length: 4 }, (_, i) =>
    normalizeNotice({
      'publication-number': `${900 + i}-2026`,
      'notice-title': { eng: [`Cloud platform operations ${i}`] },
      'buyer-name': { deu: ['Stadt Ulm'] },
      'buyer-country': ['DEU'],
      'place-of-performance': ['DE144'],
      'classification-cpv': ['72514000'],
      'publication-date': `${iso(-1)}Z`,
      'deadline': [`${iso(30)}+02:00`],
      'total-value': [{ amount: 500000, currency: 'EUR' }],
      'description-lot': { eng: ['Kubernetes operations for municipal services.'] },
    })!,
  ),
);

const get = (url: string) => app.inject({ method: 'GET', url });
/** inject() JSON-encodes object payloads, so urlencoded bodies must be built by hand. */
const post = (url: string, fields: Record<string, string>) =>
  app.inject({
    method: 'POST',
    url,
    payload: new URLSearchParams(fields).toString(),
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  });

test('public pages all render', async () => {
  for (const url of ['/', '/tenders', '/pricing', '/legal', '/robots.txt', '/sitemap.xml', '/feed.xml', '/healthz']) {
    const res = await get(url);
    assert.equal(res.statusCode, 200, `${url} -> ${res.statusCode}`);
    assert.ok(res.body.length > 50, `${url} body too short`);
  }
});

test('tender detail page renders and 404s cleanly', async () => {
  const ok = await get('/tender/900-2026');
  assert.equal(ok.statusCode, 200);
  assert.match(ok.body, /Cloud platform operations 0/);
  assert.match(ok.body, /application\/ld\+json/);
  assert.equal((await get('/tender/does-not-exist')).statusCode, 404);
});

test('sector landing pages render and are in the sitemap', async () => {
  const res = await get('/sectors/72');
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /IT services/);
  assert.equal((await get('/sectors/99')).statusCode, 404);
  assert.match((await get('/sitemap.xml')).body, /\/sectors\/72/);
});

test('archive filters work', async () => {
  assert.match((await get('/tenders?cpv=72&country=DEU')).body, /Cloud platform operations/);
  const empty = await get('/tenders?country=FRA');
  assert.match(empty.body, /No matching notices/);
});

test('signup stores the address UNCONFIRMED and sends nothing else', async () => {
  const res = await post('/subscribe', { email: 'Optin@Example.com', cpv_prefixes: '72' });
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /Check your inbox/);
  const sub = getSubscriberByEmail('optin@example.com');
  assert.ok(sub, 'subscriber row created');
  assert.equal(isConfirmed(sub.id), false, 'must NOT be confirmed before clicking the link');
});

test('confirmation link completes double opt-in; a forged one does not', async () => {
  const sub = getSubscriberByEmail('optin@example.com')!;
  const bad = await get(`/confirm?t=${signToken({ sub: sub.id, scope: 'account' })}`);
  assert.equal(bad.statusCode, 400, 'wrong scope must be rejected');
  assert.equal(isConfirmed(sub.id), false);

  const good = await get(`/confirm?t=${signToken({ sub: sub.id, scope: 'confirm' })}`);
  assert.equal(good.statusCode, 200);
  assert.match(good.body, /Confirmed/);
  assert.equal(isConfirmed(sub.id), true);
});

test('honeypot silently absorbs bots', async () => {
  const res = await post('/subscribe', { email: 'bot@example.com', website: 'http://spam' });
  assert.equal(res.statusCode, 200);
  assert.equal(getSubscriberByEmail('bot@example.com'), null);
});

test('invalid email is rejected', async () => {
  assert.equal((await post('/subscribe', { email: 'nope' })).statusCode, 400);
});

test('account page requires a valid token and saves filters', async () => {
  const sub = getSubscriberByEmail('optin@example.com')!;
  const token = signToken({ sub: sub.id, scope: 'account' });

  assert.match((await get('/account')).body, /Find your settings link/);
  assert.match((await get(`/account?t=${token}`)).body, /optin@example.com/);

  const saved = await post('/account', {
    t: token, cpv_prefixes: '48,72', countries: 'deu', nuts_prefixes: 'de1',
    keywords: 'kubernetes', exclude_words: 'reinigung', min_value: '50000',
    max_value: '900000', min_score: '0.5', cadence: 'weekly',
  });
  assert.equal(saved.statusCode, 303);

  const p = getProfile(sub.id)!;
  assert.equal(p.cpv_prefixes, '48,72');
  assert.equal(p.countries, 'DEU', 'countries are upper-cased');
  assert.equal(p.nuts_prefixes, 'DE1');
  assert.equal(p.min_value, 50000);
  assert.equal(p.min_score, 0.5);

  assert.equal((await post('/account', { t: 'forged', cpv_prefixes: '1' })).statusCode, 403);
});

test('min_score is clamped into [0,1]', async () => {
  const sub = getSubscriberByEmail('optin@example.com')!;
  const token = signToken({ sub: sub.id, scope: 'account' });
  await post('/account', { t: token, min_score: '9000', cpv_prefixes: '72', cadence: 'daily' });
  assert.equal(getProfile(sub.id)!.min_score, 1);
});

test('unsubscribe works by GET and by RFC 8058 one-click POST', async () => {
  const a = createSubscriber('leaver@example.com');
  const t1 = signToken({ sub: a.id, scope: 'unsub' });
  assert.match((await get(`/unsubscribe?t=${t1}`)).body, /Unsubscribed/);
  assert.equal(getSubscriberByEmail('leaver@example.com')!.status, 'unsubscribed');

  const b = createSubscriber('oneclick@example.com');
  const t2 = signToken({ sub: b.id, scope: 'unsub' });
  const res = await app.inject({ method: 'POST', url: `/unsubscribe?t=${t2}` });
  assert.equal(res.statusCode, 200);
  assert.equal(getSubscriberByEmail('oneclick@example.com')!.status, 'unsubscribed');
});

test('rate limiter blocks a signup flood', async () => {
  resetRateLimits();
  const codes: number[] = [];
  for (let i = 0; i < 8; i += 1) {
    codes.push((await post('/subscribe', { email: `flood${i}@example.com` })).statusCode);
  }
  assert.ok(codes.includes(429), `expected a 429, got ${codes.join(',')}`);
  resetRateLimits();
});

test('admin dashboard is locked without the key and works with it', async () => {
  assert.equal((await get('/admin')).statusCode, 403);
  assert.equal((await get('/admin?key=wrong')).statusCode, 403);
  const ok = await get('/admin?key=http-test-secret');
  assert.equal(ok.statusCode, 200);
  assert.match(ok.body, /MRR/);
  assert.match(ok.body, /awaiting opt-in confirmation/);
});

test('ops endpoints require the shared secret', async () => {
  assert.equal((await app.inject({ method: 'POST', url: '/ops/ingest' })).statusCode, 403);
  const ok = await app.inject({
    method: 'POST', url: '/ops/ingest', headers: { 'x-ops-key': 'http-test-secret' },
  });
  assert.equal(ok.statusCode, 200);
  assert.ok(countNotices() > 0);

  const unknown = await app.inject({
    method: 'POST', url: '/ops/nope', headers: { 'x-ops-key': 'http-test-secret' },
  });
  assert.equal(unknown.statusCode, 404);
});

test('backup job produces a restorable snapshot', async () => {
  const res = await app.inject({
    method: 'POST', url: '/ops/backup', headers: { 'x-ops-key': 'http-test-secret' },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json() as any;
  assert.equal(body.ok, true);
  assert.ok(fs.existsSync(body.result.file), 'backup file exists');
  assert.ok(body.result.sizeBytes > 1000, 'backup is not empty');

  // Prove the snapshot is a real, readable database with our data in it.
  const { DatabaseSync } = await import('node:sqlite');
  const copy = new DatabaseSync(body.result.file);
  const c = copy.prepare('SELECT COUNT(*) c FROM notices').get() as any;
  assert.ok(Number(c.c) > 0, 'backup contains notices');
  copy.close();
});

test('mail webhook suppresses bounced addresses, and only with the key', async () => {
  const bounce = { type: 'email.bounced', data: { to: ['bounced@example.com'] } };
  const noKey = await app.inject({ method: 'POST', url: '/mail/webhook', payload: bounce });
  assert.equal(noKey.statusCode, 403);
  assert.equal(isSuppressed('bounced@example.com'), false);

  const ok = await app.inject({
    method: 'POST', url: '/mail/webhook?key=http-test-secret', payload: bounce,
  });
  assert.equal(ok.statusCode, 200);
  assert.equal(isSuppressed('bounced@example.com'), true);
});

test('suppressed addresses are never mailed again', async () => {
  const { sendMail, resetSendCounter } = await import('../src/core/mailer.ts');
  resetSendCounter();
  const res = await sendMail({
    to: 'bounced@example.com', subject: 'x', html: '<p>x</p>', text: 'x',
  });
  assert.equal(res.ok, false);
  assert.equal(res.skipped, 'address suppressed');
});

test('Stripe webhook rejects an unsigned payload', async () => {
  const res = await app.inject({
    method: 'POST', url: '/stripe/webhook', payload: { type: 'checkout.session.completed' },
    headers: { 'stripe-signature': 'garbage' },
  });
  assert.equal(res.statusCode, 400);
});

test('Stripe webhook with a VALID signature activates the subscription', async () => {
  const Stripe = (await import('stripe')).default;
  const target = createSubscriber('buyer@example.com');
  assert.equal(isConfirmed(target.id), false);

  const event = {
    id: 'evt_test_1',
    object: 'event',
    type: 'checkout.session.completed',
    api_version: '2024-06-20',
    created: Math.floor(Date.now() / 1000),
    livemode: false,
    pending_webhooks: 0,
    request: { id: null, idempotency_key: null },
    data: {
      object: {
        id: 'cs_test_1',
        object: 'checkout.session',
        client_reference_id: String(target.id),
        customer: 'cus_test_1',
        subscription: 'sub_test_1',
        customer_details: { email: 'buyer@example.com' },
      },
    },
  };
  const payload = JSON.stringify(event);
  const header = Stripe.webhooks.generateTestHeaderString({ payload, secret: 'whsec_test_dummy' });

  const res = await app.inject({
    method: 'POST', url: '/stripe/webhook', payload,
    headers: { 'stripe-signature': header, 'content-type': 'application/json' },
  });
  assert.equal(res.statusCode, 200, res.body);

  const after = getSubscriberByEmail('buyer@example.com')!;
  assert.equal(after.status, 'trialing');
  assert.equal(after.plan, 'pro');
  assert.equal(after.stripe_customer_id, 'cus_test_1');
  assert.equal(after.stripe_sub_id, 'sub_test_1');
  assert.equal(isConfirmed(after.id), true, 'paying implies consent');
  assert.equal(getProfile(after.id)!.cadence, 'daily', 'customers get the daily product');
});

test('Stripe webhook cancellation downgrades the subscriber', async () => {
  const Stripe = (await import('stripe')).default;
  const event = {
    id: 'evt_test_2', object: 'event', type: 'customer.subscription.deleted',
    api_version: '2024-06-20', created: Math.floor(Date.now() / 1000), livemode: false,
    pending_webhooks: 0, request: { id: null, idempotency_key: null },
    data: { object: { id: 'sub_test_1', object: 'subscription', customer: 'cus_test_1', status: 'canceled' } },
  };
  const payload = JSON.stringify(event);
  const header = Stripe.webhooks.generateTestHeaderString({ payload, secret: 'whsec_test_dummy' });
  const res = await app.inject({
    method: 'POST', url: '/stripe/webhook', payload,
    headers: { 'stripe-signature': header, 'content-type': 'application/json' },
  });
  assert.equal(res.statusCode, 200);
  const after = getSubscriberByEmail('buyer@example.com')!;
  assert.equal(after.status, 'canceled');
  assert.equal(after.plan, 'free');
});

test('payment failure marks the account past_due', async () => {
  const Stripe = (await import('stripe')).default;
  const event = {
    id: 'evt_test_3', object: 'event', type: 'invoice.payment_failed',
    api_version: '2024-06-20', created: Math.floor(Date.now() / 1000), livemode: false,
    pending_webhooks: 0, request: { id: null, idempotency_key: null },
    data: { object: { id: 'in_1', object: 'invoice', customer: 'cus_test_1' } },
  };
  const payload = JSON.stringify(event);
  const header = Stripe.webhooks.generateTestHeaderString({ payload, secret: 'whsec_test_dummy' });
  await app.inject({
    method: 'POST', url: '/stripe/webhook', payload,
    headers: { 'stripe-signature': header, 'content-type': 'application/json' },
  });
  assert.equal(getSubscriberByEmail('buyer@example.com')!.status, 'past_due');
});

test('billing portal is refused without a linked Stripe customer', async () => {
  const s = createSubscriber('nobilling@example.com');
  setSubscriberStatus(s.id, { status: 'free' });
  const res = await get(`/billing-portal?t=${signToken({ sub: s.id, scope: 'account' })}`);
  assert.equal(res.statusCode, 403);
});

test.after(async () => {
  await app.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('health reports degradation without failing the container liveness probe', async () => {
  const { db } = await import('../src/core/db.ts');
  const { runIngest } = await import('../src/jobs/index.ts');
  await runIngest();

  // Baseline: a working instance is healthy under both probes.
  const healthy = JSON.parse((await get('/healthz')).body);
  assert.equal(healthy.degraded, false, JSON.stringify(healthy.problems));
  assert.equal((await get('/healthz?strict=1')).statusCode, 200);

  // Now simulate last night's digest failing to reach 3 people.
  const info = db()
    .prepare("INSERT INTO job_runs (job, started_at, ended_at, ok, stats) VALUES ('digest.daily', datetime('now'), datetime('now'), 1, '{\"failed\":3}')")
    .run();

  const live = await get('/healthz');
  const body = JSON.parse(live.body);
  assert.equal(live.statusCode, 200, 'Docker liveness must stay 200 or the container restart-loops');
  assert.equal(body.degraded, true);
  assert.ok(
    body.problems.some((p: string) => /3 recipient send failure/.test(p)),
    `expected a send-failure problem, got ${JSON.stringify(body.problems)}`,
  );

  // An uptime monitor asks the strict question and gets a page-worthy 503.
  assert.equal((await get('/healthz?strict=1')).statusCode, 503);

  // Once the bad run ages out, the instance reports healthy again.
  db().prepare('DELETE FROM job_runs WHERE id = ?').run(Number(info.lastInsertRowid));
  const recovered = JSON.parse((await get('/healthz?strict=1')).body);
  assert.equal(recovered.degraded, false, JSON.stringify(recovered.problems));
  assert.ok(recovered.notices > 0);
});

test('brand assets and social metadata are served', async () => {
  // OG/Twitter cards decide whether a shared link looks like a product or a broken URL.
  const home = await app.inject({ method: 'GET', url: '/' });
  assert.match(home.body, /<meta property="og:image" content="https:\/\/example\.test\/static\/og-image\.png">/);
  assert.match(home.body, /<meta name="twitter:card" content="summary_large_image">/);
  assert.match(home.body, /<link rel="icon" type="image\/png" href="\/static\/logo\.png">/);

  const logo = await app.inject({ method: 'GET', url: '/static/logo.png' });
  assert.equal(logo.statusCode, 200);
  assert.match(String(logo.headers['content-type']), /image\/png/);
  assert.match(String(logo.headers['cache-control']), /max-age=\d+/);

  const og = await app.inject({ method: 'GET', url: '/static/og-image.png' });
  assert.equal(og.statusCode, 200);

  // Static serving must not become a file-read primitive.
  const escape = await app.inject({ method: 'GET', url: '/static/../../package.json' });
  assert.notEqual(escape.statusCode, 200);
});

test('canonical og:url tracks the current page', async () => {
  const pricing = await app.inject({ method: 'GET', url: '/pricing' });
  assert.match(pricing.body, /<meta property="og:url" content="https:\/\/example\.test\/pricing">/);
});

// --- UAT regressions -------------------------------------------------------
// Each of these was a live 500 (or a real deliverability hazard) found by
// scripts/uat.mjs and scripts/uat-lifecycle.ts. Kept here so they stay fixed.

test('absurd pagination input cannot 500 the archive', async () => {
  // parseInt('9'.repeat(400)) is Infinity, which reached SQLite as an OFFSET and
  // threw "datatype mismatch" — a 500 any crawler could trigger with a bad link.
  for (const page of ['9'.repeat(400), '-1', '0', 'abc', '1e999', 'Infinity', 'NaN']) {
    const r = await app.inject({ method: 'GET', url: `/tenders?page=${encodeURIComponent(page)}` });
    assert.equal(r.statusCode, 200, `page=${page.slice(0, 12)} → ${r.statusCode}`);
  }
});

test('a malformed JSON body is a 400, not a 500', async () => {
  // The content-type parser threw a bare SyntaxError, which Fastify reports as
  // 500 — paging the operator for what is really a bad client request.
  const r = await app.inject({
    method: 'POST',
    url: '/stripe/webhook',
    headers: { 'content-type': 'application/json', 'stripe-signature': 't=1,v1=deadbeef' },
    payload: 'not json at all',
  });
  assert.equal(r.statusCode, 400);
});

test('the weekly digest never sends an empty email', async () => {
  // Free subscribers used to get a weekly mail even with zero fresh matches:
  // pure upsell, and the fastest route to spam complaints.
  const { runWeeklyDigest } = await import('../src/jobs/index.js');
  for (let i = 0; i < 12; i += 1) await runWeeklyDigest();
  const drained = (await runWeeklyDigest()).result as { emailsSent: number };
  assert.equal(drained.emailsSent, 0, 'a digest with nothing new in it was still sent');
});

test('/ops refuses the secret via query string', async () => {
  // Query strings leak into proxy logs and browser history; the key is header-only.
  const viaQuery = await app.inject({
    method: 'POST', url: `/ops/ingest?key=${encodeURIComponent(process.env.APP_SECRET ?? 'test-secret')}`,
  });
  assert.equal(viaQuery.statusCode, 403);

  const unknownJob = await app.inject({
    method: 'POST', url: '/ops/no-such-job',
    headers: { 'x-ops-key': process.env.APP_SECRET ?? 'test-secret' },
  });
  assert.equal(unknownJob.statusCode, 404);
});
