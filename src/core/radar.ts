/**
 * Re-tender Radar — forecasts public contracts BEFORE they are published.
 *
 * The insight: a contract award notice is a countdown timer. EU framework
 * agreements are capped at four years by Article 33(1) of Directive
 * 2014/24/EU ("shall not exceed four years, save in exceptional cases duly
 * justified"), and the clock starts at the award. Buyers must re-compete the
 * work when it expires, and the replacement competition is typically published
 * 6-12 months before that date.
 *
 * So: take every award notice a buyer has published, measure how often they
 * re-buy the same CPV family, and project the next competition. The output is
 * a named incumbent, a last contract value, a predicted publication window and
 * an explainable confidence score — months before the tender exists.
 *
 * Everything in this module is deterministic and unit-testable; nothing here
 * touches the network.
 */
import crypto from 'node:crypto';
import { config } from '../config.js';
import { db, nowIso } from './db.js';
import { slugify } from './slug.js';

export { slugify };

export interface AwardRecord {
  id: string;
  buyerName: string | null;
  buyerIdentifier: string | null;
  buyerCountry: string | null;
  cpvMain: string | null;
  awardDate: string | null;
  valueAmount: number | null;
  valueCurrency: string | null;
  winners: string;
}

export interface Forecast {
  id: string;
  buyerKey: string;
  buyerName: string;
  buyerSlug: string;
  buyerCountry: string | null;
  cpvFamily: string;
  lastAwardId: string | null;
  lastAwardDate: string;
  lastValueAmount: number | null;
  lastValueCurrency: string | null;
  incumbent: string | null;
  observations: number;
  cycleMonths: number;
  cycleSource: 'observed' | 'assumed';
  expiryDate: string;
  windowOpen: string;
  windowClose: string;
  confidence: number;
  reasons: string[];
  supersededBy?: string | null;
}

export type ForecastStatus = 'open' | 'upcoming' | 'overdue';

/* ------------------------------------------------------------------ dates */

export function addMonths(iso: string, months: number): string {
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + Math.round(months));
  // Clamp to the last valid day of the target month (31 Jan + 1 month = 28 Feb).
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastDay));
  return d.toISOString().slice(0, 10);
}

export function monthsBetween(a: string, b: string): number {
  const from = Date.parse(`${a.slice(0, 10)}T00:00:00Z`);
  const to = Date.parse(`${b.slice(0, 10)}T00:00:00Z`);
  return (to - from) / (1000 * 60 * 60 * 24 * 30.44);
}

export function daysBetween(a: string, b: string): number {
  const from = Date.parse(`${a.slice(0, 10)}T00:00:00Z`);
  const to = Date.parse(`${b.slice(0, 10)}T00:00:00Z`);
  return Math.round((to - from) / (1000 * 60 * 60 * 24));
}


function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
}

/** CPV family = the first two digits, e.g. 72267000 -> "72" (IT services). */
export function cpvFamily(cpv: string | null): string | null {
  const digits = (cpv ?? '').replace(/\D/g, '');
  return digits.length >= 2 ? digits.slice(0, 2) : null;
}

/* --------------------------------------------------------------- forecast */

/**
 * Builds a forecast from one buyer's award history within a single CPV family.
 * Awards need not be sorted. Returns null when there is nothing to project.
 */
