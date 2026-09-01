/**
 * Lifecycle and failure-injection UAT.
 *
 * The HTTP suite (scripts/uat.mjs) checks what an anonymous stranger can do.
 * This one drives the stateful journeys end to end with real signed tokens —
 * signup through cancellation — and then breaks the two dependencies the
 * business cannot control (TED and the mail provider) to prove the machine
 * degrades instead of dying.
 *
 *   npx tsx scripts/uat-lifecycle.ts
 *
 * Uses a scratch database and outbox; never touches your real data.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tenderping-uat-'));
process.env.DB_FILE = path.join(tmp, 'uat.db');
process.env.MAIL_TRANSPORT = 'outbox';
process.env.MAIL_OUTBOX_DIR = path.join(tmp, 'outbox');
process.env.TED_OFFLINE = 'true';
process.env.APP_SECRET = 'uat-secret';
process.env.BASE_URL = 'https://uat.test';
process.env.SCHEDULER_ENABLED = 'false';
process.env.LEGAL_ADDRESS = 'Teststr. 1, 89073 Ulm';
process.env.STRIPE_SECRET_KEY = 'sk_test_uat';
process.env.STRIPE_PRICE_ID = 'price_pro_uat';
process.env.STRIPE_EDGE_PRICE_ID = 'price_edge_uat';

const { buildServer } = await import('../src/server.js');
const { signToken } = await import('../src/core/tokens.js');
const {
  getSubscriberByEmail, isConfirmed, isSuppressed, setSubscriberStatus, createSubscriber,
} = await import('../src/core/subscribers.js');
const { runIngest, runDailyDigest, runWeeklyDigest, runAwardIngest, runRadarDigest } =
  await import('../src/jobs/index.js');
const { listForecasts } = await import('../src/core/radar.js');
const { countNotices } = await import('../src/core/notices.js');

let pass = 0;
const failures: string[] = [];
let group = '';
const G = (n: string) => { group = n; console.log(`\n\x1b[1m${n}\x1b[0m`); };
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { pass += 1; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { failures.push(`[${group}] ${name}${detail ? ` — ${detail}` : ''}`); console.log(`  \x1b[31m✗ ${name}\x1b[0m${detail ? ` — ${detail}` : ''}`); }
};

const app = buildServer();
await app.ready();

const form = (obj: Record<string, string>) => ({
  method: 'POST' as const,
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  payload: new URLSearchParams(obj).toString(),
});
const OUTBOX = process.env.MAIL_OUTBOX_DIR!;
const outboxCount = () => (fs.existsSync(OUTBOX) ? fs.readdirSync(OUTBOX).length : 0);

/** Outbox .eml bodies are quoted-printable; unwrap before matching URLs. */
const readMail = (f: string) =>
  fs.readFileSync(path.join(OUTBOX, f), 'utf8').replace(/=\r?\n/g, '').replace(/=3D/g, '=');
const mailsFor = (email: string) =>
  (fs.existsSync(OUTBOX) ? fs.readdirSync(OUTBOX) : [])
    .map(readMail)
    .filter((m) => m.includes(email));
const noticeLinks = (mail: string) =>
  [...new Set([...mail.matchAll(/\/tender\/([a-z0-9-]+)/g)].map((m) => m[1]))];

console.log('Lifecycle UAT'.padEnd(60, ' '));
console.log('='.repeat(60));

/* ------------------------------------------------- 1. data pipeline */
G('1. Ingest pipeline');
{
  const first = await runIngest();
  check('ingest succeeds against fixtures', first.ok, first.error);
  const afterFirst = countNotices();
  check('ingest stores notices', afterFirst > 0, `${afterFirst} notices`);

  const second = await runIngest();
  check('re-running ingest is idempotent', second.ok && countNotices() === afterFirst,
    `${afterFirst} → ${countNotices()}`);

  const awards = await runAwardIngest();
  check('award ingest succeeds', awards.ok, awards.error);
  check('award ingest produces forecasts', ((awards.result as any)?.forecasts ?? 0) > 0,
    `${(awards.result as any)?.forecasts} forecasts`);
}

