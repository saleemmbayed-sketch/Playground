import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { db, kvGet, kvSet, logEvent, withJobRun } from '../core/db.js';
import { fetchAwards, fetchNotices } from '../ingest/ted.js';
import { recentNotices, upsertNotices } from '../core/notices.js';
import { enrichPending } from '../core/summarize.js';
import { matchNotices, type Profile } from '../core/match.js';
import {
  alreadyDelivered, freeSubscribers, payingSubscribers, recordDeliveries,
} from '../core/subscribers.js';
import { accountUrl, unsubscribeUrl } from '../core/tokens.js';
import { resetSendCounter, sendMail } from '../core/mailer.js';
import {
  alertEmail, digestHtml, digestSubject, digestText, radarHtml, radarSubject, radarText,
} from '../core/templates.js';
import { listForecasts, refreshRadar } from '../core/radar.js';
import { hasRadarAccess } from '../core/billing.js';

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
  /** Real send failures (provider outage, refused recipient) — alert on this. */
  failed: number;
  /** Expected skips: suppressed addresses or the per-run send cap. */
  skipped: number;
}

/**
 * Sends to one subscriber without ever letting their failure abort the run.
 *
 * A single bad address, a provider hiccup or a per-recipient rejection must not cost
 * every remaining subscriber their digest — that is the difference between "a customer
 * complains" and "nobody got anything today and I found out a week later".
 */
async function sendDigestSafely(
  sub: { id: number; email: string },
  profile: Profile,
  pool: ReturnType<typeof recentNotices>,
  opts: Parameters<typeof sendDigestTo>[3],
  stats: DigestStats,
): Promise<void> {
  try {
    const r = await sendDigestTo(sub, profile, pool, opts);
    if (r.sent) {
      stats.emailsSent += 1;
      stats.matchesSent += r.matches;
    } else if (r.failure?.kind === 'error') {
      stats.failed += 1;
      logEvent('digest.recipient.failed', {
        subscriberId: sub.id, email: sub.email, error: r.failure.detail,
      });
      console.error(`[digest] recipient ${sub.email} failed: ${r.failure.detail}`);
    } else if (r.failure) {
      stats.skipped += 1;
    } else {
      stats.skippedEmpty += 1;
    }
  } catch (err) {
    stats.failed += 1;
    const message = err instanceof Error ? err.message : String(err);
    logEvent('digest.recipient.failed', { subscriberId: sub.id, email: sub.email, error: message });
    console.error(`[digest] recipient ${sub.email} failed: ${message}`);
  }
}