export function forecastFromAwards(
  awards: AwardRecord[],
  opts: { today?: string } = {},
): Forecast | null {
  const today = (opts.today ?? nowIso()).slice(0, 10);
  const usable = awards
    .filter((a) => a.awardDate && cpvFamily(a.cpvMain))
    .sort((a, b) => (a.awardDate! < b.awardDate! ? -1 : 1));
  if (!usable.length) return null;

  const last = usable[usable.length - 1] as AwardRecord;
  const lastAwardDate = last.awardDate as string;
  const firstAwardDate = (usable[0] as AwardRecord).awardDate as string;
  const family = cpvFamily(last.cpvMain)!;
  const buyerName = (last.buyerName ?? '').trim() || 'Unnamed buyer';
  const buyerKey = (last.buyerIdentifier ?? '').trim() || slugify(buyerName);

  // Ignore small awards: they are noise, not pipeline.
  const biggest = Math.max(0, ...usable.map((a) => a.valueAmount ?? 0));
  if (biggest > 0 && biggest < config.radar.minValue) return null;

  // Observed cycle: median gap between this buyer's awards in this family.
  const gaps: number[] = [];
  for (let i = 1; i < usable.length; i += 1) {
    const gap = monthsBetween(
      (usable[i - 1] as AwardRecord).awardDate as string,
      (usable[i] as AwardRecord).awardDate as string,
    );
    // Ignore sub-year gaps: those are lots of the same procedure, not a re-tender.
    if (gap >= 9) gaps.push(gap);
  }

  const reasons: string[] = [];
  let cycleMonths: number;
  let cycleSource: 'observed' | 'assumed';

  if (gaps.length) {
    cycleMonths = Math.min(72, Math.max(12, median(gaps)));
    cycleSource = 'observed';
    reasons.push(
      `${buyerName} has re-tendered CPV ${family} ${gaps.length + 1} times since ` +
        `${firstAwardDate.slice(0, 7)}, on average every ${Math.round(cycleMonths)} months.`,
    );
  } else {
    cycleMonths = config.radar.defaultCycleMonths;
    cycleSource = 'assumed';
    reasons.push(
      `Only one award on record, so the forecast assumes the ${cycleMonths}-month legal ceiling ` +
        'for framework agreements (Art. 33(1), Directive 2014/24/EU).',
    );
  }

  const expiryDate = addMonths(lastAwardDate, cycleMonths);
  const windowOpen = addMonths(expiryDate, -config.radar.windowOpensMonthsBefore);
  const windowClose = addMonths(expiryDate, -config.radar.windowClosesMonthsBefore);

  reasons.push(
    `Last awarded ${lastAwardDate.slice(0, 10)}, so the incumbent contract is projected to ` +
      `expire around ${expiryDate}.`,
  );
  reasons.push(
    `Replacement competitions are normally published 6-12 months before expiry — expect this ` +
      `one between ${windowOpen} and ${windowClose}.`,
  );

  const incumbent = last.winners.trim() || null;
  if (incumbent) reasons.push(`Incumbent to displace: ${incumbent}.`);
  if (last.valueAmount) {
    reasons.push(
      `Last contract value: ${Math.round(last.valueAmount).toLocaleString('en-GB')} ` +
        `${last.valueCurrency ?? ''}`.trim() + '.',
    );
  }

  /* Confidence: how much we trust this projection. */
  let confidence = 0.3;
  if (cycleSource === 'observed') confidence += 0.25;
  confidence += Math.min(0.2, Math.max(0, usable.length - 2) * 0.1);
  if (gaps.length >= 2) {
    const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    const sd = Math.sqrt(gaps.reduce((a, b) => a + (b - mean) ** 2, 0) / gaps.length);
    if (mean > 0 && sd / mean < 0.25) {
      confidence += 0.15;
      reasons.push('The buyer re-tenders on a highly regular cycle.');
    }
  }
  if (incumbent) confidence += 0.05;
  if (last.valueAmount) confidence += 0.05;
  // A window that closed long ago means our model already missed it.
  const monthsPastClose = monthsBetween(windowClose, today);
  if (monthsPastClose > 6) {
    confidence -= 0.2;
    reasons.push('The predicted window has already passed — treat as overdue, verify directly.');
  }
  confidence = Math.max(0.05, Math.min(0.95, confidence));

  return {
    id: crypto.createHash('sha1').update(`${buyerKey}|${family}`).digest('hex').slice(0, 16),
    buyerKey,
    buyerName,
    buyerSlug: slugify(buyerName),
    buyerCountry: last.buyerCountry,
    cpvFamily: family,
    lastAwardId: last.id,
    lastAwardDate: lastAwardDate.slice(0, 10),
    lastValueAmount: last.valueAmount,
    lastValueCurrency: last.valueCurrency,
    incumbent,
    observations: usable.length,
    cycleMonths: Math.round(cycleMonths * 10) / 10,
    cycleSource,
    expiryDate,
    windowOpen,
    windowClose,
    confidence: Math.round(confidence * 100) / 100,
    reasons,
  };
}