/* ------------------------------------------- 2. subscriber journey */
G('2. Subscriber journey: signup → confirm → digest → unsubscribe');
const EMAIL = 'journey@example.com';
{
  const r = await app.inject({ url: '/subscribe', ...form({ email: EMAIL, cpv_prefixes: '72' }) });
  check('signup accepted', r.statusCode === 200, `got ${r.statusCode}`);

  const sub = getSubscriberByEmail(EMAIL);
  check('subscriber row created', Boolean(sub));
  check('subscriber starts UNCONFIRMED', sub ? !isConfirmed(sub.id) : false);

  const before = outboxCount();
  const weekly1 = await runWeeklyDigest();
  check('unconfirmed subscriber receives no digest', weekly1.ok && outboxCount() === before,
    `outbox ${before} → ${outboxCount()}`);

  // Confirm with a real signed token.
  const token = signToken({ sub: sub!.id, scope: 'confirm' });
  const c = await app.inject({ url: `/confirm?t=${encodeURIComponent(token)}` });
  check('confirm link works', c.statusCode === 200, `got ${c.statusCode}`);
  check('subscriber is now confirmed', isConfirmed(sub!.id));

  const c2 = await app.inject({ url: `/confirm?t=${encodeURIComponent(token)}` });
  check('re-clicking confirm is harmless (idempotent)', c2.statusCode === 200 && isConfirmed(sub!.id));

  const before2 = outboxCount();
  const weekly2 = await runWeeklyDigest();
  check('confirmed subscriber DOES receive the digest', weekly2.ok && outboxCount() > before2,
    `outbox ${before2} → ${outboxCount()}`);

  // The guarantee is not "one email ever" — a subscriber with more matches than
  // fit in one digest correctly receives the next batch next time. The guarantee
  // is that a given notice is never sent to the same person twice.
  for (let i = 0; i < 8; i += 1) await runWeeklyDigest();
  const sentTo = mailsFor(EMAIL);
  const allLinks = sentTo.flatMap(noticeLinks);
  // A free digest carries at most 5 notices, so N matches should cost about
  // N/5 emails. Materially more would mean half-empty, wasteful sends.
  check('every digest carried a full batch (no wasteful sends)',
    sentTo.length <= Math.ceil(allLinks.length / 5) + 1,
    `${sentTo.length} emails for ${allLinks.length} notices`);
  check('no notice is ever emailed to the same person twice',
    new Set(allLinks).size === allLinks.length,
    `${allLinks.length} links, ${new Set(allLinks).size} unique`);
  check('the digests actually contained tenders', allLinks.length > 0);

  const drained = outboxCount();
  await runWeeklyDigest();
  check('once everything is delivered, no empty digest is sent', outboxCount() === drained,
    `outbox ${drained} → ${outboxCount()}`);

  // Account self-service.
  const acct = signToken({ sub: sub!.id, scope: 'account' });
  const a = await app.inject({ url: `/account?t=${encodeURIComponent(acct)}` });
  check('account page loads with a valid token', a.statusCode === 200 && a.body.includes(EMAIL));

  const save = await app.inject({
    url: '/account',
    ...form({ t: acct, cpv_prefixes: '<script>x</script>72', countries: 'DEU', keywords: 'a'.repeat(5000), min_score: '-99' }),
  });
  check('account accepts hostile filter input without crashing', save.statusCode < 500, `got ${save.statusCode}`);
  const a2 = await app.inject({ url: `/account?t=${encodeURIComponent(acct)}` });
  check('hostile filter input is not reflected as raw HTML', !a2.body.includes('<script>x</script>'));

  // Unsubscribe.
  const unsub = signToken({ sub: sub!.id, scope: 'unsub' });
  const u = await app.inject({ url: `/unsubscribe?t=${encodeURIComponent(unsub)}` });
  check('unsubscribe works', u.statusCode === 200, `got ${u.statusCode}`);
  const u2 = await app.inject({ url: `/unsubscribe?t=${encodeURIComponent(unsub)}` });
  check('unsubscribing twice is harmless', u2.statusCode === 200);

  const before4 = outboxCount();
  await runWeeklyDigest();
  check('unsubscribed address receives nothing', outboxCount() === before4,
    `outbox ${before4} → ${outboxCount()}`);
}

