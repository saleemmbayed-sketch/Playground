import { db, nowIso } from './db.js';
import type { Profile } from './match.js';

export interface Subscriber {
  id: number;
  email: string;
  status: string;
  plan: string;
  stripe_customer_id: string | null;
  stripe_sub_id: string | null;
  current_period_end: string | null;
  created_at: string;
  updated_at: string;
  last_digest_at: string | null;
  confirmed_at: string | null;
}

export const DEFAULT_PROFILE = {
  cpv_prefixes: '72,48',
  countries: 'DEU,AUT,CHE',
  nuts_prefixes: '',
  keywords: '',
  exclude_words: '',
  min_value: null as number | null,
  max_value: null as number | null,
  min_score: 0.35,
  cadence: 'daily',
};

export const normalizeEmail = (email: string): string => email.trim().toLowerCase();

export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(email.trim());
}

export function getSubscriberByEmail(email: string): Subscriber | null {
  return (
    (db().prepare('SELECT * FROM subscribers WHERE email = ?').get(normalizeEmail(email)) as unknown as Subscriber) ??
    null
  );
}

export function getSubscriber(id: number): Subscriber | null {
  return (db().prepare('SELECT * FROM subscribers WHERE id = ?').get(id) as unknown as Subscriber) ?? null;
}

export function getSubscriberByCustomer(customerId: string): Subscriber | null {
  return (
    (db().prepare('SELECT * FROM subscribers WHERE stripe_customer_id = ?').get(customerId) as unknown as Subscriber) ??
    null
  );
}

export interface CreateOpts {
  /** 'pending' until the double opt-in link is clicked. Paid signups skip straight to confirmed. */
  status?: string;
  signupSource?: string;
}

/** Marks a pending subscriber as confirmed. Idempotent. */
export function confirmSubscriber(id: number): Subscriber | null {
  const sub = getSubscriber(id);
  if (!sub) return null;
  if (sub.status === 'pending' || sub.status === 'unsubscribed') {
    db()
      .prepare('UPDATE subscribers SET status = ?, confirmed_at = ?, updated_at = ? WHERE id = ?')
      .run('free', sub.confirmed_at ?? nowIso(), nowIso(), id);
  } else if (!sub.confirmed_at) {
    db().prepare('UPDATE subscribers SET confirmed_at = ?, updated_at = ? WHERE id = ?').run(nowIso(), nowIso(), id);
  }
  return getSubscriber(id);
}

export function markConfirmationSent(id: number): void {
  db().prepare('UPDATE subscribers SET confirm_sent_at = ?, updated_at = ? WHERE id = ?').run(nowIso(), nowIso(), id);
}