export function forecastStatus(f: Forecast, today = nowIso().slice(0, 10)): ForecastStatus {
  if (today < f.windowOpen) return 'upcoming';
  if (today > f.windowClose) return 'overdue';
  return 'open';
}

export function daysUntilWindow(f: Forecast, today = nowIso().slice(0, 10)): number {
  return daysBetween(today, f.windowOpen);
}

/* ---------------------------------------------------------- persistence */

/** Groups every stored award notice by (buyer, CPV family) and forecasts each. */
export function computeForecasts(opts: { today?: string } = {}): Forecast[] {
  const rows = db()
    .prepare(
      `SELECT id, buyer_name, buyer_identifier, buyer_country, cpv_main,
              publication_date, value_amount, value_currency, winner_names
       FROM notices WHERE is_award = 1 AND publication_date IS NOT NULL
       ORDER BY publication_date ASC`,
    )
    .all() as any[];

  const groups = new Map<string, AwardRecord[]>();
  for (const r of rows) {
    const family = cpvFamily(r.cpv_main as string | null);
    if (!family) continue;
    const name = ((r.buyer_name as string) ?? '').trim();
    if (!name) continue;
    const key = `${((r.buyer_identifier as string) ?? '').trim() || slugify(name)}|${family}`;
    const rec: AwardRecord = {
      id: r.id,
      buyerName: name,
      buyerIdentifier: r.buyer_identifier ?? null,
      buyerCountry: r.buyer_country ?? null,
      cpvMain: r.cpv_main ?? null,
      awardDate: r.publication_date ?? null,
      valueAmount: r.value_amount ?? null,
      valueCurrency: r.value_currency ?? null,
      winners: (r.winner_names as string) ?? '',
    };
    const list = groups.get(key);
    if (list) list.push(rec);
    else groups.set(key, [rec]);
  }

  const out: Forecast[] = [];
  for (const awards of groups.values()) {
    const f = forecastFromAwards(awards, opts);
    if (f) out.push(f);
  }
  return out;
}

/**
 * A forecast is "superseded" once the predicted competition actually appears —
 * same buyer, same CPV family, published inside (or just before) the predicted
 * window. At that point the prediction has come true and the notice belongs in
 * the normal alert flow instead.
 *
 * The window check matters: buyers publish other contracts in the same sector
 * all the time, and counting any of them as the re-let would silently delete
 * every forecast. Only a notice published near the projected expiry is a
 * plausible replacement, so we allow a three-month grace before the window.
 */
export function findSupersedingNotice(f: Forecast): string | null {
  const earliest = addMonths(f.windowOpen, -3);
  const from = earliest > f.lastAwardDate ? earliest : f.lastAwardDate;
  const row = db()
    .prepare(
      `SELECT id FROM notices
       WHERE is_award = 0 AND buyer_name = ? AND cpv_main LIKE ?
         AND publication_date > ? AND publication_date <= ?
       ORDER BY publication_date DESC LIMIT 1`,
    )
    .get(f.buyerName, `${f.cpvFamily}%`, from, addMonths(f.expiryDate, 3)) as
      | { id: string }
      | undefined;
  return row?.id ?? null;
}