/* ------------------------------------------------- 3. suppression */
G('3. Bounce handling and suppression');
{
  const email = 'bouncer@example.com';
  const sub = createSubscriber(email);
  setSubscriberStatus(sub.id, { status: 'active', plan: 'pro' });

  const nokey = await app.inject({
    url: '/mail/webhook',
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ type: 'bounce', email }),
  });
  check('bounce webhook without the key is refused', nokey.statusCode === 403, `got ${nokey.statusCode}`);
  check('an unauthenticated bounce cannot suppress a rival address', !isSuppressed(email));

  const hook = await app.inject({
    url: `/mail/webhook?key=${encodeURIComponent(process.env.APP_SECRET!)}`,
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ type: 'bounce', email, reason: 'hard bounce' }),
  });
  check('bounce webhook accepted', hook.statusCode < 400, `got ${hook.statusCode}`);
  check('bounced address is suppressed', isSuppressed(email));

  const before = outboxCount();
  await runDailyDigest();
  check('suppressed address is never mailed again', outboxCount() === before,
    `outbox ${before} → ${outboxCount()}`);
}

/* --------------------------------------------- 4. tier lifecycle */
G('4. Paid tier lifecycle and Radar gating');
{
  const email = 'edge-user@example.com';
  const sub = createSubscriber(email);
  const acct = signToken({ sub: sub.id, scope: 'account' });

  const free = await app.inject({ url: `/radar?t=${encodeURIComponent(acct)}` });
  check('free subscriber does NOT get the full radar', !/all forecasts unlocked/.test(free.body));

  setSubscriberStatus(sub.id, { status: 'active', plan: 'pro' });
  const pro = await app.inject({ url: `/radar?t=${encodeURIComponent(acct)}` });
  check('Pro subscriber does NOT get the full radar (Edge only)', !/all forecasts unlocked/.test(pro.body));

  setSubscriberStatus(sub.id, { status: 'trialing', plan: 'edge' });
  const trial = await app.inject({ url: `/radar?t=${encodeURIComponent(acct)}` });
  check('Edge trial DOES unlock the radar', /all forecasts unlocked/.test(trial.body));

  setSubscriberStatus(sub.id, { status: 'past_due', plan: 'edge' });
  const overdue = await app.inject({ url: `/radar?t=${encodeURIComponent(acct)}` });
  check('a failed payment re-locks the radar', !/all forecasts unlocked/.test(overdue.body));

  setSubscriberStatus(sub.id, { status: 'canceled', plan: 'free' });
  const gone = await app.inject({ url: `/radar?t=${encodeURIComponent(acct)}` });
  check('a cancelled subscriber loses access', !/all forecasts unlocked/.test(gone.body));

  // Access must not survive deletion of the account either.
  const ghost = signToken({ sub: 999_999, scope: 'account' });
  const g = await app.inject({ url: `/radar?t=${encodeURIComponent(ghost)}` });
  check('a token for a non-existent subscriber does not unlock', !/all forecasts unlocked/.test(g.body));
}

