import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { db, logEvent, withJobRun } from '../core/db.js';
import { fetchNotices } from '../ingest/ted.js';
import { recentNotices, upsertNotices } from '../core/notices.js';
import { enrichPending } from '../core/summarize.js';
import { matchNotices, type Profile } from '../core/match.js';
import {
  alreadyDelivered, freeSubscribers, payingSubscribers, recordDeliveries,
} from '../core/subscribers.js';
import { accountUrl, unsubscribeUrl } from '../core/tokens.js';
import { resetSendCounter, sendMail } from '../core/mailer.js';
import { alertEmail, digestHtml, digestSubject, digestText } from '../core/templates.js';

const daysAgoIso = (days: number): string => new Date(Date.now() - days * 86_400_000).toISOString();

/**
 * Runs a job and, if it fails, emails the operator once per job per day.
 * This is what makes "autonomous" safe: silent breakage becomes a message in your inbox.
 */
async function guarded<T>(job: string, fn: () => Promise<T>) {
  const res = await withJobRun(job, fn);
  if (!res.ok && config.brand.replyTo) {
    const dayKey = `alerted:${job}:${new Date().toISOString().slice(0, 10)}`;
    const { kvGet, kvSet } = await import('../core/db.js');
    if (!kvGet(dayKey)) {
      kvSet(dayKey, '1');
      const mail = alertEmail(job, res.error ?? 'unknown error');
      await sendMail({ to: config.brand.replyTo, ...mail }).catch(() => undefined);
    }
  }
  return res;
}

/** Pull the latest TED notices, store them, and write summaries. */
export async function runIngest(opts: { lookbackDays?: number } = {}) {
  return guarded('ingest', async () => {
    const fetched = await fetchNotices({ lookbackDays: opts.lookbackDays });
    const { inserted, updated } = upsertNotices(fetched.notices);
    const enriched = await enrichPending(Math.min(300, inserted + 25));
    const stats = {
      source: fetched.source,
      strategy: fetched.strategy,
      fieldSet: fetched.fieldSet,
      discarded: fetched.discarded,
      fetched: fetched.notices.length,
      pages: fetched.pages,
      totalReported: fetched.totalReported,
      inserted,
      updated,
      enrichedLlm: enriched.llm,
      enrichedHeuristic: enriched.heuristic,
    };
    logEvent('ingest.done', stats);
    return stats;
  });
}

interface DigestStats {
  candidates: number;
  recipients: number;
  emailsSent: number;
  matchesSent: number;
  skippedEmpty: number;
}

async function sendDigestTo(
  sub: { id: number; email: string },
  profile: Profile,
  pool: ReturnType<typeof recentNotices>,
  opts: { limit: number; upsell: boolean; intro: string; period: string; skipIfEmpty: boolean },
): Promise<{ sent: boolean; matches: number }> {
  const scored = matchNotices(pool, profile);
  const seen = alreadyDelivered(sub.id, scored.map((s) => s.notice.id));
  const fresh = scored.filter((s) => !seen.has(s.notice.id));
  const items = fresh.slice(0, opts.limit);

  if (!items.length && opts.skipIfEmpty) return { sent: false, matches: 0 };

  const acct = accountUrl(sub.id);
  const unsub = unsubscribeUrl(sub.id);
  const payload = {
    items,
    accountUrl: acct,
    unsubscribeUrl: unsub,
    intro: opts.intro,
    upsell: opts.upsell,
    totalAvailable: Math.max(0, fresh.length - items.length),
  };

  const res = await sendMail({
    to: sub.email,
    subject: digestSubject(items, opts.period),
    html: digestHtml(payload),
    text: digestText(payload),
    unsubscribeUrl: unsub,
  });
  if (!res.ok) return { sent: false, matches: 0 };

  // Record *all* fresh matches as delivered for paid daily sends so nothing repeats;
  // for the capped free digest only the shown ones are burned.
  recordDeliveries(
    sub.id,
    (opts.upsell ? items : fresh).map((s) => ({ id: s.notice.id, score: s.score })),
  );
  return { sent: true, matches: items.length };
}

/** Daily paid digest: every fresh match, no cap on relevance, sent only when non-empty. */
export async function runDailyDigest(opts: { lookbackDays?: number; dryRun?: boolean } = {}) {
  return guarded('digest.daily', async () => {
    resetSendCounter();
    const pool = recentNotices(daysAgoIso(opts.lookbackDays ?? 3));
    const subs = payingSubscribers().filter((s) => s.profile.cadence !== 'weekly');
    const stats: DigestStats = {
      candidates: pool.length, recipients: subs.length, emailsSent: 0, matchesSent: 0, skippedEmpty: 0,
    };

    for (const s of subs) {
      if (opts.dryRun) continue;
      const r = await sendDigestTo(s, s.profile, pool, {
        limit: 40,
        upsell: false,
        intro: 'New tenders matching your profile',
        period: 'today',
        skipIfEmpty: true,
      });
      if (r.sent) {
        stats.emailsSent += 1;
        stats.matchesSent += r.matches;
      } else {
        stats.skippedEmpty += 1;
      }
    }
    logEvent('digest.daily.done', stats);
    return stats;
  });
}

