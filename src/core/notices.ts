import { db, nowIso } from './db.js';
import type { Notice } from '../ingest/ted.js';
import { slugify } from './slug.js';

export interface NoticeRow {
  id: string;
  title: string;
  buyer_name: string | null;
  buyer_country: string | null;
  place_nuts: string | null;
  cpv: string | null;
  cpv_main: string | null;
  notice_type: string | null;
  contract_nature: string | null;
  publication_date: string | null;
  deadline_date: string | null;
  value_amount: number | null;
  value_currency: string | null;
  description: string | null;
  url_html: string | null;
  language: string | null;
  summary: string | null;
  summary_source: string | null;
  first_seen_at: string;
  updated_at: string;
}

/** Inserts new notices, updates changed ones. Returns counts for the job log. */
export function upsertNotices(notices: Notice[]): { inserted: number; updated: number } {
  const d = db();
  const existing = d.prepare('SELECT id FROM notices WHERE id = ?');
  const insert = d.prepare(`
    INSERT INTO notices (id, title, buyer_name, buyer_country, place_nuts, cpv, cpv_main,
      notice_type, contract_nature, publication_date, deadline_date, value_amount, value_currency,
      description, url_html, language, raw, winner_names, buyer_identifier, is_award,
      buyer_slug, first_seen_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `);
  const update = d.prepare(`
    UPDATE notices SET title=?, buyer_name=?, buyer_country=?, place_nuts=?, cpv=?, cpv_main=?,
      notice_type=?, contract_nature=?, publication_date=?, deadline_date=?, value_amount=?,
      value_currency=?, description=?, url_html=?, language=?, raw=?, winner_names=?,
      buyer_identifier=?, is_award=?, buyer_slug=?, updated_at=?
    WHERE id=?
  `);

  let inserted = 0;
  let updated = 0;
  const ts = nowIso();

  d.exec('BEGIN');
  try {
    for (const n of notices) {
      const nuts = n.placeNuts.join(',');
      const cpv = n.cpv.join(',');
      const raw = JSON.stringify(n.raw);
      // Stored at write time so /buyer/:slug is an indexed lookup, not a scan.
      const buyerSlug = n.buyerName?.trim() ? slugify(n.buyerName) : null;
      if (existing.get(n.id)) {
        update.run(
          n.title, n.buyerName, n.buyerCountry, nuts, cpv, n.cpvMain, n.noticeType, n.contractNature,
          n.publicationDate, n.deadlineDate, n.valueAmount, n.valueCurrency, n.description,
          n.urlHtml, n.language, raw, n.winnerNames.join('; '), n.buyerIdentifier,
          n.isAward ? 1 : 0, buyerSlug, ts, n.id,
        );
        updated += 1;
      } else {
        insert.run(
          n.id, n.title, n.buyerName, n.buyerCountry, nuts, cpv, n.cpvMain, n.noticeType,
          n.contractNature, n.publicationDate, n.deadlineDate, n.valueAmount, n.valueCurrency,
          n.description, n.urlHtml, n.language, raw, n.winnerNames.join('; '),
          n.buyerIdentifier, n.isAward ? 1 : 0, buyerSlug, ts, ts,
        );
        inserted += 1;
      }
    }
    d.exec('COMMIT');
  } catch (err) {
    d.exec('ROLLBACK');
    throw err;
  }
  return { inserted, updated };
}

/** Notices published (or first seen) within the window, newest first. */
export function recentNotices(sinceIso: string, limit = 2000): NoticeRow[] {
  return db()
    .prepare(
      `SELECT * FROM notices
       WHERE first_seen_at >= ? OR (publication_date IS NOT NULL AND publication_date >= ?)
       ORDER BY COALESCE(publication_date, first_seen_at) DESC
       LIMIT ?`,
    )
    .all(sinceIso, sinceIso.slice(0, 10), limit) as unknown as NoticeRow[];
}

export function listNotices(opts: {
  limit?: number;
  offset?: number;
  cpvPrefix?: string;
  country?: string;
  q?: string;
} = {}): NoticeRow[] {
  const where: string[] = ['1=1'];
  const params: unknown[] = [];
  if (opts.cpvPrefix) {
    where.push('cpv LIKE ?');
    params.push(`${opts.cpvPrefix}%`);
  }
  if (opts.country) {
    where.push('buyer_country = ?');
    params.push(opts.country.toUpperCase());
  }
  if (opts.q) {
    where.push('(title LIKE ? OR buyer_name LIKE ? OR description LIKE ?)');
    const like = `%${opts.q}%`;
    params.push(like, like, like);
  }
  params.push(opts.limit ?? 50, opts.offset ?? 0);
  return db()
    .prepare(
      `SELECT * FROM notices WHERE ${where.join(' AND ')}
       ORDER BY COALESCE(publication_date, first_seen_at) DESC, id DESC
       LIMIT ? OFFSET ?`,
    )
    .all(...(params as any[])) as unknown as NoticeRow[];
}

export function getNotice(id: string): NoticeRow | null {
  return (db().prepare('SELECT * FROM notices WHERE id = ?').get(id) as unknown as NoticeRow) ?? null;
}

export function countNotices(): number {
  const r = db().prepare('SELECT COUNT(*) AS c FROM notices').get() as { c: number };
  return Number(r.c);
}

export function noticeStats(): { total: number; last7: number; countries: number } {
  const d = db();
  const total = (d.prepare('SELECT COUNT(*) c FROM notices').get() as any).c as number;
  const last7 = (
    d
      .prepare(
        `SELECT COUNT(*) c FROM notices WHERE COALESCE(publication_date, first_seen_at) >= date('now','-7 day')`,
      )
      .get() as any
  ).c as number;
  const countries = (
    d.prepare('SELECT COUNT(DISTINCT buyer_country) c FROM notices WHERE buyer_country IS NOT NULL').get() as any
  ).c as number;
  return { total: Number(total), last7: Number(last7), countries: Number(countries) };
}
