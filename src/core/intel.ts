/**
 * Buyer & competition intelligence.
 *
 * Derived entirely from award notices already in the database. Two jobs:
 *  1. Power the public /buyer/:slug pages (a large, unique SEO surface —
 *     nobody else publishes "who wins what at this authority, and when it
 *     comes back to market").
 *  2. Answer the question every bidder actually has before writing a bid:
 *     "who am I up against here, and do they always win?"
 */
import { db } from './db.js';
import { listForecasts, slugify, type Forecast } from './radar.js';

export interface BuyerSummary {
  slug: string;
  name: string;
  country: string | null;
  awards: number;
  totalValue: number;
  currency: string | null;
  families: string[];
  lastAwardDate: string | null;
}

export interface SupplierShare {
  name: string;
  wins: number;
  totalValue: number;
  sharePct: number;
}

export interface BuyerProfile extends BuyerSummary {
  suppliers: SupplierShare[];
  forecasts: Forecast[];
  recentAwards: {
    id: string;
    title: string;
    date: string | null;
    value: number | null;
    currency: string | null;
    winners: string;
    url: string | null;
  }[];
}

/** Splits the stored "A; B; C" winner string into individual suppliers. */
function splitWinners(raw: string | null): string[] {
  return (raw ?? '')
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 1);
}

export function listBuyers(opts: { limit?: number; minAwards?: number } = {}): BuyerSummary[] {
  const rows = db()
    .prepare(
      `SELECT buyer_name AS name, buyer_slug AS slug, buyer_country AS country,
              COUNT(*) AS awards,
              COALESCE(SUM(value_amount), 0) AS total_value,
              MAX(value_currency) AS currency,
              MAX(publication_date) AS last_award,
              GROUP_CONCAT(DISTINCT SUBSTR(cpv_main, 1, 2)) AS families
       FROM notices
       WHERE is_award = 1 AND buyer_slug IS NOT NULL
       GROUP BY buyer_slug
       HAVING awards >= ?
       ORDER BY total_value DESC, awards DESC
       LIMIT ?`,
    )
    .all(opts.minAwards ?? 1, Math.min(2000, opts.limit ?? 200)) as any[];

  return rows.map((r) => ({
    slug: r.slug ?? slugify(r.name),
    name: r.name,
    country: r.country ?? null,
    awards: r.awards,
    totalValue: r.total_value ?? 0,
    currency: r.currency ?? null,
    families: String(r.families ?? '').split(',').filter(Boolean).sort(),
    lastAwardDate: r.last_award ?? null,
  }));
}

/**
 * Supplier league table for a buyer (or, with `family`, for a whole market).
 * Market share is computed on contract value where known, else on win count.
 */
export function supplierShare(
  opts: { buyerSlug?: string; family?: string; country?: string; limit?: number; scan?: number } = {},
): SupplierShare[] {
  const where: string[] = ['is_award = 1', "COALESCE(winner_names, '') <> ''"];
  const params: unknown[] = [];
  if (opts.buyerSlug) { where.push('buyer_slug = ?'); params.push(opts.buyerSlug); }
  if (opts.family) { where.push('cpv_main LIKE ?'); params.push(`${opts.family}%`); }
  if (opts.country) { where.push('buyer_country = ?'); params.push(opts.country.toUpperCase()); }

  // Hard row cap: a market-wide league table must never pull the whole table
  // into memory just because someone requested a two-digit CPV family.
  const rows = db()
    .prepare(
      `SELECT winner_names, value_amount FROM notices WHERE ${where.join(' AND ')}
       ORDER BY publication_date DESC LIMIT ?`,
    )
    .all(...(params as any[]), Math.min(20_000, opts.scan ?? 5_000)) as any[];

  const tally = new Map<string, { wins: number; totalValue: number }>();
  for (const r of rows) {
    const winners = splitWinners(r.winner_names);
    if (!winners.length) continue;
    // A multi-lot award splits its value evenly across the named winners.
    const per = (r.value_amount ?? 0) / winners.length;
    for (const w of winners) {
      const cur = tally.get(w) ?? { wins: 0, totalValue: 0 };
      cur.wins += 1;
      cur.totalValue += per;
      tally.set(w, cur);
    }
  }

  const all = [...tally.entries()].map(([name, v]) => ({ name, ...v }));
  const valueBase = all.reduce((a, b) => a + b.totalValue, 0);
  const winBase = all.reduce((a, b) => a + b.wins, 0) || 1;

  return all
    .map((s) => ({
      ...s,
      sharePct: Math.round(
        (valueBase > 0 ? s.totalValue / valueBase : s.wins / winBase) * 1000,
      ) / 10,
    }))
    .sort((a, b) => b.sharePct - a.sharePct || b.wins - a.wins)
    .slice(0, opts.limit ?? 10);
}

export function buyerProfile(slug: string): BuyerProfile | null {
  // Indexed single-buyer lookup. Deriving this from listBuyers() meant grouping
  // every award notice in the database on every page view — and buyer pages are
  // precisely the pages search-engine crawlers hit hardest.
  const agg = db()
    .prepare(
      `SELECT buyer_name AS name, buyer_slug AS slug, buyer_country AS country,
              COUNT(*) AS awards,
              COALESCE(SUM(value_amount), 0) AS total_value,
              MAX(value_currency) AS currency,
              MAX(publication_date) AS last_award,
              GROUP_CONCAT(DISTINCT SUBSTR(cpv_main, 1, 2)) AS families
       FROM notices WHERE is_award = 1 AND buyer_slug = ?`,
    )
    .get(slug) as any;
  if (!agg?.name) return null;

  const summary: BuyerSummary = {
    slug,
    name: agg.name,
    country: agg.country ?? null,
    awards: agg.awards,
    totalValue: agg.total_value ?? 0,
    currency: agg.currency ?? null,
    families: String(agg.families ?? '').split(',').filter(Boolean).sort(),
    lastAwardDate: agg.last_award ?? null,
  };

  const recent = db()
    .prepare(
      `SELECT id, title, publication_date, value_amount, value_currency, winner_names, url_html
       FROM notices WHERE is_award = 1 AND buyer_slug = ?
       ORDER BY publication_date DESC LIMIT 20`,
    )
    .all(slug) as any[];

  return {
    ...summary,
    suppliers: supplierShare({ buyerSlug: slug, limit: 8 }),
    forecasts: listForecasts({ slug, limit: 25, horizonMonths: 60 }),
    recentAwards: recent.map((r) => ({
      id: r.id,
      title: r.title,
      date: r.publication_date ?? null,
      value: r.value_amount ?? null,
      currency: r.value_currency ?? null,
      winners: r.winner_names ?? '',
      url: r.url_html ?? null,
    })),
  };
}
