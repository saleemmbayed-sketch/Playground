import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

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
];

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
