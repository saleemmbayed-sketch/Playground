/**
 * End-to-end tests against the real Fastify app via light-my-request (fastify.inject).
 * Covers the full commercial path: visit → signup → double opt-in → filters → digest →
 * Stripe webhook upgrade → paid digest → unsubscribe.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tenderping-e2e-'));
process.env.DB_FILE = path.join(tmp, 'e2e.db');
process.env.MAIL_TRANSPORT = 'outbox';
process.env.TED_OFFLINE = 'true';
process.env.APP_SECRET = 'e2e-secret-key';
process.env.BASE_URL = 'https://example.test';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_e2e';
process.env.STRIPE_SECRET_KEY = 'sk_test_placeholder';
process.env.STRIPE_PRICE_ID = 'price_test_placeholder';
process.env.SCHEDULER_ENABLED = 'false';
// Keep the outbox inside the temp dir so real runs are never polluted.
process.chdir(tmp);
fs.mkdirSync(path.join(tmp, 'data/fixtures'), { recursive: true });

const REPO = new URL('..', import.meta.url).pathname;

// Copy fixtures into the sandboxed cwd so offline ingest has data.
fs.copyFileSync(
  path.join(REPO, 'data/fixtures/sample-notices.json'),
  path.join(tmp, 'data/fixtures/sample-notices.json'),
);

const { buildServer } = await import(path.join(REPO, 'src/server.ts'));
const { runIngest, runDailyDigest } = await import(path.join(REPO, 'src/jobs/index.ts'));
const { getSubscriberByEmail, getProfile } = await import(path.join(REPO, 'src/core/subscribers.ts'));
const { db } = await import(path.join(REPO, 'src/core/db.ts'));

const app = buildServer();
await app.ready();

const outboxFiles = (): string[] => {
  const dir = path.join(tmp, 'data/outbox');
  return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
};
const readOutbox = (needle: string): string => {
  const dir = path.join(tmp, 'data/outbox');
  const file = fs.readdirSync(dir).filter((f) => f.includes(needle)).sort().pop();
  assert.ok(file, `no outbox message for ${needle}`);
  return fs.readFileSync(path.join(dir, file), 'utf8');
};
/** Quoted-printable soft line breaks split URLs across lines; undo that. */
const unwrap = (s: string): string => s.replace(/=\r?\n/g, '').replace(/=3D/g, '=');

await test('ingest fills the archive from fixtures', async () => {
  const res = await runIngest();
  assert.equal(res.ok, true);
  assert.ok(res.result!.inserted > 20, JSON.stringify(res.result));
});

