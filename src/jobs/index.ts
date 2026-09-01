import { config } from '../config.js';
import { logEvent, withJobRun } from '../core/db.js';
import { fetchNotices } from '../ingest/ted.js';
import { recentNotices, upsertNotices } from '../core/notices.js';
import { enrichPending } from '../core/summarize.js';
import { matchNotices, type Profile } from '../core/match.js';
import {
  alreadyDelivered, freeSubscribers, payingSubscribers, recordDeliveries,
} from '../core/subscribers.js';
import { accountUrl, unsubscribeUrl } from '../core/tokens.js';
import { resetSendCounter, sendMail } from '../core/mailer.js';
import { digestHtml, digestSubject, digestText } from '../core/templates.js';

const daysAgoIso = (days: number): string => new Date(Date.now() - days * 86_400_000).toISOString();

/** Pull the latest TED notices, store them, and write summaries. */
export async function runIngest(opts: { lookbackDays?: number; dryRun?: boolean } = {}) {
  return withJobRun('ingest', async () => {
    const fetched = await fetchNotices({ lookbackDays: opts.lookbackDays });
    const { inserted, updated } = upsertNotices(fetched.notices);
    const enriched = await enrichPending(Math.min(300, inserted + 25));
    const stats = {
      source: fetched.source,
      query: fetched.query,
      degradedFields: fetched.degraded,
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
  return withJobRun('digest.daily', async () => {
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
  return withJobRun('digest.weekly', async () => {
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
    if (ran.size > 40) ran.clear();
  };

  void tick();
  setInterval(() => void tick().catch((e) => console.error('[scheduler]', e)), 10 * 60 * 1000);
  console.log(
    `[scheduler] on — ingest ${config.jobs.ingestHourUtc}:00 UTC, digest ${config.jobs.digestHourUtc}:00 UTC, weekly on day ${config.jobs.weeklyDigestDay}`,
  );
}