export function saveForecasts(forecasts: Forecast[]): number {
  const d = db();
  const stmt = d.prepare(`
    INSERT INTO forecasts (id, buyer_key, buyer_name, buyer_slug, buyer_country, cpv_family,
      last_award_id, last_award_date, last_value_amount, last_value_currency, incumbent,
      observations, cycle_months, cycle_source, expiry_date, window_open, window_close,
      confidence, reasons, superseded_by, computed_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET
      buyer_name=excluded.buyer_name, buyer_slug=excluded.buyer_slug,
      buyer_country=excluded.buyer_country, last_award_id=excluded.last_award_id,
      last_award_date=excluded.last_award_date, last_value_amount=excluded.last_value_amount,
      last_value_currency=excluded.last_value_currency, incumbent=excluded.incumbent,
      observations=excluded.observations, cycle_months=excluded.cycle_months,
      cycle_source=excluded.cycle_source, expiry_date=excluded.expiry_date,
      window_open=excluded.window_open, window_close=excluded.window_close,
      confidence=excluded.confidence, reasons=excluded.reasons,
      superseded_by=excluded.superseded_by, computed_at=excluded.computed_at
  `);
  const ts = nowIso();
  let n = 0;
  d.exec('BEGIN');
  try {
    for (const f of forecasts) {
      stmt.run(
        f.id, f.buyerKey, f.buyerName, f.buyerSlug, f.buyerCountry, f.cpvFamily,
        f.lastAwardId, f.lastAwardDate, f.lastValueAmount, f.lastValueCurrency, f.incumbent,
        f.observations, f.cycleMonths, f.cycleSource, f.expiryDate, f.windowOpen, f.windowClose,
        f.confidence, JSON.stringify(f.reasons), findSupersedingNotice(f), ts,
      );
      n += 1;
    }
    d.exec('COMMIT');
  } catch (err) {
    d.exec('ROLLBACK');
    throw err;
  }
  return n;
}

/** Recomputes the whole radar. Safe to run repeatedly; idempotent per buyer+CPV. */
export function refreshRadar(opts: { today?: string } = {}): { forecasts: number } {
  return { forecasts: saveForecasts(computeForecasts(opts)) };
}

function rowToForecast(r: any): Forecast {
  return {
    id: r.id,
    buyerKey: r.buyer_key,
    buyerName: r.buyer_name,
    buyerSlug: r.buyer_slug,
    buyerCountry: r.buyer_country,
    cpvFamily: r.cpv_family,
    lastAwardId: r.last_award_id,
    lastAwardDate: r.last_award_date,
    lastValueAmount: r.last_value_amount,
    lastValueCurrency: r.last_value_currency,
    incumbent: r.incumbent,
    observations: r.observations,
    cycleMonths: r.cycle_months,
    cycleSource: r.cycle_source,
    expiryDate: r.expiry_date,
    windowOpen: r.window_open,
    windowClose: r.window_close,
    confidence: r.confidence,
    reasons: JSON.parse(r.reasons ?? '[]'),
    supersededBy: r.superseded_by ?? null,
  };
}

export interface RadarQuery {
  cpvPrefixes?: string[];
  countries?: string[];
  slug?: string;
  minConfidence?: number;
  horizonMonths?: number;
  includeSuperseded?: boolean;
  limit?: number;
  today?: string;
}

/** Forecasts whose predicted window is open now or opens within the horizon. */
export function listForecasts(q: RadarQuery = {}): Forecast[] {
  const today = (q.today ?? nowIso()).slice(0, 10);
  const horizon = addMonths(today, q.horizonMonths ?? config.radar.horizonMonths);
  const where: string[] = ['window_open <= ?'];
  const params: unknown[] = [horizon];

  if (!q.includeSuperseded) where.push('superseded_by IS NULL');
  if (q.slug) { where.push('buyer_slug = ?'); params.push(q.slug); }
  if (q.minConfidence) { where.push('confidence >= ?'); params.push(q.minConfidence); }
  if (q.countries?.length) {
    where.push(`buyer_country IN (${q.countries.map(() => '?').join(',')})`);
    params.push(...q.countries.map((c) => c.toUpperCase()));
  }
  if (q.cpvPrefixes?.length) {
    const fams = [...new Set(q.cpvPrefixes.map((p) => p.replace(/\D/g, '').slice(0, 2)).filter(Boolean))];
    if (fams.length) {
      where.push(`cpv_family IN (${fams.map(() => '?').join(',')})`);
      params.push(...fams);
    }
  }
  // Drop forecasts whose window closed more than a year ago: stale, not pipeline.
  where.push('window_close >= ?');
  params.push(addMonths(today, -12));

  params.push(Math.min(500, q.limit ?? 100));
  const rows = db()
    .prepare(
      `SELECT * FROM forecasts WHERE ${where.join(' AND ')}
       ORDER BY confidence DESC, window_open ASC LIMIT ?`,
    )
    .all(...(params as any[])) as any[];
  return rows.map(rowToForecast);
}

