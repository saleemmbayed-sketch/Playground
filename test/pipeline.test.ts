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
const {
  createSubscriber, getProfile, updateProfile, setSubscriberStatus, alreadyDelivered,
  recordDeliveries, subscriberStats, unsubscribe, confirmSubscriber, suppress,
  freeSubscribers, payingSubscribers,
} = await import('../src/core/subscribers.ts');
const { signToken, verifyToken } = await import('../src/core/tokens.ts');
const { heuristicSummary, enrichPending } = await import('../src/core/summarize.ts');
const { runDailyDigest, runWeeklyDigest, runBackup, runPrune } = await import('../src/jobs/index.ts');
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



test('unconfirmed free subscribers are NEVER in the mailing audience', async () => {
  const pending = createSubscriber('pending@example.com');
  updateProfile(pending.id, { cpv_prefixes: '72', countries: 'DEU', cadence: 'weekly' });

  assert.ok(
    !freeSubscribers().some((s) => s.id === pending.id),
    'an unconfirmed address must not receive marketing email (GDPR / UWG §7)',
  );

  confirmSubscriber(pending.id);
  assert.ok(freeSubscribers().some((s) => s.id === pending.id), 'confirmed address joins the audience');
});

test('suppressed addresses drop out of every audience', () => {
  const s = createSubscriber('bouncer@example.com');
  updateProfile(s.id, { cpv_prefixes: '72', cadence: 'weekly' });
  confirmSubscriber(s.id);
  assert.ok(freeSubscribers().some((x) => x.id === s.id));

  suppress('bouncer@example.com', 'hard-bounce');
  assert.ok(!freeSubscribers().some((x) => x.id === s.id), 'bounced address must be excluded');

  setSubscriberStatus(s.id, { status: 'active', plan: 'pro' });
  assert.ok(!payingSubscribers().some((x) => x.id === s.id), 'even paying customers stop being mailed once suppressed');
});

test('paying customers are mailed without the confirmation gate', () => {
  const s = createSubscriber('paid-unconfirmed@example.com');
  updateProfile(s.id, { cpv_prefixes: '72', cadence: 'daily' });
  setSubscriberStatus(s.id, { status: 'active', plan: 'pro' });
  assert.ok(payingSubscribers().some((x) => x.id === s.id), 'payment is consent');
});

test('weekly free digest caps at 5 matches and upsells', async () => {
  const s = createSubscriber('weekly@example.com');
  updateProfile(s.id, { cpv_prefixes: '72', countries: 'DEU', cadence: 'weekly', min_score: 0.3 });
  confirmSubscriber(s.id);

  const res = await runWeeklyDigest();
  assert.equal(res.ok, true);
  assert.ok(res.result!.emailsSent >= 1);

  const outbox = path.resolve(process.cwd(), 'data/outbox');
  const file = fs.readdirSync(outbox).filter((f) => f.includes('weekly@example.com')).sort().pop()!;
  const body = fs.readFileSync(path.join(outbox, file), 'utf8');
  assert.match(body, /free weekly digest|Free weekly digest/i, 'free digest must carry the upgrade prompt');
  fs.rmSync(path.join(outbox, file), { force: true });
});

test('backup produces a snapshot and prune keeps live notices', async () => {
  const b = await runBackup(3);
  assert.equal(b.ok, true);
  assert.ok(fs.existsSync(b.result!.file));

  const before = (await import('../src/core/notices.ts')).countNotices();
  const p = await runPrune(400);
  assert.equal(p.ok, true);
  assert.equal(
    (await import('../src/core/notices.ts')).countNotices(),
    before,
    'notices with future deadlines must survive pruning',
  );
});

test('digest never emails an unsubscribed user', async () => {
  const s = createSubscriber('gone@example.com');
  updateProfile(s.id, { cpv_prefixes: '72', cadence: 'daily' });
  setSubscriberStatus(s.id, { status: 'active', plan: 'pro' });
  unsubscribe(s.id);
  assert.ok(!payingSubscribers().some((x) => x.id === s.id));
});

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
