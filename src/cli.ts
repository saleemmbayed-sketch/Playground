#!/usr/bin/env node
/**
 * Operator CLI.
 *   npm run cli -- ingest [--days 3]
 *   npm run cli -- digest-daily [--dry]
 *   npm run cli -- digest-weekly [--dry]
 *   npm run cli -- seed                 (load fixtures into the DB)
 *   npm run cli -- add-subscriber you@x.com --cpv 72,48 --countries DEU --pro
 *   npm run cli -- preview you@x.com    (score today's pool for one subscriber, no email)
 *   npm run cli -- stats
 *   npm run cli -- check-ted            (live API smoke test)
 */
import { config } from './config.js';
import { db } from './core/db.js';
import {
  runAwardIngest, runBackup, runDailyDigest, runIngest, runPrune, runRadarDigest,
  runRadarRefresh, runWeeklyDigest,
} from './jobs/index.js';
import { fetchNotices, queryStrategies } from './ingest/ted.js';
import { recentNotices, upsertNotices, noticeStats } from './core/notices.js';
import { enrichPending } from './core/summarize.js';
import { matchNotices } from './core/match.js';
import {
  confirmSubscriber, createSubscriber, getProfile, getSubscriberByEmail, setSubscriberStatus,
  subscriberStats, suppress, updateProfile,
} from './core/subscribers.js';
import { verifyMailConfig } from './core/mailer.js';
import { stripeEnabled } from './core/billing.js';
import { patchEnvFile, setupStripe } from './core/provision.js';

const argv = process.argv.slice(2);
const cmd = argv[0] ?? 'help';
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const has = (name: string): boolean => argv.includes(`--${name}`);

const print = (label: string, value: unknown) => console.log(`${label}:`, JSON.stringify(value, null, 2));

