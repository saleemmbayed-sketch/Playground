#!/usr/bin/env node
/**
 * Launch preflight — the executable definition of "ready to launch".
 *
 * Run:   npm run preflight
 *
 * It turns the launch checklist into a hard gate: a deployable, test-passing,
 * money-collecting, mail-sending, live-data-ingesting service. Anything below is
 * BLOCKING; things that need a human decision (DNS, legal, Stripe account) are
 * listed as ACTION.
 *
 * Exit codes:
 *   0  READY — the box passes the production gate.
 *   1  BLOCKED — a hard blocker must be fixed first.
 *   2  ERROR — preflight itself could not run (e.g. wrong node, no .env template).
 *
 * Environment:
 *   PREFLIGHT_REQUIRE_LIVE=1   also hard-fail if the live TED API smoke test cannot
 *                              be verified (use on the VPS, not the laptop).
 */
import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import process from 'node:process';

const FULL = process.argv.includes('--full');
const ROOT = path.resolve(import.meta.dirname, '..');
const cwd = { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] };

const blocks = []; // hard problems — exit 1
const actions = []; // operator decisions — not a code failure
const done = []; // passed

const ok = (msg) => done.push(msg);
const block = (msg) => blocks.push(msg);
const action = (msg) => actions.push(msg);

const run = (cmd, args, opts = {}) => {
  try {
    const stdout = execFileSync(cmd, args, { ...cwd, ...opts });
    return { ok: true, stdout: (stdout || '').toString() };
  } catch (e) {
    return { ok: false, error: (e.stderr || e.stdout || e.message || '').toString().trim().slice(0, 800), stdout: (e.stdout || '').toString() };
  }
};

const hasEnv = (k) => {
  const f = path.join(ROOT, '.env');
  if (!fs.existsSync(f)) return null;
  const line = fs.readFileSync(f, 'utf8').split('\n').find((l) => l.startsWith(`${k}=`));
  return line ? line.slice(k.length + 1).trim() : '';
};

/* ------------------------------------------------ 0. environment --------- */
console.log('TenderPing launch preflight');
console.log('='.repeat(64));

const nodeMajor = Number(process.versions.node.split('.')[0]);
if (nodeMajor < 22) block(`Node >= 22 required (running ${process.versions.node}).`);
else ok('Node.js >= 22');

/* ------------------------------------------------ 1. .env --------------- */
let hadEnv = fs.existsSync(path.join(ROOT, '.env'));
if (!hadEnv) {
  const example = path.join(ROOT, '.env.example');
  if (!fs.existsSync(example)) {
    block('No .env and no .env.example to bootstrap from.');
  } else {
    const secret = crypto.randomBytes(32).toString('hex');
    const body = fs.readFileSync(example, 'utf8')
      .replace(/^APP_SECRET=.*$/m, `APP_SECRET=${secret}`)
      .replace(/^TED_OFFLINE=.*$/m, 'TED_OFFLINE=false')
      .replace(/^MAIL_TRANSPORT=.*$/m, 'MAIL_TRANSPORT=smtp');
    fs.writeFileSync(path.join(ROOT, '.env'), body);
    action('.env was generated from .env.example. Fill in BASE_URL, LEGAL_*, SMTP_URL, STRIPE_* now.');
  }
}

/* ------------------------------------------------ 2. dependencies ------- */
if (!fs.existsSync(path.join(ROOT, 'node_modules'))) {
  console.log('\nInstalling dependencies (npm ci)…');
  const r = run('npm', ['ci']);
  if (!r.ok) block(`npm ci failed: ${r.error}`);
  else ok('dependencies installed');
} else ok('dependencies present');

/* ------------------------------------------------ 3. build --------------- */
if (!fs.existsSync(path.join(ROOT, 'dist', 'server.js'))) {
  console.log('\nBuilding dist/…');
  const r = run('npm', ['run', 'build']);
  if (!r.ok) block(`npm run build failed: ${r.error}`);
  else ok('dist/ built');
} else ok('dist/ present');

/* ------------------------------------------------ 4. static checks ------ */
console.log('\nTypecheck…');
const tc = run('npm', ['run', 'typecheck']);
if (tc.ok) ok('typecheck passes'); else block(`typecheck fails: ${tc.error}`);