export function createSubscriber(
  email: string,
  patch: Partial<typeof DEFAULT_PROFILE> = {},
  opts: CreateOpts = {},
): Subscriber {
  const d = db();
  const ts = nowIso();
  const clean = normalizeEmail(email);
  const existing = getSubscriberByEmail(clean);
  if (existing) {
    if (Object.keys(patch).length) updateProfile(existing.id, patch);
    // Re-subscribing after an unsubscribe requires a fresh confirmation.
    if (existing.status === 'unsubscribed') {
      d.prepare('UPDATE subscribers SET status = ?, updated_at = ? WHERE id = ?')
        .run(opts.status ?? 'pending', ts, existing.id);
    }
    return getSubscriber(existing.id)!;
  }

  const status = opts.status ?? 'pending';
  const info = d
    .prepare(
      'INSERT INTO subscribers (email, status, plan, signup_source, confirmed_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?)',
    )
    .run(clean, status, 'free', opts.signupSource ?? 'web', status === 'pending' ? null : ts, ts, ts);
  const id = Number(info.lastInsertRowid);
  const p = { ...DEFAULT_PROFILE, ...patch };
  d.prepare(
    `INSERT INTO profiles (subscriber_id, cpv_prefixes, countries, nuts_prefixes, keywords,
      exclude_words, min_value, max_value, min_score, cadence, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    id, p.cpv_prefixes, p.countries, p.nuts_prefixes, p.keywords, p.exclude_words,
    p.min_value, p.max_value, p.min_score, p.cadence, ts,
  );
  return getSubscriber(id)!;
}

export function getProfile(subscriberId: number): Profile | null {
  return (db().prepare('SELECT * FROM profiles WHERE subscriber_id = ?').get(subscriberId) as unknown as Profile) ?? null;
}

export function updateProfile(subscriberId: number, patch: Partial<typeof DEFAULT_PROFILE>): void {
  const current = getProfile(subscriberId);
  if (!current) return;
  const merged = { ...current, ...patch };
  db()
    .prepare(
      `UPDATE profiles SET cpv_prefixes=?, countries=?, nuts_prefixes=?, keywords=?, exclude_words=?,
        min_value=?, max_value=?, min_score=?, cadence=?, updated_at=? WHERE subscriber_id=?`,
    )
    .run(
      merged.cpv_prefixes, merged.countries, merged.nuts_prefixes, merged.keywords, merged.exclude_words,
      merged.min_value ?? null, merged.max_value ?? null, merged.min_score, merged.cadence, nowIso(), subscriberId,
    );
}

export function setSubscriberStatus(
  id: number,
  patch: Partial<Pick<Subscriber, 'status' | 'plan' | 'stripe_customer_id' | 'stripe_sub_id' | 'current_period_end'>>,
): void {
  const fields = Object.keys(patch);
  if (!fields.length) return;
  const sets = fields.map((f) => `${f} = ?`).join(', ');
  db()
    .prepare(`UPDATE subscribers SET ${sets}, updated_at = ? WHERE id = ?`)
    .run(...(Object.values(patch) as any[]), nowIso(), id);
}

export function unsubscribe(id: number): void {
  setSubscriberStatus(id, { status: 'unsubscribed' });
}

/** Subscribers entitled to paid daily alerts. */
export function payingSubscribers(): Array<Subscriber & { profile: Profile }> {
  const rows = db()
    .prepare(
      `SELECT s.*, p.* FROM subscribers s JOIN profiles p ON p.subscriber_id = s.id
       WHERE s.status IN ('active','trialing')`,
    )
    .all() as unknown as Array<Subscriber & Profile>;
  return rows.map((r) => ({ ...(r as any), profile: r as unknown as Profile }));
}

/** Free subscribers who get the weekly teaser digest. */
export function freeSubscribers(): Array<Subscriber & { profile: Profile }> {
  const rows = db()
    .prepare(
      `SELECT s.*, p.* FROM subscribers s JOIN profiles p ON p.subscriber_id = s.id
       WHERE s.status = 'free'`,
    )
    .all() as unknown as Array<Subscriber & Profile>;
  return rows.map((r) => ({ ...(r as any), profile: r as unknown as Profile }));
}

export function alreadyDelivered(subscriberId: number, noticeIds: string[]): Set<string> {
  if (!noticeIds.length) return new Set();
  const placeholders = noticeIds.map(() => '?').join(',');
  const rows = db()
    .prepare(`SELECT notice_id FROM deliveries WHERE subscriber_id = ? AND notice_id IN (${placeholders})`)
    .all(subscriberId, ...noticeIds) as unknown as Array<{ notice_id: string }>;
  return new Set(rows.map((r) => r.notice_id));
}

export function recordDeliveries(subscriberId: number, items: Array<{ id: string; score: number }>): void {
  const d = db();
  const stmt = d.prepare(
    'INSERT OR IGNORE INTO deliveries (subscriber_id, notice_id, score, sent_at) VALUES (?,?,?,?)',
  );
  const ts = nowIso();
  d.exec('BEGIN');
  try {
    for (const it of items) stmt.run(subscriberId, it.id, it.score, ts);
    d.prepare('UPDATE subscribers SET last_digest_at = ? WHERE id = ?').run(ts, subscriberId);
    d.exec('COMMIT');
  } catch (e) {
    d.exec('ROLLBACK');
    throw e;
  }
}

/** Everyone who has confirmed and not unsubscribed — used for audience size reporting. */
export function pendingSubscribers(): Subscriber[] {
  return db()
    .prepare("SELECT * FROM subscribers WHERE status = 'pending' ORDER BY created_at DESC")
    .all() as unknown as Subscriber[];
}

export function subscriberStats(): { total: number; paying: number; free: number; pending: number } {
  const d = db();
  const g = (sql: string) => Number((d.prepare(sql).get() as any).c);
  return {
    total: g("SELECT COUNT(*) c FROM subscribers WHERE status NOT IN ('unsubscribed','pending')"),
    paying: g("SELECT COUNT(*) c FROM subscribers WHERE status IN ('active','trialing')"),
    free: g("SELECT COUNT(*) c FROM subscribers WHERE status = 'free'"),
    pending: g("SELECT COUNT(*) c FROM subscribers WHERE status = 'pending'"),
  };
}