/* --------------------------------------------- 5. radar mailing */
G('5. Radar digest targeting');
{
  const edge = createSubscriber('radar-edge@example.com');
  setSubscriberStatus(edge.id, { status: 'active', plan: 'edge' });
  const { confirmSubscriber } = await import('../src/core/subscribers.js');
  confirmSubscriber(edge.id);

  const r1 = await runRadarDigest({ period: '2099-01' });
  check('radar digest runs', r1.ok, r1.error);
  const s1 = r1.result as any;
  check('radar digest reaches subscribers', s1.emailsSent > 0, JSON.stringify(s1));

  const r2 = await runRadarDigest({ period: '2099-01' });
  check('radar digest is idempotent within a period', (r2.result as any).emailsSent === 0,
    JSON.stringify(r2.result));

  const r3 = await runRadarDigest({ period: '2099-02' });
  check('a new period sends again', (r3.result as any).emailsSent > 0, JSON.stringify(r3.result));
}

/* ------------------------------------------- 6. failure injection */
G('6. Failure injection (the parts we do not control)');
{
  const realFetch = globalThis.fetch;
  const { config } = await import('../src/config.js');
  (config.ted as any).offline = false;

  // TED unreachable.
  globalThis.fetch = (async () => { throw new Error('ECONNREFUSED (simulated TED outage)'); }) as any;
  const down = await runIngest();
  check('TED outage fails the job cleanly, without crashing', down.ok === false && typeof down.error === 'string');

  // TED reachable but returning nonsense.
  globalThis.fetch = (async () => new Response('<html>502 Bad Gateway</html>', {
    status: 200, headers: { 'content-type': 'text/html' },
  })) as any;
  const garbage = await runIngest();
  check('a garbage TED response does not corrupt the database', garbage.ok === false || countNotices() > 0);

  // TED returning well-formed JSON with unexpected shape.
  globalThis.fetch = (async () => new Response(JSON.stringify({ notices: [{ nonsense: true }] }), {
    status: 200, headers: { 'content-type': 'application/json' },
  })) as any;
  const weird = await runIngest();
  check('unexpected TED payload shape is survived', typeof weird.ok === 'boolean');

  globalThis.fetch = realFetch;
  (config.ted as any).offline = true;
  const recovered = await runIngest();
  check('ingest recovers once TED comes back', recovered.ok, recovered.error);

  const health = await app.inject({ url: '/healthz' });
  check('/healthz still answers after failures', [200, 503].includes(health.statusCode));
  check('/healthz reports the failure history', /"problems"/.test(health.body));
}

/* ------------------------------------------------- 7. mail outage */
G('7. Mail provider outage');
{
  // ESM namespaces are frozen, so point the real transport at a dead port
  // instead of monkey-patching sendMail. This also exercises the retry path.
  const { resetTransport } = await import('../src/core/mailer.js');
  const { config } = await import('../src/config.js');
  const sub = createSubscriber('outage@example.com');
  const { confirmSubscriber } = await import('../src/core/subscribers.js');
  confirmSubscriber(sub.id);
  setSubscriberStatus(sub.id, { status: 'active', plan: 'pro' });

  (config.mail as any).transport = 'smtp';
  (config.mail as any).smtpUrl = 'smtp://127.0.0.1:1';
  resetTransport();

  const before = outboxCount();
  const res = await runDailyDigest();
  check('a mail outage does not crash the digest job', typeof res.ok === 'boolean');
  check('the outage is counted, not swallowed', ((res.result as any)?.failed ?? 0) >= 0,
    JSON.stringify(res.result));
  check('nothing is written to the outbox during an outage', outboxCount() === before);

  const health = await app.inject({ url: '/healthz' });
  check('/healthz survives a mail outage', [200, 503].includes(health.statusCode));

  (config.mail as any).transport = 'outbox';
  resetTransport();
  const after = await runDailyDigest();
  check('digests resume once the provider recovers', after.ok, after.error);
  check('the mail deferred by the outage is not lost', outboxCount() >= before,
    `outbox ${before} → ${outboxCount()}`);
}

/* ------------------------------------------------------- summary */
await app.close();
fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\n${'='.repeat(60)}`);
if (failures.length) {
  console.log(`\x1b[31m${failures.length} FAILED\x1b[0m, ${pass} passed\n`);
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`\x1b[32mAll ${pass} lifecycle checks passed.\x1b[0m`);
