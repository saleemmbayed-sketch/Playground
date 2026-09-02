/**
 * Send-cap fairness regression.
 *
 * The per-run cap guards the sending quota, but it must never let a fixed prefix
 * of the subscriber list keep getting served while a tail of subscribers is
 * starved. The audience query orders by least-recently-mailed first, so when the
 * cap defers someone, the next run retries them before anyone who was already
 * mailed this cycle.
 *
 * This pins the behaviour that matters: after the cap is hit, the deferred
 * subscriber is the FIRST to get mail on the next run, even though the early
 * subscribers have fresh matches again.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tenderping-fair-'));
process.env.DB_FILE = path.join(tmp, 'fair.db');
process.env.MAIL_TRANSPORT = 'outbox';
process.env.MAIL_OUTBOX_DIR = path.join(tmp, 'outbox');
process.env.MAIL_MAX_PER_RUN = '2';
process.env.TED_OFFLINE = 'true';
process.env.APP_SECRET = 'fair-secret';
process.env.BASE_URL = 'https://fair.test';
process.env.LEGAL_ADDRESS = 'Teststr. 1, 89073 Ulm';

const { upsertNotices } = await import('../src/core/notices.ts');
const { createSubscriber, updateProfile, setSubscriberStatus, confirmSubscriber, getSubscriberByEmail } =
  await import('../src/core/subscribers.ts');
const { runDailyDigest } = await import('../src/jobs/index.ts');
const { normalizeNotice } = await import('../src/ingest/ted.ts');

const iso = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString().slice(0, 10);

function seed(prefix: string, n: number) {
  upsertNotices(
    Array.from({ length: n }, (_, i) =>
      normalizeNotice({
        'publication-number': `${prefix}-${i}-2026`,
        'notice-title': { eng: [`Fairness framework ${prefix} ${i}`] },
        'buyer-name': { deu: ['Stadt Ulm'] },
        'buyer-country': ['DEU'],
        'classification-cpv': ['72212000'],
        'publication-date': `${iso(-1)}Z`,
        'deadline-receipt-tender-date-lot': [`${iso(30)}+02:00`],
        'total-value': [{ amount: 300_000, currency: 'EUR' }],
        'description-lot': { eng: ['Platform engineering services.'] },
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

const mailsFor = (email: string) => {
  const dir = process.env.MAIL_OUTBOX_DIR!;
  return fs.existsSync(dir)
    ? fs.readdirSync(dir).map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).filter((m) => m.includes(email))
    : [];
};

test('the send cap defers the tail, then serves them before repeat customers', async () => {
  const emails = ['a@fair.example', 'b@fair.example', 'c@fair.example', 'd@fair.example', 'e@fair.example'];
  emails.forEach(makePro);
  seed('r1', 5); // everyone has fresh matches in run 1

  const first = await runDailyDigest();
  assert.equal(first.ok, true);
  assert.equal(first.result!.emailsSent, 2, 'cap of 2 limits the first run');
  assert.equal(first.result!.capped, 3, 'the deferred tail is counted, not swallowed');

  // Which two got mail? The first two in list order would be a/b. Ordering is by
  // id here (all last_digest_at null), so a/b are served first.
  for (const e of ['a@fair.example', 'b@fair.example']) {
    assert.ok(mailsFor(e).length >= 1, `${e} should be served in run 1`);
  }
  for (const e of ['c@fair.example', 'd@fair.example', 'e@fair.example']) {
    assert.equal(mailsFor(e).length, 0, `${e} must be deferred in run 1`);
  }

  // Give a/b fresh matches again. Under a fixed order they would be served first
  // (they have new matches too) and c/d/e could starve for many runs. With
  // least-recently-mailed ordering, c/d are next, before a/b are re-mailed.
  seed('r2', 3);
  const second = await runDailyDigest();
  assert.equal(second.ok, true);
  assert.equal(second.result!.emailsSent, 2, 'the deferred tail is served before repeat customers');
  // c/d got run 2's two slots; e is still waiting, and a/b (who had fresh matches
  // too but had already been mailed) are deferred again rather than jumping the queue.
  assert.equal(mailsFor('c@fair.example').length, 1, 'c is retried before anyone already mailed');
  assert.equal(mailsFor('d@fair.example').length, 1, 'd is retried before anyone already mailed');
  assert.equal(mailsFor('e@fair.example').length, 0, 'e is still waiting for the next slot');
  assert.equal(mailsFor('a@fair.example').length, 1, 'a was not double-mailed while the tail was pending');

  // Third run: e is now least-recently-mailed and gets the next slot. After e is
  // served, a (who was mailed in run 1) is next-least-recent — fair, because b is
  // still behind e, so b stays waiting while a and e are caught up.
  const third = await runDailyDigest();
  assert.equal(third.result!.emailsSent, 2, 'e then a (the two least-recently-mailed) get the slots');
  assert.equal(mailsFor('e@fair.example').length, 1, 'e finally gets its retry');
  assert.equal(mailsFor('b@fair.example').length, 1, 'b has not been re-mailed while e was still pending');
});

test('a capped subscriber is never marked delivered, so the next run retries', async () => {
  const { db } = await import('../src/core/db.ts');
  const delivered = (email: string): number => {
    const s = getSubscriberByEmail(email)!;
    return Number(db().prepare('SELECT COUNT(*) c FROM deliveries WHERE subscriber_id = ?').get(s.id)?.c ?? 0);
  };
  // After runs 1-3: c/d/e (who were deferred in run 1) and a (mailed in run 1, then
  // correctly re-ranked behind the tail) are caught up. b — mailed in run 1 and never
  // re-ranked ahead of a pending tail member — is still behind by the run-2 notices.
  for (const email of ['a@fair.example']) {
    assert.equal(delivered(email), 8, `${email} caught up after being re-ranked behind the deferred tail`);
  }
  for (const email of ['c@fair.example', 'd@fair.example', 'e@fair.example']) {
    assert.equal(delivered(email), 8, `${email} caught up after being deferred`);
  }
  assert.equal(delivered('b@fair.example'), 5, 'b waits until the tail is fully drained');

  // Run 4: b is now the least-recently-mailed and gets its run-2 notices.
  const catchUp = (await runDailyDigest()).result!;
  assert.equal(catchUp.emailsSent, 1, 'the last remaining subscriber gets its matches');
  assert.equal(catchUp.capped, 0);

  // Everyone is caught up; the next run is genuinely empty — the deferral was a
  // retry, never a lost message.
  for (const email of ['a@fair.example', 'b@fair.example', 'c@fair.example', 'd@fair.example', 'e@fair.example']) {
    assert.equal(delivered(email), 8, `${email} must eventually receive all matches, none deferred forever`);
  }
  const drained = (await runDailyDigest()).result!;
  assert.equal(drained.skippedEmpty, 5, 'nobody has anything new after the tail was served');
  assert.equal(drained.emailsSent, 0);
  assert.equal(drained.capped, 0);
});

test.after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});
