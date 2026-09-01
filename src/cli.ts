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
import { runDailyDigest, runIngest, runWeeklyDigest } from './jobs/index.js';
import { fetchNotices, buildQuery, probeFields } from './ingest/ted.js';
import { patchEnvFile, runDoctor, setupStripe } from './core/provision.js';
import { sendConfirmationEmail, sendWelcomeEmail } from './core/emails.js';
import { recentNotices, upsertNotices, noticeStats } from './core/notices.js';
import { enrichPending } from './core/summarize.js';
import { matchNotices } from './core/match.js';
import {
  confirmSubscriber, createSubscriber, getProfile, getSubscriberByEmail, setSubscriberStatus,
  subscriberStats, updateProfile,
} from './core/subscribers.js';

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
        cadence: has('pro') ? 'daily' : 'weekly',
        min_score: Number.parseFloat(flag('min-score') ?? '0.35'),
      });
      confirmSubscriber(sub.id); // CLI-added subscribers are trusted, skip double opt-in
      if (has('pro')) setSubscriberStatus(sub.id, { status: 'active', plan: 'pro' });
      print('subscriber', { ...getSubscriberByEmail(email)!, profile: getProfile(sub.id) });
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
    case 'check-ted': {
      console.log('query:', buildQuery(config.ted.lookbackDays));
      const res = await fetchNotices({ lookbackDays: Number.parseInt(flag('days') ?? '2', 10) });
      console.log(`source=${res.source} pages=${res.pages} fetched=${res.notices.length} totalReported=${res.totalReported}`);
      for (const n of res.notices.slice(0, 5)) {
        console.log(`  [${n.id}] ${n.title.slice(0, 70)} | ${n.buyerCountry} | cpv=${n.cpv.slice(0, 3).join(',')} | deadline=${n.deadlineDate}`);
      }
      if (res.source === 'ted' && res.notices.length === 0) {
        console.warn('WARNING: TED returned zero notices — check field names / query syntax.');
        process.exitCode = 1;
      }
      break;
    }
    case 'doctor': {
      console.log('\nRunning preflight checks...\n');
      const results = await runDoctor();
      let fatals = 0;
      for (const r of results) {
        const icon = r.ok ? '\x1b[32m✓\x1b[0m' : r.fatal ? '\x1b[31m✗\x1b[0m' : '\x1b[33m!\x1b[0m';
        if (!r.ok && r.fatal) fatals += 1;
        console.log(`  ${icon} ${r.name.padEnd(18)} ${r.detail}`);
      }
      const warnings = results.filter((r) => !r.ok && !r.fatal).length;
      console.log(
        `\n${fatals ? `\x1b[31m${fatals} blocking issue(s)\x1b[0m` : '\x1b[32mNo blocking issues\x1b[0m'}` +
          `${warnings ? `, ${warnings} warning(s)` : ''}.\n`,
      );
      if (fatals) process.exitCode = 1;
      break;
    }
    case 'setup-stripe': {
      const amount = Number.parseInt(flag('amount') ?? '2900', 10);
      const currency = flag('currency') ?? 'eur';
      console.log(`Provisioning Stripe for ${config.baseUrl} ...`);
      const res = await setupStripe({ amountCents: amount, currency });
      console.log(`
  product         ${res.productId}${res.reused.includes('product') ? ' (existing)' : ' (created)'}
  price           ${res.priceId}${res.reused.includes('price') ? ' (existing)' : ' (created)'}
  webhook         ${res.webhookId}${res.reused.includes('webhook') ? ' (existing)' : ' (created)'}
  customer portal ${res.portalConfigured ? 'configured' : 'enable it once at dashboard.stripe.com/settings/billing/portal'}
`);
      const updates: Record<string, string> = { STRIPE_PRICE_ID: res.priceId };
      if (res.webhookSecret) updates.STRIPE_WEBHOOK_SECRET = res.webhookSecret;
      const patched = patchEnvFile(updates);
      if (patched) {
        console.log('  .env updated with STRIPE_PRICE_ID' + (res.webhookSecret ? ' and STRIPE_WEBHOOK_SECRET' : ''));
      } else {
        console.log('  Add these to your .env:');
        for (const [k, v] of Object.entries(updates)) console.log(`    ${k}=${v}`);
      }
      if (!res.webhookSecret && res.reused.includes('webhook')) {
        console.log('  Webhook already existed; copy its signing secret from the Stripe dashboard if not set.');
      }
      console.log('\n  Restart the app so the new values load.\n');
      break;
    }
    case 'probe-fields': {
      console.log('Probing which fields the live TED API accepts...');
      const res = await probeFields({ verbose: true });
      console.log(`\nworking (${res.working.length}): ${res.working.join(', ')}`);
      if (res.rejected.length) console.log(`rejected (${res.rejected.length}): ${res.rejected.join(', ')}`);
      console.log('Cached — ingest will use this set from now on.');
      break;
    }
    case 'test-email': {
      const email = argv[1];
      if (!email) throw new Error('usage: test-email <address>');
      const sub = createSubscriber(email, {}, { signupSource: 'cli-test' });
      await sendConfirmationEmail(sub.id, sub.email);
      await sendWelcomeEmail(sub.id, sub.email, { pro: false });
      console.log(
        config.mail.transport === 'outbox'
          ? 'Wrote confirmation + welcome emails to data/outbox/ (MAIL_TRANSPORT=outbox).'
          : `Sent confirmation + welcome emails to ${email}. Check inbox AND spam folder.`,
      );
      break;
    }
    default:
      console.log(`Commands:
  setup-stripe [--amount 2900] [--currency eur]   create product, price, webhook, portal
  doctor                                          preflight-check every dependency
  check-ted [--days N]                            live API smoke test
  probe-fields                                    discover which TED fields work
  ingest [--days N]                               pull notices into the DB
  digest-daily [--dry] / digest-weekly [--dry]    send digests
  seed                                            load offline fixtures
  add-subscriber <email> [--cpv 72,48] [--pro]    create a subscriber
  preview <email>                                 score matches without sending
  test-email <address>                            send yourself the lifecycle emails
  stats                                           counts and recent job runs`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
