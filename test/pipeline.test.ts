import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Isolate every pipeline test in a throwaway database + outbox.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tenderping-'));
process.env.DB_FILE = path.join(tmp, 'test.db');
process.env.MAIL_TRANSPORT = 'outbox';
process.env.TED_OFFLINE = 'true';
process.env.APP_SECRET = 'test-secret';
process.env.BASE_URL = 'https://example.test';

const { upsertNotices, recentNotices, getNotice } = await import('../src/core/notices.ts');
const { createSubscriber, getProfile, updateProfile, setSubscriberStatus, alreadyDelivered, recordDeliveries, subscriberStats, unsubscribe } =
  await import('../src/core/subscribers.ts');
const { signToken, verifyToken } = await import('../src/core/tokens.ts');
const { heuristicSummary, enrichPending } = await import('../src/core/summarize.ts');
const { runDailyDigest } = await import('../src/jobs/index.ts');
const { normalizeNotice } = await import('../src/ingest/ted.ts');

const iso = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString().slice(0, 10);

function seed(n = 5) {
  const notices = Array.from({ length: n }, (_, i) =>
    normalizeNotice({
      'publication-number': `${1000 + i}-2026`,
      'notice-title': { eng: [`Software development framework ${i}`] },
      'buyer-name': { deu: ['Stadt Ulm'] },
      'buyer-country': ['DEU'],
      'place-of-performance': ['DE144'],
      'classification-cpv': ['72212000'],
      'publication-date': `${iso(-1)}Z`,
      'deadline-receipt-tender-date-lot': [`${iso(30)}+02:00`],
      'total-value': [{ amount: 250000 + i * 1000, currency: 'EUR' }],
      'description-lot': { eng: ['Kubernetes platform engineering services.'] },
    })!,
  );
  return upsertNotices(notices);
}

test('upsert inserts once and updates thereafter', () => {
  assert.deepEqual(seed(3), { inserted: 3, updated: 0 });
  assert.deepEqual(seed(3), { inserted: 0, updated: 3 });
  assert.equal(recentNotices(new Date(Date.now() - 3 * 86_400_000).toISOString()).length, 3);
});

test('signed tokens round-trip and reject tampering', () => {
  const t = signToken({ sub: 42, scope: 'account' });
  assert.equal(verifyToken<{ sub: number }>(t)!.sub, 42);
  assert.equal(verifyToken(`${t}x`), null);
  assert.equal(verifyToken('garbage'), null);
  assert.equal(verifyToken(signToken({ sub: 1 }, -1)), null); // expired
});

test('subscriber creation is idempotent and profiles persist', () => {
  const a = createSubscriber('Ops@Example.com ');
  const b = createSubscriber('ops@example.com');
  assert.equal(a.id, b.id);
  assert.equal(a.email, 'ops@example.com');
  updateProfile(a.id, { keywords: 'kubernetes', cadence: 'daily' });
  assert.equal(getProfile(a.id)!.keywords, 'kubernetes');
});

test('heuristic summary works with no LLM key', async () => {
  const n = getNotice('1000-2026')!;
  const s = heuristicSummary(n);
  assert.match(s, /Stadt Ulm/);
  assert.match(s, /EUR/);
  const res = await enrichPending(10);
  assert.ok(res.heuristic > 0);
  assert.equal(res.llm, 0);
  assert.ok(getNotice('1000-2026')!.summary);
});

test('deliveries are recorded and never repeat', () => {
  const sub = createSubscriber('dedupe@example.com');
  assert.equal(alreadyDelivered(sub.id, ['1000-2026']).size, 0);
  recordDeliveries(sub.id, [{ id: '1000-2026', score: 0.8 }]);
  assert.equal(alreadyDelivered(sub.id, ['1000-2026', '1001-2026']).size, 1);
  recordDeliveries(sub.id, [{ id: '1000-2026', score: 0.9 }]); // no throw on re-insert
});

test('daily digest emails a paying subscriber exactly once per notice', async () => {
  const sub = createSubscriber('pro@example.com');
  updateProfile(sub.id, { cpv_prefixes: '72', countries: 'DEU', cadence: 'daily', min_score: 0.3 });
  setSubscriberStatus(sub.id, { status: 'active', plan: 'pro' });

  const first = await runDailyDigest();
  assert.equal(first.ok, true);
  assert.ok(first.result!.emailsSent >= 1, JSON.stringify(first.result));
  assert.ok(first.result!.matchesSent >= 3);

  const second = await runDailyDigest();
  assert.equal(second.result!.emailsSent, 0, 'second run must be silent: everything already delivered');
  assert.ok(second.result!.skippedEmpty >= 1);
});

test('unsubscribed users drop out of the audience', async () => {
  const before = subscriberStats().total;
  const sub = createSubscriber('bye@example.com');
  unsubscribe(sub.id);
  assert.equal(subscriberStats().total, before);
});

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