async function sendDigestTo(
  sub: { id: number; email: string },
  profile: Profile,
  pool: ReturnType<typeof recentNotices>,
  opts: { limit: number; upsell: boolean; intro: string; period: string; skipIfEmpty: boolean },
): Promise<{ sent: boolean; matches: number; failure?: { kind: string; detail: string } }> {
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
  if (!res.ok) {
    // A provider outage must be visible as a failure, not hidden as a quiet day.
    return { sent: false, matches: 0, failure: { kind: res.kind, detail: res.skipped } };
  }

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
      candidates: pool.length, recipients: subs.length, emailsSent: 0, matchesSent: 0, skippedEmpty: 0, failed: 0, skipped: 0,
    };

    for (const s of subs) {
      if (opts.dryRun) continue;
      await sendDigestSafely(s, s.profile, pool, {
        limit: 40,
        upsell: false,
        intro: 'New tenders matching your profile',
        period: 'today',
        skipIfEmpty: true,
      }, stats);
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
      candidates: pool.length, recipients: subs.length, emailsSent: 0, matchesSent: 0, skippedEmpty: 0, failed: 0, skipped: 0,
    };

    for (const s of subs) {
      if (opts.dryRun) continue;
      const isPaid = s.status === 'active' || s.status === 'trialing';
      await sendDigestSafely(s, s.profile, pool, {
        limit: isPaid ? 40 : 5,
        upsell: !isPaid,
        intro: isPaid ? 'Your weekly tender round-up' : 'This week in EU public IT tenders',
        period: 'this week',
        skipIfEmpty: isPaid,
      }, stats);
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
    // Awards move slowly: refresh the radar and mail it once a month.
    const dayOfMonth = now.getUTCDate();
    if (due('awards', 2, dayOfMonth === 1)) await runAwardIngest();
    if (due('radar', config.jobs.digestHourUtc, dayOfMonth === 1)) await runRadarDigest();
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

/* ------------------------------------------------------ Re-tender Radar --- */

/**
 * Pulls historical contract award notices and rebuilds the forecast table.
 *
 * This is the input to the hero feature. Awards change slowly, so this runs
 * monthly rather than daily — one TED pass per month is well inside fair use.
 */
export async function runAwardIngest(opts: { lookbackDays?: number } = {}) {
  return guarded('ingest.awards', async () => {
    const fetched = await fetchAwards({ lookbackDays: opts.lookbackDays });
    const { inserted, updated } = upsertNotices(fetched.notices);
    const radar = refreshRadar();
    logEvent('ingest.awards.done', { inserted, updated, ...radar });
    return {
      fetched: fetched.notices.length,
      inserted,
      updated,
      source: fetched.source,
      strategy: fetched.strategy,
      forecasts: radar.forecasts,
    };
  });
}

/** Recomputes forecasts from awards already stored. Cheap, no network. */
export async function runRadarRefresh() {
  return guarded('radar.refresh', async () => refreshRadar());
}

/**
 * Monthly Re-tender Radar email.
 *
 * Edge subscribers get every forecast in their sectors. Everyone else gets a
 * single teaser row plus a locked count — the forecast itself is the upsell,
 * because no competitor can show it to them.
 */
export async function runRadarDigest(opts: { dryRun?: boolean; period?: string } = {}) {
  return guarded('radar.digest', async () => {
    resetSendCounter();
    // One radar email per subscriber per month, enforced in the database.
    //
    // The scheduler's in-memory "already ran today" set does not survive a
    // restart, and /ops/radar-digest can be triggered by hand at any time. The
    // daily digest is protected by the deliveries ledger; this job had nothing,
    // so a redeploy on the 1st would have re-mailed the entire list. Repeated
    // unsolicited sends are the fastest way to lose a sending domain.
    const period = opts.period ?? new Date().toISOString().slice(0, 7);
    const subs = [...payingSubscribers(), ...freeSubscribers()];
    const stats = {
      recipients: subs.length, emailsSent: 0, forecastsSent: 0, teasers: 0,
      failed: 0, skippedEmpty: 0, skippedAlreadySent: 0,
    };

    for (const s of subs) {
      if (opts.dryRun) continue;
      const sentKey = `radar:sent:${period}:${s.id}`;
      if (kvGet(sentKey)) {
        stats.skippedAlreadySent += 1;
        continue;
      }
      const full = hasRadarAccess(s);
      const all = listForecasts({
        cpvPrefixes: s.profile.cpv_prefixes ? s.profile.cpv_prefixes.split(',') : undefined,
        countries: s.profile.countries ? s.profile.countries.split(',').filter(Boolean) : undefined,
        minConfidence: full ? 0.35 : 0.5,
        limit: full ? 40 : 6,
      });
      if (!all.length) {
        stats.skippedEmpty += 1;
        continue;
      }
      const shown = full ? all : all.slice(0, 1);
      const payload = {
        forecasts: shown,
        accountUrl: accountUrl(s.id),
        unsubscribeUrl: unsubscribeUrl(s.id),
        teaser: !full,
        lockedCount: full ? 0 : Math.max(0, all.length - shown.length),
      };
      try {
        const res = await sendMail({
          to: s.email,
          subject: radarSubject(shown),
          html: radarHtml(payload),
          text: radarText(payload),
          unsubscribeUrl: payload.unsubscribeUrl,
        });
        if (res.ok) {
          kvSet(sentKey, new Date().toISOString());
          stats.emailsSent += 1;
          stats.forecastsSent += shown.length;
          if (!full) stats.teasers += 1;
        }
      } catch (err) {
        stats.failed += 1;
        logEvent('radar.recipient.failed', {
          subscriberId: s.id, error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    logEvent('radar.digest.done', stats);
    return stats;
  });
}
