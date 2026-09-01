/**
 * Deterministic relevance matching.
 *
 * Scoring is explainable on purpose: a subscriber can see *why* a tender matched,
 * which is the single biggest complaint about keyword-only alert services.
 * No LLM is required for matching (cost = 0, latency = 0, results reproducible).
 */
import type { NoticeRow } from './notices.js';

export interface Profile {
  subscriber_id: number;
  cpv_prefixes: string;
  countries: string;
  nuts_prefixes: string;
  keywords: string;
  exclude_words: string;
  min_value: number | null;
  max_value: number | null;
  min_score: number;
  cadence: string;
}

export interface MatchResult {
  matched: boolean;
  score: number;
  reasons: string[];
  rejectedBy?: string;
}

export const splitList = (s: string | null | undefined): string[] =>
  (s ?? '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);

const norm = (s: string): string => s.toLowerCase();

function haystack(n: NoticeRow): string {
  return norm([n.title, n.buyer_name ?? '', n.description ?? ''].join(' \n '));
}

function daysUntil(dateStr: string | null, from = new Date()): number | null {
  if (!dateStr) return null;
  const t = Date.parse(`${dateStr}T00:00:00Z`);
  if (!Number.isFinite(t)) return null;
  return Math.round((t - from.getTime()) / 86_400_000);
}

/**
 * Score in [0,1]:
 *   0.45  CPV family match (the strongest structural signal)
 *   0.20  keyword hits (saturating)
 *   0.15  geography match
 *   0.10  contract value inside the subscriber's sweet spot
 *   0.10  deadline still realistically biddable (>= 10 days out)
 */
export function scoreNotice(notice: NoticeRow, profile: Profile, now = new Date()): MatchResult {
  const reasons: string[] = [];
  const text = haystack(notice);

  // --- Hard filters -------------------------------------------------------
  const excludes = splitList(profile.exclude_words).map(norm);
  const hitExclude = excludes.find((w) => text.includes(w));
  if (hitExclude) {
    return { matched: false, score: 0, reasons: [], rejectedBy: `excluded term "${hitExclude}"` };
  }

  const cpvCodes = splitList(notice.cpv);
  const cpvPrefixes = splitList(profile.cpv_prefixes);
  const cpvHit = cpvPrefixes.find((p) => cpvCodes.some((c) => c.startsWith(p)));
  if (cpvPrefixes.length && !cpvHit) {
    return { matched: false, score: 0, reasons: [], rejectedBy: 'CPV outside profile' };
  }

  const countries = splitList(profile.countries).map((c) => c.toUpperCase());
  if (countries.length && notice.buyer_country && !countries.includes(notice.buyer_country.toUpperCase())) {
    return { matched: false, score: 0, reasons: [], rejectedBy: 'country outside profile' };
  }

  const nutsPrefixes = splitList(profile.nuts_prefixes).map((c) => c.toUpperCase());
  const noticeNuts = splitList(notice.place_nuts).map((c) => c.toUpperCase());
  if (nutsPrefixes.length && noticeNuts.length) {
    const nutsHit = nutsPrefixes.some((p) => noticeNuts.some((c) => c.startsWith(p)));
    if (!nutsHit) {
      return { matched: false, score: 0, reasons: [], rejectedBy: 'region outside profile' };
    }
  }

  const value = notice.value_amount;
  if (value != null) {
    if (profile.min_value != null && value < profile.min_value) {
      return { matched: false, score: 0, reasons: [], rejectedBy: 'below minimum value' };
    }
    if (profile.max_value != null && value > profile.max_value) {
      return { matched: false, score: 0, reasons: [], rejectedBy: 'above maximum value' };
    }
  }

  // --- Scoring ------------------------------------------------------------
  let score = 0;

  if (cpvHit) {
    const exact = cpvCodes.some((c) => c === cpvHit);
    score += exact ? 0.45 : 0.4;
    reasons.push(`CPV ${cpvCodes.find((c) => c.startsWith(cpvHit)) ?? cpvHit} matches your sectors`);
  } else if (!cpvPrefixes.length) {
    score += 0.25;
  }

  const keywords = splitList(profile.keywords).map(norm);
  if (keywords.length) {
    const hits = keywords.filter((k) => text.includes(k));
    if (hits.length) {
      score += Math.min(0.2, 0.09 * hits.length);
      reasons.push(`mentions ${hits.slice(0, 4).map((h) => `"${h}"`).join(', ')}`);
    }
  } else {
    score += 0.08;
  }

  if (countries.length && notice.buyer_country && countries.includes(notice.buyer_country.toUpperCase())) {
    score += 0.1;
    reasons.push(`buyer in ${notice.buyer_country}`);
  }
  if (nutsPrefixes.length && noticeNuts.some((c) => nutsPrefixes.some((p) => c.startsWith(p)))) {
    score += 0.05;
    reasons.push(`region ${noticeNuts[0]}`);
  }
  if (!countries.length && !nutsPrefixes.length) score += 0.07;

  if (value != null) {
    const inBand =
      (profile.min_value == null || value >= profile.min_value) &&
      (profile.max_value == null || value <= profile.max_value);
    if (inBand && (profile.min_value != null || profile.max_value != null)) {
      score += 0.1;
      reasons.push(`value ${Math.round(value).toLocaleString('en-GB')} ${notice.value_currency ?? ''} in range`);
    } else if (inBand) {
      score += 0.05;
    }
  }

  const dLeft = daysUntil(notice.deadline_date, now);
  if (dLeft != null) {
    if (dLeft >= 10) {
      score += 0.1;
      reasons.push(`${dLeft} days left to bid`);
    } else if (dLeft >= 0) {
      score += 0.03;
      reasons.push(`closing soon (${dLeft} days)`);
    } else {
      score -= 0.25;
      reasons.push('deadline already passed');
    }
  } else {
    score += 0.04;
  }

  score = Math.max(0, Math.min(1, Number(score.toFixed(4))));
  return { matched: score >= profile.min_score, score, reasons };
}

export interface ScoredNotice {
  notice: NoticeRow;
  score: number;
  reasons: string[];
}

export function matchNotices(
  notices: NoticeRow[],
  profile: Profile,
  opts: { limit?: number; now?: Date } = {},
): ScoredNotice[] {
  const out: ScoredNotice[] = [];
  for (const n of notices) {
    const r = scoreNotice(n, profile, opts.now);
    if (r.matched) out.push({ notice: n, score: r.score, reasons: r.reasons });
  }
  out.sort((a, b) => b.score - a.score);
  return opts.limit ? out.slice(0, opts.limit) : out;
}
