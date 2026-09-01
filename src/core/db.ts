import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { slugify } from './slug.js';

let _db: DatabaseSync | null = null;

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS notices (
  id                TEXT PRIMARY KEY,           -- TED publication number, e.g. 399019-2026
  title             TEXT NOT NULL,
  buyer_name        TEXT,
  buyer_country     TEXT,
  place_nuts        TEXT,                       -- comma separated NUTS codes
  cpv               TEXT,                       -- comma separated CPV codes
  cpv_main          TEXT,
  notice_type       TEXT,
  contract_nature   TEXT,
  publication_date  TEXT,                       -- ISO date
  deadline_date     TEXT,                       -- ISO date, may be null
  value_amount      REAL,
  value_currency    TEXT,
  description       TEXT,
  url_html          TEXT,
  language          TEXT,
  raw               TEXT NOT NULL,              -- original JSON for reprocessing
  winner_names      TEXT,                       -- semicolon-joined winners (award notices)
  buyer_identifier  TEXT,                       -- stable buyer registry id, when TED supplies one
  buyer_slug        TEXT,                       -- URL slug of buyer_name, indexed for /buyer/:slug
  is_award          INTEGER NOT NULL DEFAULT 0, -- 1 = contract award notice (can-*)
  summary           TEXT,                       -- plain-language summary (LLM or fallback)
  summary_source    TEXT,                       -- 'llm' | 'heuristic'
  first_seen_at     TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notices_pub  ON notices(publication_date DESC);
CREATE INDEX IF NOT EXISTS idx_notices_seen ON notices(first_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_notices_cpv  ON notices(cpv_main);

CREATE TABLE IF NOT EXISTS subscribers (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  email              TEXT NOT NULL UNIQUE,
  status             TEXT NOT NULL DEFAULT 'free',  -- free | trialing | active | past_due | canceled | unsubscribed
  plan               TEXT NOT NULL DEFAULT 'free',  -- free | pro
  stripe_customer_id TEXT,
  stripe_sub_id      TEXT,
  current_period_end TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  last_digest_at     TEXT,
  confirmed_at       TEXT
);
CREATE INDEX IF NOT EXISTS idx_sub_status ON subscribers(status);

CREATE TABLE IF NOT EXISTS profiles (
  subscriber_id  INTEGER PRIMARY KEY REFERENCES subscribers(id) ON DELETE CASCADE,
  cpv_prefixes   TEXT NOT NULL DEFAULT '72,48',   -- comma separated CPV prefixes
  countries      TEXT NOT NULL DEFAULT '',        -- ISO3 codes, empty = all
  nuts_prefixes  TEXT NOT NULL DEFAULT '',        -- e.g. DE1,DE2 ; empty = all
  keywords       TEXT NOT NULL DEFAULT '',        -- comma separated, OR-matched, boosts score
  exclude_words  TEXT NOT NULL DEFAULT '',        -- comma separated, hard filter
  min_value      REAL,
  max_value      REAL,
  min_score      REAL NOT NULL DEFAULT 0.35,
  cadence        TEXT NOT NULL DEFAULT 'daily',   -- daily | weekly
  updated_at     TEXT NOT NULL
);

-- Every match ever sent: guarantees a subscriber never sees the same notice twice.
-- Re-tender Radar forecasts: one row per (buyer, CPV family) pipeline opportunity.
CREATE TABLE IF NOT EXISTS forecasts (
  id                  TEXT PRIMARY KEY,         -- hash of buyer_key + cpv_family
  buyer_key           TEXT NOT NULL,            -- buyer_identifier when present, else slug of name
  buyer_name          TEXT NOT NULL,
  buyer_slug          TEXT NOT NULL,
  buyer_country       TEXT,
  cpv_family          TEXT NOT NULL,
  last_award_id       TEXT,                     -- notice id of the most recent award
  last_award_date     TEXT,                     -- ISO date
  last_value_amount   REAL,
  last_value_currency TEXT,
  incumbent           TEXT,                     -- winner name(s) of the last award
  observations        INTEGER NOT NULL DEFAULT 1,
  cycle_months        REAL NOT NULL,            -- observed or assumed contract cycle
  cycle_source        TEXT NOT NULL,            -- 'observed' | 'assumed'
  expiry_date         TEXT NOT NULL,            -- predicted end of incumbent contract
  window_open         TEXT NOT NULL,            -- predicted earliest re-tender publication
  window_close        TEXT NOT NULL,            -- predicted latest re-tender publication
  confidence          REAL NOT NULL,            -- 0..1
  reasons             TEXT NOT NULL,            -- JSON array of explanations
  superseded_by       TEXT,                     -- notice id if the re-tender already published
  computed_at         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_forecasts_window ON forecasts(window_open);
CREATE INDEX IF NOT EXISTS idx_forecasts_slug ON forecasts(buyer_slug);

CREATE TABLE IF NOT EXISTS deliveries (
  subscriber_id INTEGER NOT NULL REFERENCES subscribers(id) ON DELETE CASCADE,
  notice_id     TEXT NOT NULL REFERENCES notices(id) ON DELETE CASCADE,
  score         REAL NOT NULL,
  sent_at       TEXT NOT NULL,
  PRIMARY KEY (subscriber_id, notice_id)
);

CREATE TABLE IF NOT EXISTS events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  kind       TEXT NOT NULL,
  payload    TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_kind ON events(kind, created_at DESC);

CREATE TABLE IF NOT EXISTS job_runs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  job        TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at   TEXT,
  ok         INTEGER,
  stats      TEXT,
  error      TEXT
);
CREATE INDEX IF NOT EXISTS idx_job_runs ON job_runs(job, started_at DESC);

-- Addresses we must never mail again (hard bounces, spam complaints, manual blocks).
CREATE TABLE IF NOT EXISTS suppressions (
  email      TEXT PRIMARY KEY,
  reason     TEXT NOT NULL,
  detail     TEXT,
  created_at TEXT NOT NULL
);

-- Stripe delivers each event at least once and retries for days; this table makes
-- webhook processing idempotent (the PRIMARY KEY is the claim).
CREATE TABLE IF NOT EXISTS stripe_events (
  id          TEXT PRIMARY KEY,
  type        TEXT NOT NULL,
  received_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS kv (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

/**
 * Additive migrations for databases created by an older version.
 * `CREATE TABLE IF NOT EXISTS` never adds columns, so new columns are applied here.
 * Every entry must be idempotent and safe to run on a live database.
 */
const MIGRATIONS: Array<{ table: string; column: string; ddl: string }> = [
  { table: 'notices', column: 'contract_nature', ddl: 'ALTER TABLE notices ADD COLUMN contract_nature TEXT' },
  { table: 'notices', column: 'summary', ddl: 'ALTER TABLE notices ADD COLUMN summary TEXT' },
  { table: 'notices', column: 'summary_source', ddl: 'ALTER TABLE notices ADD COLUMN summary_source TEXT' },
  { table: 'subscribers', column: 'confirmed_at', ddl: 'ALTER TABLE subscribers ADD COLUMN confirmed_at TEXT' },
  { table: 'subscribers', column: 'source', ddl: "ALTER TABLE subscribers ADD COLUMN source TEXT DEFAULT 'web'" },
  // Re-tender Radar: award-notice intelligence.
  { table: 'notices', column: 'winner_names', ddl: 'ALTER TABLE notices ADD COLUMN winner_names TEXT' },
  { table: 'notices', column: 'buyer_identifier', ddl: 'ALTER TABLE notices ADD COLUMN buyer_identifier TEXT' },
  { table: 'notices', column: 'is_award', ddl: 'ALTER TABLE notices ADD COLUMN is_award INTEGER NOT NULL DEFAULT 0' },
  { table: 'notices', column: 'buyer_slug', ddl: 'ALTER TABLE notices ADD COLUMN buyer_slug TEXT' },
];

/**
 * Fills buyer_slug for rows written before the column existed (and for any row
 * an older code path inserted without one). Slugs need JS transliteration, so
 * this cannot be expressed as SQL in the migration itself. Runs once per start
 * and is a no-op when there is nothing to fill.
 */
/**
 * Indexes over columns that arrive via migration.
 *
 * These cannot live in SCHEMA: on a database created by an older version the
 * column does not exist yet when SCHEMA runs, and CREATE INDEX would abort
 * startup. Tables first, then columns, then indexes.
 */
const POST_MIGRATION_INDEXES = [
  'CREATE INDEX IF NOT EXISTS idx_notices_award ON notices(is_award, cpv_main, publication_date)',
  // Buyer pages are the SEO surface and get crawled hard: look them up by an
  // indexed slug instead of grouping every award notice on each request.
  'CREATE INDEX IF NOT EXISTS idx_notices_buyer_slug ON notices(buyer_slug, is_award)',
  'CREATE INDEX IF NOT EXISTS idx_notices_award_buyer ON notices(is_award, buyer_name)',
  'CREATE INDEX IF NOT EXISTS idx_forecasts_lookup ON forecasts(superseded_by, confidence, window_open)',
];

function createIndexes(d: DatabaseSync): void {
  for (const ddl of POST_MIGRATION_INDEXES) {
    try {
      d.exec(ddl);
    } catch (err) {
      console.error(`[db] index creation failed: ${ddl}`, err);
    }
  }
}

function backfillBuyerSlugs(d: DatabaseSync): void {
  const cols = d.prepare('PRAGMA table_info(notices)').all() as unknown as Array<{ name: string }>;
  if (!cols.some((c) => c.name === 'buyer_slug')) return;
  const rows = d
    .prepare("SELECT DISTINCT buyer_name FROM notices WHERE buyer_slug IS NULL AND buyer_name IS NOT NULL AND TRIM(buyer_name) <> ''")
    .all() as unknown as Array<{ buyer_name: string }>;
  if (!rows.length) return;
  const upd = d.prepare('UPDATE notices SET buyer_slug = ? WHERE buyer_name = ? AND buyer_slug IS NULL');
  d.exec('BEGIN');
  try {
    for (const r of rows) upd.run(slugify(r.buyer_name), r.buyer_name);
    d.exec('COMMIT');
    console.log(`[db] backfilled buyer_slug for ${rows.length} buyer name(s)`);
  } catch (err) {
    d.exec('ROLLBACK');
    console.error('[db] buyer_slug backfill failed', err);
  }
}

/**
 * Re-derives is_award for notices ingested before the column existed.
 *
 * The migration defaults it to 0, so without this every award already in the
 * archive would stay invisible to the radar — the forecaster would silently
 * see an empty history on databases that actually hold years of awards.
 */
function backfillAwardFlag(d: DatabaseSync): void {
  const cols = d.prepare('PRAGMA table_info(notices)').all() as unknown as Array<{ name: string }>;
  if (!cols.some((c) => c.name === 'is_award')) return;
  const res = d
    .prepare("UPDATE notices SET is_award = 1 WHERE is_award = 0 AND LOWER(COALESCE(notice_type,'')) LIKE 'can%'")
    .run();
  const n = Number(res.changes ?? 0);
  if (n > 0) console.log(`[db] backfilled is_award for ${n} award notice(s)`);
}

function migrate(d: DatabaseSync): void {
  for (const m of MIGRATIONS) {
    const cols = d.prepare(`PRAGMA table_info(${m.table})`).all() as unknown as Array<{ name: string }>;
    if (!cols.length) continue; // table not created yet in this schema version
    if (cols.some((c) => c.name === m.column)) continue;
    try {
      d.exec(m.ddl);
      console.log(`[db] migrated: ${m.table}.${m.column}`);
    } catch (err) {
      console.error(`[db] migration failed for ${m.table}.${m.column}`, err);
      throw err;
    }
  }
}

export function db(): DatabaseSync {
  if (_db) return _db;
  fs.mkdirSync(path.dirname(config.db.file), { recursive: true });
  const d = new DatabaseSync(config.db.file);
  d.exec(SCHEMA);
  migrate(d);
  createIndexes(d);
  backfillBuyerSlugs(d);
  backfillAwardFlag(d);
  _db = d;
  return d;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function logEvent(kind: string, payload?: unknown): void {
  db()
    .prepare('INSERT INTO events (kind, payload, created_at) VALUES (?, ?, ?)')
    .run(kind, payload === undefined ? null : JSON.stringify(payload), nowIso());
}

export function kvGet(key: string): string | null {
  const row = db().prepare('SELECT value FROM kv WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

export function kvSet(key: string, value: string): void {
  db()
    .prepare(
      `INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .run(key, value, nowIso());
}

/** Wraps a job with timing + persisted result so failures are visible on /admin/health. */
export async function withJobRun<T>(
  job: string,
  fn: () => Promise<T>,
): Promise<{ ok: boolean; result?: T; error?: string }> {
  const started = nowIso();
  const info = db()
    .prepare('INSERT INTO job_runs (job, started_at) VALUES (?, ?)')
    .run(job, started);
  const id = Number(info.lastInsertRowid);
  try {
    const result = await fn();
    db()
      .prepare('UPDATE job_runs SET ended_at = ?, ok = 1, stats = ? WHERE id = ?')
      .run(nowIso(), JSON.stringify(result ?? {}), id);
    return { ok: true, result };
  } catch (err) {
    const message = err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err);
    db()
      .prepare('UPDATE job_runs SET ended_at = ?, ok = 0, error = ? WHERE id = ?')
      .run(nowIso(), message, id);
    console.error(`[job:${job}] failed`, err);
    return { ok: false, error: message };
  }
}

/**
 * Flushes the WAL into the main database file and closes the handle.
 * Called on SIGTERM so a `docker compose restart` or a redeploy can never leave a
 * half-written WAL behind, and so the nightly backup always has a clean file to copy.
 */
export function closeDb(): void {
  if (!_db) return;
  try {
    _db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } catch {
    /* checkpoint is best-effort; closing still flushes */
  }
  try {
    _db.close();
  } finally {
    _db = null;
  }
}