export function countForecasts(): number {
  const r = db().prepare('SELECT COUNT(*) AS n FROM forecasts WHERE superseded_by IS NULL').get() as any;
  return r?.n ?? 0;
}

/**
 * Honest self-measurement for the hero feature.
 *
 * Every forecast is either eventually confirmed (a matching competition notice is
 * published inside its predicted window → `superseded_by` is set) or it passes its
 * window without one (`missed`). Hit rate is superseded / (superseded + missed),
 * which is the number the €79 tier actually rests on. Exposed on `/healthz` and
 * `/admin` so there is no "marketing" version of the claim: the model measures
 * itself, for free, from the same public feed.
 */
export function radarStats(opts: { today?: string } = {}): {
  total: number; open: number; superseded: number; missed: number; hitRatePct: number | null;
} {
  const d = db();
  const today = (opts.today ?? nowIso()).slice(0, 10);
  const count = (sql: string, ...params: unknown[]): number =>
    Number((d.prepare(sql).get(...(params as any[])) as any)?.c ?? 0);
  const total = count('SELECT COUNT(*) AS c FROM forecasts');
  const open = count(
    'SELECT COUNT(*) AS c FROM forecasts WHERE superseded_by IS NULL AND window_close >= ?',
    today,
  );
  const superseded = count('SELECT COUNT(*) AS c FROM forecasts WHERE superseded_by IS NOT NULL');
  const missed = count(
    'SELECT COUNT(*) AS c FROM forecasts WHERE superseded_by IS NULL AND window_close < ?',
    today,
  );
  const settled = superseded + missed;
  return {
    total,
    open,
    superseded,
    missed,
    hitRatePct: settled ? Math.round((superseded / settled) * 1000) / 10 : null,
  };
}

/**
 * The public showcase: a small, FIXED set of forecasts shown in full to
 * everyone, everywhere.
 *
 * The obvious design — "reveal the first N of whatever list you are looking
 * at" — is not a paywall. Filters and per-buyer pages each produce a different
 * list, so a visitor can harvest the entire radar by shuffling `?cpv=` or by
 * walking /buyers. Pinning the free set to the same globally-chosen ids makes
 * the preview independent of how the list was sliced: browsing more pages never
 * reveals a forecast that wasn't already free on the front page.
 *
 * Chosen by highest confidence so the marketing examples are also the strongest.
 */
const SHOWCASE_TTL_MS = 5 * 60 * 1000;
let showcaseCache: { ids: Set<string>; at: number; limit: number } | null = null;

export function showcaseForecastIds(limit = config.radar.showcaseCount): Set<string> {
  const now = Date.now();
  if (showcaseCache && showcaseCache.limit === limit && now - showcaseCache.at < SHOWCASE_TTL_MS) {
    return showcaseCache.ids;
  }
  const rows = db()
    .prepare(
      `SELECT id FROM forecasts
       WHERE superseded_by IS NULL
       ORDER BY confidence DESC, window_open ASC, id ASC
       LIMIT ?`,
    )
    .all(Math.max(0, limit)) as Array<{ id: string }>;
  const ids = new Set(rows.map((r) => r.id));
  showcaseCache = { ids, at: now, limit };
  return ids;
}

/** Test hook: drop the memoised showcase set. */
export function resetShowcaseCache(): void {
  showcaseCache = null;
}

/** Coarsens a date to a half-year, e.g. "2027-03-14" -> "H1 2027". */
export function halfYear(iso: string): string {
  const month = Number(iso.slice(5, 7));
  return `H${month <= 6 ? 1 : 2} ${iso.slice(0, 4)}`;
}