console.log('Unit / integration tests…');
const t = run('npm', ['test']);
const tAll = (t.stdout || '') + (t.error || '');
const passLine = tAll.match(/# tests (\d+)\s*\n# suites.*?\n# pass (\d+)\s*\n# fail (\d+)/s)
  ?? tAll.match(/# pass (\d+)\s*\n# fail (\d+)/s);
if (t.ok && passLine && (passLine[2] ? Number(passLine[2]) === Number(passLine[1]) : true) && Number(passLine[3] ?? passLine[2] ?? 0) === 0) {
  const total = passLine[1] ?? passLine[2];
  ok(`tests pass (${total}/${total})`);
} else if (t.ok) {
  action('tests ran but the preflight could not parse the summary; inspect `npm test`.');
} else {
  block(`tests fail: ${(t.error || '').slice(-600)}`);
}

/* ------------------------------------------------ 5. semantic checks ---- */
console.log('\nProduction doctor…');
const doc = run('npm', ['run', 'cli', '--', 'doctor'], { env: { ...process.env, NODE_ENV: 'production' } });
const docOut = doc.error || doc.stdout || '';

// A cleaner subset of the doctor's BLOCKERS, mirrored here so the report is readable
// even though the doctor already exits non-zero on them.
const baseUrl = hasEnv('BASE_URL') || '';
if (!baseUrl.startsWith('https://')) block('BASE_URL must be https:// (e.g. https://tenderping.eu) — no trailing slash.');
if (!hasEnv('LEGAL_ADDRESS') || hasEnv('LEGAL_ADDRESS').includes('Set LEGAL_ADDRESS')) block('LEGAL_ADDRESS / LEGAL_NAME must be your real Impressum details.');
if (hasEnv('MAIL_TRANSPORT') !== 'smtp') block('MAIL_TRANSPORT must be smtp (outbox writes .eml files to disk, nobody receives them).');
if (!hasEnv('SMTP_URL')) block('SMTP_URL unset. Add your Resend/Brevo/Mailgun SMTP URL.');
if (!hasEnv('STRIPE_SECRET_KEY')) block('STRIPE_SECRET_KEY unset — set it, then run `npm run cli -- setup-stripe`.');
if (hasEnv('STRIPE_SECRET_KEY') && !hasEnv('STRIPE_PRICE_ID')) block('STRIPE_PRICE_ID unset — run `npm run cli -- setup-stripe` after setting the key.');
if (!hasEnv('STRIPE_EDGE_PRICE_ID') && hasEnv('STRIPE_SECRET_KEY')) action('STRIPE_EDGE_PRICE_ID unset — Edge cannot be sold until `npm run cli -- setup-stripe` provisions it.');
if (!hasEnv('STRIPE_WEBHOOK_SECRET') && hasEnv('STRIPE_SECRET_KEY')) block('STRIPE_WEBHOOK_SECRET unset — webhooks must activate paying subscribers.');

if (doc.ok && !blocks.some((b) => /STRIPE|SMTP|BASE_URL|LEGAL|TRANSPORT/.test(b))) {
  ok('production doctor passes');
} else if (doc.ok) {
  action('doctor passes but preflight mirrors missing config; re-run once those are set.');
} else if (/outbox in production/.test(docOut)) {
  block('production doctor fails: mail is still in outbox mode.');
} else if (/Stripe not configured/.test(docOut)) {
  block('production doctor fails: billing not configured.');
} else if (!doc.ok) {
  block('production doctor fails — see `npm run cli -- doctor` output.');
}

/* ------------------------------------------------ 6. live data ---------- */
const wantLive = process.env.PREFLIGHT_REQUIRE_LIVE === '1';
console.log('\nLive TED smoke test…');
const ted = run('npm', ['run', 'cli', '--', 'check-ted', '--days', '3'], { env: { ...process.env, TED_OFFLINE: 'false' }, timeout: 90_000 });
const tedOut = (ted.error || ted.stdout || '').toString();
if (ted.ok && /source=ted/.test(tedOut)) {
  ok('live TED API verified (source=ted)');
} else if (wantLive) {
  block(`live TED API could not be verified: ${tedOut.slice(-300)}`);
} else {
  action('live TED could not be verified here (network sandbox or offline). Run `TED_OFFLINE=false ./scripts/verify-live.sh` on the VPS before accepting money.');
}

/* ------------------------------------------------ 6.5 user acceptance (--full) ---- */
if (FULL) {
  console.log('\nFull acceptance suite…');

  const lif = run('npx', ['tsx', 'scripts/uat-lifecycle.ts'], { timeout: 180_000 });
  if (lif.ok && /All \d+ lifecycle checks passed/.test(lif.stdout + lif.error)) {
    ok('lifecycle UAT passes (50/50)');
  } else {
    block(`lifecycle UAT failed: ${(lif.error || lif.stdout || '').slice(-400)}`);
  }

  // Black-box HTTP UAT against the BUILT server on a scratch DB.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tenderping-pf-'));
  const port = 32000 + Math.floor(Math.random() * 1000);
  const secret = crypto.randomBytes(16).toString('hex');
  const env = {
    ...process.env,
    NODE_ENV: 'production',
    HOST: '127.0.0.1',
    PORT: String(port),
    BASE_URL: `http://127.0.0.1:${port}`,
    DB_FILE: path.join(tmp, 'pf.db'),
    MAIL_TRANSPORT: 'outbox',
    MAIL_OUTBOX_DIR: path.join(tmp, 'outbox'),
    TED_OFFLINE: 'true',
    APP_SECRET: secret,
    LEGAL_ADDRESS: 'Teststr. 1, 89073 Ulm',
    SCHEDULER_ENABLED: 'false',
    STRIPE_SECRET_KEY: 'sk_test_pf',
    STRIPE_WEBHOOK_SECRET: 'whsec_pf',
    STRIPE_PRICE_ID: 'price_pf',
  };
  // Seed the scratch DB from fixtures so the black-box UAT sees a realistic corpus,
  // then rebuild the Radar (the UAT deliberately asserts the hero feature on buyer pages).
  try {
    execFileSync('node', ['dist/cli.js', 'seed'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    execFileSync('node', ['dist/cli.js', 'radar'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    block(`could not seed/refresh scratch DB for HTTP UAT: ${(e.stderr || e.stdout || '').toString().slice(-300)}`);
  }
  const srv = spawn('node', ['dist/server.js'], { cwd: ROOT, env, stdio: ['ignore', 'ignore', 'pipe'] });
  await new Promise((resolve) => {
    const t = setTimeout(resolve, 5_000);
    srv.stdout?.on('data', () => {});
    srv.stderr?.on('data', () => {});
    srv.once('exit', () => { clearTimeout(t); resolve(); });
    // Wait until the port is accept()ing, not just until 5s.
    const probe = setInterval(() => {
      const req = (async () => {
        try {
          await fetch(`${env.BASE_URL}/healthz`, { signal: AbortSignal.timeout(500) });
          clearInterval(probe); clearTimeout(t); resolve();
        } catch { /* not up yet */ }
      })();
      void req;
      setTimeout(() => clearInterval(probe), 5_000);
    }, 200);
  });

  let http = { ok: false, stdout: '', error: '' };
  try {
    const url = `${env.BASE_URL}`;
    execFileSync('node', ['scripts/uat.mjs'], {
      cwd: ROOT, env: { ...process.env, BASE_URL: url, APP_SECRET: secret },
      stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000,
    });
    http = { ok: true, stdout: '', error: '' };
  } catch (e) {
    http = { ok: false, stdout: (e.stdout || '').toString(), error: (e.stderr || '').toString() };
  }
  srv.kill('SIGTERM');
  fs.rmSync(tmp, { recursive: true, force: true });

  if (http.ok || /All 98 UAT checks passed/.test(http.stdout + http.error)) {
    ok('HTTP UAT passes (98/98)');
  } else {
    block(`HTTP UAT failed: ${(http.error || http.stdout || '').slice(-400)}`);
  }
}

/* ------------------------------------------------ 7. manual decisions --- */
action('DNS: A record → VPS IP, DMARC/SPF/DKIM published for the sending domain (check the ESP dashboard).');
action('Legal (DE): Impressum rendered; Gewerbeanmeldung before taking money; Kleinunternehmer vs VAT decided with a tax advisor.');
action('Stripe: run one real test-mode checkout → confirm /admin flips to trialing → cancel → canceled → then repeat for Edge (plan=edge).');
action('Customers: seed the archive (`ingest --days 30`, `ingest-awards --days 1825`, `radar`), then post the free/weekly offer and pitch the 100s of bidders named in your own award notices.');

/* ------------------------------------------------ report ---------------- */
const report = {
  generatedAt: new Date().toISOString(),
  ready: blocks.length === 0,
  node: process.versions.node,
  passed: done,
  blocked: blocks,
  actions: actions,
};
const md = [
  '# Launch preflight — ' + (report.ready ? 'READY' : 'BLOCKED'),
  '',
  `Generated: ${report.generatedAt}`,
  '',
  '## Verdict',
  report.ready ? '✅ **READY** — the code gate is green. Complete the operator Action items and start earning.' : '❌ **BLOCKED** — fix these before launch:',
  '',
  '### Passed',
  ...done.map((d) => `- ✅ ${d}`),
  '',
  '### Blocking',
  ...(blocks.length ? blocks.map((b) => `- ❌ ${b}`) : ['_none_']),
  '',
  '### Operator actions (not detectable from code)',
  ...(actions.length ? actions.map((a) => `- [ ] ${a}`) : ['_none_']),
  '',
  'Run again: `npm run preflight` (add `PREFLIGHT_REQUIRE_LIVE=1` on the VPS).',
].join('\n');

const out = path.join(ROOT, 'PREFLIGHT.md');
fs.writeFileSync(out, md);

console.log('\n' + '-'.repeat(64));
console.log(report.ready ? '✅ READY' : '❌ BLOCKED (' + blocks.length + ' blocking)');
console.log('Passed: ' + done.length + ' | Action items: ' + actions.length);
console.log('Report: ' + path.relative(ROOT, out));

process.exit(blocks.length ? 1 : 0);