await test('public pages render and are indexable', async () => {
  for (const url of ['/', '/tenders', '/pricing', '/legal', '/robots.txt', '/sitemap.xml', '/feed.xml']) {
    const r = await app.inject({ method: 'GET', url });
    assert.equal(r.statusCode, 200, `${url} returned ${r.statusCode}`);
  }
  const home = await app.inject({ method: 'GET', url: '/' });
  assert.match(home.body, /Stop reading TED/);
  assert.match(home.body, /notices indexed/);

  const sitemap = await app.inject({ method: 'GET', url: '/sitemap.xml' });
  assert.match(sitemap.body, /<loc>https:\/\/example\.test\/tender\//);

  const robots = await app.inject({ method: 'GET', url: '/robots.txt' });
  assert.match(robots.body, /Sitemap: https:\/\/example\.test\/sitemap\.xml/);
});

await test('tender detail pages carry canonical + structured data', async () => {
  const id = (db().prepare('SELECT id FROM notices LIMIT 1').get() as any).id as string;
  const r = await app.inject({ method: 'GET', url: `/tender/${encodeURIComponent(id)}` });
  assert.equal(r.statusCode, 200);
  assert.match(r.body, /application\/ld\+json/);
  assert.match(r.body, /rel="canonical"/);
  assert.match(r.body, /ted\.europa\.eu/);

  const missing = await app.inject({ method: 'GET', url: '/tender/does-not-exist' });
  assert.equal(missing.statusCode, 404);
});

await test('archive filters work', async () => {
  const r = await app.inject({ method: 'GET', url: '/tenders?cpv=72&country=DEU&q=cloud' });
  assert.equal(r.statusCode, 200);
  const none = await app.inject({ method: 'GET', url: '/tenders?q=zzzzzznotarealterm' });
  assert.match(none.body, /No matching notices/);
});

await test('signup requires double opt-in before any alert is sent', async () => {
  const r = await app.inject({
    method: 'POST',
    url: '/subscribe',
    payload: 'email=owner%40acme.de&cpv_prefixes=72',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  });
  assert.equal(r.statusCode, 200);
  assert.match(r.body, /Check your inbox/);

  const sub = getSubscriberByEmail('owner@acme.de')!;
  assert.equal(sub.status, 'pending', 'must not be subscribed until confirmed');

  // A digest run must ignore pending subscribers entirely.
  const before = outboxFiles().length;
  await runDailyDigest();
  const confirmationOnly = outboxFiles().length - before;
  assert.equal(confirmationOnly, 0, 'pending subscribers must receive nothing');

  const email = unwrap(readOutbox('owner@acme.de'));
  const link = email.match(/https:\/\/example\.test\/confirm\?t=([A-Za-z0-9._-]+)/);
  assert.ok(link, 'confirmation email must contain a confirm link');

  const confirmed = await app.inject({ method: 'GET', url: `/confirm?t=${link![1]}` });
  assert.equal(confirmed.statusCode, 200);
  assert.match(confirmed.body, /Confirmed/);
  assert.equal(getSubscriberByEmail('owner@acme.de')!.status, 'free');
});

await test('expired or forged confirmation links are rejected', async () => {
  const r = await app.inject({ method: 'GET', url: '/confirm?t=not-a-real-token' });
  assert.equal(r.statusCode, 400);
  assert.match(r.body, /expired/i);
});

await test('honeypot silently absorbs bot signups', async () => {
  await app.inject({
    method: 'POST',
    url: '/subscribe',
    payload: 'email=bot%40spam.ru&website=http%3A%2F%2Fspam',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  });
  assert.equal(getSubscriberByEmail('bot@spam.ru'), null);
});

await test('subscriber can edit filters through the signed link', async () => {
  const sub = getSubscriberByEmail('owner@acme.de')!;
  const welcome = unwrap(readOutbox('owner@acme.de'));
  const acct = welcome.match(/https:\/\/example\.test\/account\?t=([A-Za-z0-9._-]+)/);
  assert.ok(acct, 'welcome email must contain a settings link');
  const token = acct![1]!;

  const page = await app.inject({ method: 'GET', url: `/account?t=${token}` });
  assert.equal(page.statusCode, 200);
  assert.match(page.body, /owner@acme\.de/);

  const save = await app.inject({
    method: 'POST',
    url: '/account',
    payload: new URLSearchParams({
      t: token,
      cpv_prefixes: '72,48',
      countries: 'DEU',
      nuts_prefixes: '',
      keywords: 'cloud',
      exclude_words: 'construction',
      min_value: '50000',
      max_value: '5000000',
      min_score: '0.3',
      cadence: 'daily',
    }).toString(),
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  });
  assert.equal(save.statusCode, 303);

  const profile = getProfile(sub.id)!;
  assert.equal(profile.keywords, 'cloud');
  assert.equal(profile.exclude_words, 'construction');
  assert.equal(profile.min_value, 50000);
  assert.equal(profile.cadence, 'daily');
});

await test('forged account tokens cannot mutate anything', async () => {
  const r = await app.inject({
    method: 'POST',
    url: '/account',
    payload: 't=forged.token&keywords=hacked',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  });
  assert.equal(r.statusCode, 403);
});

await test('a signed Stripe webhook upgrades the subscriber to Pro', async () => {
  const sub = getSubscriberByEmail('owner@acme.de')!;
  db().prepare('UPDATE subscribers SET stripe_customer_id = ? WHERE id = ?').run('cus_e2e_1', sub.id);

  const payload = JSON.stringify({
    id: 'evt_e2e_1',
    object: 'event',
    type: 'customer.subscription.updated',
    data: {
      object: {
        id: 'sub_e2e_1',
        object: 'subscription',
        customer: 'cus_e2e_1',
        status: 'active',
        current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400,
      },
    },
  });
  const ts = Math.floor(Date.now() / 1000);
  const signature = crypto
    .createHmac('sha256', process.env.STRIPE_WEBHOOK_SECRET!)
    .update(`${ts}.${payload}`)
    .digest('hex');

  const r = await app.inject({
    method: 'POST',
    url: '/stripe/webhook',
    payload,
    headers: { 'content-type': 'application/json', 'stripe-signature': `t=${ts},v1=${signature}` },
  });
  assert.equal(r.statusCode, 200, r.body);

  const updated = getSubscriberByEmail('owner@acme.de')!;
  assert.equal(updated.status, 'active');
  assert.equal(updated.plan, 'pro');
});

await test('unsigned webhooks are rejected', async () => {
  const r = await app.inject({
    method: 'POST',
    url: '/stripe/webhook',
    payload: '{}',
    headers: { 'content-type': 'application/json', 'stripe-signature': 't=1,v1=deadbeef' },
  });
  assert.equal(r.statusCode, 400);
});

await test('the now-paying subscriber receives a daily digest, then silence', async () => {
  const before = outboxFiles().length;
  const first = await runDailyDigest();
  assert.ok(first.result!.emailsSent >= 1, JSON.stringify(first.result));
  assert.ok(outboxFiles().length > before);

  const body = unwrap(readOutbox('owner@acme.de'));
  assert.match(body, /match \d+%|Match \d+%/, 'digest should show match scores');
  assert.match(body, /List-Unsubscribe/i);

  const second = await runDailyDigest();
  assert.equal(second.result!.emailsSent, 0, 'no repeats on the second run');
});

await test('admin dashboard is locked and then usable', async () => {
  assert.equal((await app.inject({ method: 'GET', url: '/admin' })).statusCode, 403);
  assert.equal((await app.inject({ method: 'GET', url: '/admin?key=wrong' })).statusCode, 403);

  const ok = await app.inject({ method: 'GET', url: '/admin?key=e2e-secret-key' });
  assert.equal(ok.statusCode, 200);
  assert.match(ok.body, /MRR estimate/);
  assert.match(ok.body, /Recent job runs/);
});

await test('ops endpoints require the key', async () => {
  assert.equal((await app.inject({ method: 'POST', url: '/ops/ingest' })).statusCode, 403);
  const ok = await app.inject({
    method: 'POST',
    url: '/ops/ingest',
    headers: { 'x-ops-key': 'e2e-secret-key' },
  });
  assert.equal(ok.statusCode, 200);
  assert.equal((await app.inject({ method: 'POST', url: '/ops/nope', headers: { 'x-ops-key': 'e2e-secret-key' } })).statusCode, 404);
});

await test('one-click unsubscribe stops everything', async () => {
  const digest = unwrap(readOutbox('owner@acme.de'));
  const unsub = digest.match(/https:\/\/example\.test\/unsubscribe\?t=([A-Za-z0-9._-]+)/);
  assert.ok(unsub, 'digest must contain an unsubscribe link');

  const post = await app.inject({ method: 'POST', url: `/unsubscribe?t=${unsub![1]}` });
  assert.equal(post.statusCode, 200);
  assert.equal(getSubscriberByEmail('owner@acme.de')!.status, 'unsubscribed');

  const after = await runDailyDigest();
  assert.equal(after.result!.emailsSent, 0);
});

await test('healthz reports pipeline state for uptime monitoring', async () => {
  const r = await app.inject({ method: 'GET', url: '/healthz' });
  assert.equal(r.statusCode, 200);
  const json = r.json();
  assert.equal(json.ok, true);
  assert.ok(json.notices > 0);
  assert.ok(Array.isArray(json.recentJobs));
});

test.after(async () => {
  await app.close();
  process.chdir(REPO);
  fs.rmSync(tmp, { recursive: true, force: true });
});
