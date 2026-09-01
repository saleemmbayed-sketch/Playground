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
import { fetchNotices, buildQuery } from './ingest/ted.js';
import { recentNotices, upsertNotices, noticeStats } from './core/notices.js';
import { enrichPending } from './core/summarize.js';
import { matchNotices } from './core/match.js';
import {
  createSubscriber, getProfile, getSubscriberByEmail, setSubscriberStatus, subscriberStats, updateProfile,
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
      if (has('pro')) setSubscriberStatus(sub.id, { status: 'active', plan: 'pro' });
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
    default:
      console.log(`Commands: ingest | digest-daily | digest-weekly | seed | add-subscriber | preview | stats | check-ted`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