async function main(): Promise<void> {
  switch (cmd) {
    case 'ingest': {
      const days = Number.parseInt(flag('days') ?? '', 10);
      print('ingest', await runIngest(Number.isFinite(days) ? { lookbackDays: days } : {}));
      break;
    }
    case 'ingest-awards': {
      const days = Number.parseInt(flag('days') ?? '', 10);
      print('ingest-awards', await runAwardIngest(Number.isFinite(days) ? { lookbackDays: days } : {}));
      break;
    }
    case 'radar':
      print('radar', await runRadarRefresh());
      break;
    case 'radar-digest':
      // --period 2026-09 re-sends for a specific month; otherwise once per month.
      print('radar-digest', await runRadarDigest({ dryRun: has('dry'), period: flag('period') }));
      break;
    case 'digest-daily':
      print('digest-daily', await runDailyDigest({ dryRun: has('dry') }));
      break;
    case 'digest-weekly':
      print('digest-weekly', await runWeeklyDigest({ dryRun: has('dry') }));
      break;
    case 'seed': {
      process.env.TED_OFFLINE = 'true';
      (config.ted as any).offline = true;
      const fetched = await fetchNotices();
      const res = upsertNotices(fetched.notices);
      const enriched = await enrichPending(500);
      print('seed', { ...res, ...enriched, source: fetched.source });
      break;
    }
    case 'add-subscriber': {
      const email = argv[1];
      if (!email) throw new Error('usage: add-subscriber <email>');
      const sub = createSubscriber(email);
      updateProfile(sub.id, {
        cpv_prefixes: flag('cpv') ?? '72,48',
        countries: flag('countries') ?? '',
        keywords: flag('keywords') ?? '',
        exclude_words: flag('exclude') ?? '',
        cadence: has('pro') || has('edge') ? 'daily' : 'weekly',
        min_score: Number.parseFloat(flag('min-score') ?? '0.35'),
      });
      if (has('pro') || has('edge')) {
        setSubscriberStatus(sub.id, { status: 'active', plan: has('edge') ? 'edge' : 'pro' });
      }
      if (has('pro') || has('edge') || has('confirm')) confirmSubscriber(sub.id);
      print('subscriber', { ...sub, profile: getProfile(sub.id) });
      break;
    }
    case 'preview': {
      const email = argv[1];
      if (!email) throw new Error('usage: preview <email>');
      const sub = getSubscriberByEmail(email);
      if (!sub) throw new Error('no such subscriber');
      const profile = getProfile(sub.id)!;
      const pool = recentNotices(new Date(Date.now() - 14 * 86_400_000).toISOString());
      const matches = matchNotices(pool, profile, { limit: 20 });
      console.log(`pool=${pool.length} matches=${matches.length}`);
      for (const m of matches) {
        console.log(`  ${(m.score * 100).toFixed(0)}%  ${m.notice.title.slice(0, 78)}`);
        console.log(`         ${m.reasons.join(' · ')}`);
      }
      break;
    }
    case 'stats':
      print('stats', {
        notices: noticeStats(),
        subscribers: subscriberStats(),
        jobs: db().prepare('SELECT job, started_at, ok, stats FROM job_runs ORDER BY id DESC LIMIT 5').all(),
      });
      break;
    case 'confirm': {
      const email = argv[1];
      const sub = email ? getSubscriberByEmail(email) : null;
      if (!sub) throw new Error('usage: confirm <email> (subscriber must exist)');
      confirmSubscriber(sub.id);
      print('confirmed', { id: sub.id, email: sub.email });
      break;
    }
    case 'suppress': {
      const email = argv[1];
      if (!email) throw new Error('usage: suppress <email> [--reason manual]');
      suppress(email, flag('reason') ?? 'manual');
      print('suppressed', { email });
      break;
    }
    case 'backup':
      print('backup', await runBackup(Number.parseInt(flag('keep') ?? '14', 10)));
      break;
    case 'prune':
      print('prune', await runPrune(Number.parseInt(flag('retain-days') ?? '400', 10)));
      break;
    case 'setup-stripe': {
      const amount = Number.parseInt(flag('amount') ?? '2900', 10);
      const edgeAmount = Number.parseInt(flag('edge-amount') ?? '7900', 10);
      const currency = flag('currency') ?? 'eur';
      console.log(`Provisioning Stripe for ${config.baseUrl} ...`);
      const res = await setupStripe({ amountCents: amount, edgeAmountCents: edgeAmount, currency });
      console.log(`
  product (Pro)   ${res.productId}
  price   (Pro)   ${res.priceId}
  product (Edge)  ${res.edgeProductId}
  price   (Edge)  ${res.edgePriceId}
  webhook         ${res.webhookId}${res.reused.includes('webhook') ? ' (existing)' : ' (created)'}
  customer portal ${res.portalConfigured ? 'configured' : 'enable it once at dashboard.stripe.com/settings/billing/portal'}
`);
      const updates: Record<string, string> = { STRIPE_PRICE_ID: res.priceId };
      if (res.edgePriceId) updates.STRIPE_EDGE_PRICE_ID = res.edgePriceId;
      if (res.webhookSecret) updates.STRIPE_WEBHOOK_SECRET = res.webhookSecret;
      if (patchEnvFile(updates)) {
        console.log(`  .env updated with ${Object.keys(updates).join(' and ')}`);
      } else {
        console.log('  Add these to your .env:');
        for (const [k, v] of Object.entries(updates)) console.log(`    ${k}=${v}`);
      }
      if (!res.webhookSecret && res.reused.includes('webhook')) {
        console.log('  Webhook already existed — copy its signing secret from the Stripe dashboard if not set.');
      }
      console.log('\n  Restart the app so the new values load, then run: npm run cli -- doctor\n');
      break;
    }
    case 'doctor': {
      // Pre-launch readiness check: fails loudly on anything that would break in production.
      // "Ready to launch" has a hard meaning: real mail can go out, real money can
      // come in, real data is being ingested. Any of those being false in production
      // is a BLOCKER, never a warning — otherwise an operator ships a demo.
      const problems: string[] = [];
      const warn: string[] = [];
      const prod = config.env === 'production';
      if (config.security.secret === 'dev-insecure-secret-change-me') problems.push('APP_SECRET is still the insecure default');
      if (!config.baseUrl.startsWith('https://') && prod) problems.push('BASE_URL must be https in production');
      if (config.mail.transport === 'outbox') {
        if (prod) problems.push('MAIL_TRANSPORT=outbox in production — emails are written to files, nobody receives them. Set MAIL_TRANSPORT=smtp and SMTP_URL.');
        else warn.push('MAIL_TRANSPORT=outbox — no real email will be sent');
      }
      const mail = await verifyMailConfig();
      if (!mail.ok) problems.push(`SMTP not usable: ${mail.detail}`);
      if (!stripeEnabled()) {
        if (prod) problems.push('Stripe not configured — nobody can pay. Set STRIPE_SECRET_KEY + STRIPE_PRICE_ID (+ STRIPE_EDGE_PRICE_ID for Edge).');
        else warn.push('Stripe not configured — nobody can pay yet');
      }
      if (!config.stripe.webhookSecret && stripeEnabled()) problems.push('STRIPE_WEBHOOK_SECRET missing — subscription status will never update');
      if (config.ted.offline) {
        if (prod) problems.push('TED_OFFLINE=true in production — ingesting demo fixtures, not real notices. Set TED_OFFLINE=false.');
        else warn.push('TED_OFFLINE=true — running on fixtures, not live data');
      }
      if (config.brand.legalAddress.includes('Set LEGAL_ADDRESS')) problems.push('LEGAL_ADDRESS not set (required for a German Impressum)');
      if (noticeStats().total === 0) warn.push('no notices indexed yet — run: cli ingest --days 14');
      console.log('\nREADINESS CHECK');
      console.log(`  mail: ${mail.detail}`);
      for (const w of warn) console.log(`  WARN  ${w}`);
      for (const p2 of problems) console.log(`  FAIL  ${p2}`);
      console.log(problems.length ? `\n${problems.length} blocking issue(s).` : '\nNo blocking issues. Ready to launch.');
      process.exitCode = problems.length ? 1 : 0;
      break;
    }
    case 'check-ted': {
      console.log('query strategies (tried in order):');
      for (const st of queryStrategies()) console.log(`  [${st.name}] ${st.build(config.ted.lookbackDays)}`);
      const res = await fetchNotices({ lookbackDays: Number.parseInt(flag('days') ?? '2', 10) });
      console.log(`\nsource=${res.source} strategy=${res.strategy} fields=${res.fieldSet} pages=${res.pages} fetched=${res.notices.length} discarded=${res.discarded} totalReported=${res.totalReported}`);
      for (const n of res.notices.slice(0, 5)) {
        console.log(`  [${n.id}] ${n.title.slice(0, 70)} | ${n.buyerCountry} | cpv=${n.cpv.slice(0, 3).join(',')} | deadline=${n.deadlineDate}`);
      }
      if (res.source === 'ted' && res.notices.length === 0) {
        console.warn('WARNING: TED returned zero notices — check field names / query syntax.');
        process.exitCode = 1;
      }
      break;
    }
    default:
      console.log(
        'Commands:\n' +
        '  ingest [--days N]           pull notices from TED\n' +
        '  digest-daily [--dry]        send the paid daily digest\n' +
        '  digest-weekly [--dry]       send the free weekly digest\n' +
        '  seed                        load offline fixtures\n' +
        '  add-subscriber <email> [--cpv 72,48] [--countries DEU] [--keywords a,b] [--pro|--edge] [--confirm]\n' +
        '  confirm <email>             mark opt-in confirmed\n' +
        '  suppress <email>            never mail this address again\n' +
        '  preview <email>             score the current pool for one subscriber\n' +
        '  backup [--keep 14]          consistent SQLite snapshot\n' +
        '  prune [--retain-days 400]   drop stale notices/events\n' +
        '  stats                       counts + last job runs\n' +
        '  check-ted [--days N]        live API contract smoke test\n' +
        '  setup-stripe [--amount 2900] [--edge-amount 7900] [--currency eur]',
        '                              create both products, prices, webhook and portal in Stripe',
        '  radar                       recompute Re-tender Radar forecasts from award notices',
        '  ingest-awards               pull historical contract award notices (radar input)',
        '  doctor                      pre-launch readiness check',
      );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