/** Weekly free digest: top 5 matches + upsell. This is the acquisition engine. */
export async function runWeeklyDigest(opts: { dryRun?: boolean } = {}) {
  return guarded('digest.weekly', async () => {
    resetSendCounter();
    const pool = recentNotices(daysAgoIso(8));
    const subs = [
      ...freeSubscribers(),
      ...payingSubscribers().filter((s) => s.profile.cadence === 'weekly'),
    ];
    const stats: DigestStats = {
      candidates: pool.length, recipients: subs.length, emailsSent: 0, matchesSent: 0, skippedEmpty: 0,
    };

    for (const s of subs) {
      if (opts.dryRun) continue;
      const isPaid = s.status === 'active' || s.status === 'trialing';
      const r = await sendDigestTo(s, s.profile, pool, {
        limit: isPaid ? 40 : 5,
        upsell: !isPaid,
        intro: isPaid ? 'Your weekly tender round-up' : 'This week in EU public IT tenders',
        period: 'this week',
        skipIfEmpty: isPaid,
      });
      if (r.sent) {
        stats.emailsSent += 1;
        stats.matchesSent += r.matches;
      } else {
        stats.skippedEmpty += 1;
      }
    }
    logEvent('digest.weekly.done', stats);
    return stats;
  });
}

/** Minimal cron replacement: checks every 10 minutes whether a job is due today. */
export function startScheduler(): void {
  if (!config.jobs.enabled) {
    console.log('[scheduler] disabled (SCHEDULER_ENABLED=false)');
    return;
  }
  const ran = new Set<string>();
  const tick = async () => {
    const now = new Date();
    const day = now.toISOString().slice(0, 10);
    const hour = now.getUTCHours();

    const due = (name: string, atHour: number, extra = true): boolean => {
      const key = `${name}:${day}`;
      if (!extra || hour < atHour || ran.has(key)) return false;
      ran.add(key);
      return true;
    };

    if (due('ingest', config.jobs.ingestHourUtc)) await runIngest();
    if (due('daily', config.jobs.digestHourUtc)) await runDailyDigest();
    if (due('weekly', config.jobs.digestHourUtc, now.getUTCDay() === config.jobs.weeklyDigestDay)) {
      await runWeeklyDigest();
    }
    if (due('backup', config.jobs.digestHourUtc + 1)) await runBackup();
    if (due('prune', 3, now.getUTCDay() === 0)) await runPrune();
    if (ran.size > 40) ran.clear();
  };

  void tick();
  setInterval(() => void tick().catch((e) => console.error('[scheduler]', e)), 10 * 60 * 1000);
  console.log(
    `[scheduler] on — ingest ${config.jobs.ingestHourUtc}:00 UTC, digest ${config.jobs.digestHourUtc}:00 UTC, weekly on day ${config.jobs.weeklyDigestDay}`,
  );
}

/**
 * Nightly SQLite backup with rotation. `VACUUM INTO` produces a consistent copy while
 * the app keeps serving — no downtime, no lock contention.
 */
export async function runBackup(keep = 14) {
  return withJobRun('backup', async () => {
    const dir = path.resolve(path.dirname(config.db.file), 'backups');
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const target = path.join(dir, `tenderping-${stamp}.db`);
    db().exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);

    const files = fs
      .readdirSync(dir)
      .filter((f) => f.startsWith('tenderping-') && f.endsWith('.db'))
      .sort()
      .reverse();
    const removed: string[] = [];
    for (const f of files.slice(keep)) {
      fs.unlinkSync(path.join(dir, f));
      removed.push(f);
    }
    const stats = { file: target, sizeBytes: fs.statSync(target).size, kept: Math.min(files.length, keep), removed: removed.length };
    logEvent('backup.done', stats);
    return stats;
  });
}

/**
 * Keeps the database small and the archive fresh: drops notices whose deadline passed
 * long ago. Delivery rows cascade, so dedupe history for live notices is preserved.
 */
export async function runPrune(retainDays = 400) {
  return withJobRun('prune', async () => {
    const cutoff = new Date(Date.now() - retainDays * 86_400_000).toISOString().slice(0, 10);
    const before = (db().prepare('SELECT COUNT(*) c FROM notices').get() as any).c as number;
    db()
      .prepare(
        `DELETE FROM notices
         WHERE COALESCE(publication_date, substr(first_seen_at,1,10)) < ?
           AND (deadline_date IS NULL OR deadline_date < date('now','-60 day'))`,
      )
      .run(cutoff);
    db().prepare("DELETE FROM events WHERE created_at < date('now','-90 day')").run();
    db().prepare("DELETE FROM job_runs WHERE started_at < date('now','-90 day')").run();
    const after = (db().prepare('SELECT COUNT(*) c FROM notices').get() as any).c as number;
    const stats = { noticesBefore: Number(before), noticesAfter: Number(after), removed: Number(before) - Number(after) };
    logEvent('prune.done', stats);
    return stats;
  });
}
