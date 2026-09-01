/**
 * TED (Tenders Electronic Daily) Search API v3 client.
 *
 * Endpoint: POST https://api.ted.europa.eu/v3/notices/search  (anonymous, keyless)
 * Docs:     https://docs.ted.europa.eu/api/latest/search.html
 * Syntax:   https://ted.europa.eu/en/help/search-browse  (expert search)
 *
 * Verified contract (Sept 2026):
 *   - POST only; GET returns "Request method 'GET' is not supported".
 *   - Dates in expert queries use YYYYMMDD, e.g. `publication-date>=20260101`.
 *   - CPV wildcards use `classification-cpv=72*`; the IN operator takes space-separated values.
 *   - `limit` <= 100 per page; result window is capped (~15k) so we page politely.
 *   - Multilingual fields arrive as {"eng":[...],"deu":[...]}, not plain strings.
 *   - Values come as `total-value` + `total-value-cur`; the deadline field is `deadline`.
 *
 * Self-healing: field names are the one part of this API that drifts. On an HTTP 400 the
 * client probes each candidate field individually against the live API, caches the working
 * set in the DB, and carries on. A TED rename therefore degrades one column instead of
 * taking the business down.
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { kvGet, kvSet } from '../core/db.js';

export interface RawNotice {
  [key: string]: unknown;
}

export interface Notice {
  id: string;
  title: string;
  buyerName: string | null;
  buyerCountry: string | null;
  placeNuts: string[];
  cpv: string[];
  cpvMain: string | null;
  noticeType: string | null;
  publicationDate: string | null;
  deadlineDate: string | null;
  valueAmount: number | null;
  valueCurrency: string | null;
  description: string | null;
  urlHtml: string;
  language: string | null;
  source: string;
  raw: RawNotice;
}

/**
 * Fields we ask TED for, most valuable first.
 * CORE must exist for the product to work; OPTIONAL fields are nice-to-have and are
 * dropped automatically if TED rejects them.
 */
export const CORE_FIELDS = [
  'publication-number',
  'notice-title',
  'buyer-name',
  'buyer-country',
  'classification-cpv',
  'publication-date',
] as const;

export const OPTIONAL_FIELDS = [
  'deadline',
  'total-value',
  'total-value-cur',
  'notice-type',
  'place-of-performance',
  'contract-nature',
  'description-lot',
  'links',
] as const;

const FIELD_CACHE_KEY = 'ted_working_fields_v3';
const PREFERRED_LANGS = ['eng', 'deu', 'fra', 'en', 'de', 'fr'];

/* -------------------------------------------------------------------------- */
/* Value extraction — TED returns strings, arrays, or {lang: [values]} maps.   */
/* -------------------------------------------------------------------------- */

export function pickText(value: unknown, maxLen = 4000): string | null {
  const out = collectStrings(value);
  if (!out.length) return null;
  return out.join(' ').replace(/\s+/g, ' ').trim().slice(0, maxLen) || null;
}

function collectStrings(value: unknown): string[] {
  if (value == null) return [];
  if (typeof value === 'string') return value.trim() ? [value.trim()] : [];
  if (typeof value === 'number') return [String(value)];
  if (Array.isArray(value)) return value.flatMap(collectStrings);
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    for (const lang of PREFERRED_LANGS) {
      if (obj[lang] != null) return collectStrings(obj[lang]);
    }
    for (const v of Object.values(obj)) {
      const got = collectStrings(v);
      if (got.length) return got;
    }
  }
  return [];
}

function collectCodes(value: unknown): string[] {
  const seen = new Set<string>();
  for (const s of collectStrings(value)) {
    for (const tok of s.split(/[\s,;]+/)) {
      const t = tok.trim().toUpperCase();
      if (t && t.length <= 12) seen.add(t);
    }
  }
  return [...seen];
}

function firstDate(...values: unknown[]): string | null {
  for (const v of values) {
    for (const s of collectStrings(v)) {
      const iso = s.match(/\d{4}-\d{2}-\d{2}/);
      if (iso) return iso[0];
      const compact = s.match(/\b(\d{4})(\d{2})(\d{2})\b/);
      if (compact) return `${compact[1]}-${compact[2]}-${compact[3]}`;
    }
  }
  return null;
}

function firstNumber(...values: unknown[]): number | null {
  for (const v of values) {
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v;
    for (const s of collectStrings(v)) {
      const cleaned = s.replace(/[^\d.,-]/g, '').replace(/,(?=\d{3}\b)/g, '');
      const n = Number.parseFloat(cleaned.replace(',', '.'));
      if (Number.isFinite(n) && n > 0) return n;
    }
  }
  return null;
}

/** Deep-collects every string in a structure (unlike collectStrings, which takes one branch). */
function collectAllStrings(value: unknown, out: string[] = []): string[] {
  if (value == null) return out;
  if (typeof value === 'string') {
    if (value.trim()) out.push(value.trim());
    return out;
  }
  if (typeof value === 'number') {
    out.push(String(value));
    return out;
  }
  if (Array.isArray(value)) {
    for (const v of value) collectAllStrings(v, out);
    return out;
  }
  if (typeof value === 'object') {
    for (const v of Object.values(value as Record<string, unknown>)) collectAllStrings(v, out);
  }
  return out;
}

function firstCurrency(...values: unknown[]): string | null {
  for (const v of values) {
    // Scans every branch: TED sometimes nests the currency alongside the amount.
    for (const s of collectAllStrings(v)) {
      const m = s.match(/\b(EUR|USD|GBP|CHF|SEK|DKK|NOK|PLN|CZK|HUF|RON|BGN|ISK|HRK)\b/i);
      if (m?.[1]) return m[1].toUpperCase();
    }
  }
  return null;
}

/** TED links objects look like {html:{ENG:"..."}} or {pdf:{...}}; find any http(s) URL. */
function findUrl(value: unknown): string | null {
  for (const s of collectStrings(value)) {
    const m = s.match(/https?:\/\/\S+/);
    if (m) return m[0];
  }
  return null;
}

export function noticeUrl(id: string): string {
  return `https://ted.europa.eu/en/notice/${encodeURIComponent(id)}/html`;
}

export function normalizeNotice(raw: RawNotice, source = 'ted'): Notice | null {
  const id = pickText(raw['publication-number'] ?? raw['ND'] ?? raw['publicationNumber'], 40);
  if (!id) return null;

  const cpv = collectCodes(raw['classification-cpv'] ?? raw['cpv']).filter((c) => /^\d{4,8}$/.test(c));
  const nuts = collectCodes(raw['place-of-performance'] ?? raw['place-of-performance-country-part'])
    .filter((c) => /^[A-Z]{2}[0-9A-Z]{0,3}$/.test(c));
  const title = pickText(raw['notice-title'] ?? raw['title'], 500) ?? `TED notice ${id}`;
  const description = pickText(
    raw['description-lot'] ?? raw['description-proc'] ?? raw['notice-description'],
    4000,
  );

  return {
    id,
    title,
    buyerName: pickText(raw['buyer-name'], 300),
    buyerCountry: collectCodes(raw['buyer-country'])[0] ?? null,
    placeNuts: nuts,
    cpv,
    cpvMain: cpv[0] ?? null,
    noticeType: pickText(raw['notice-type'] ?? raw['contract-nature'], 80),
    publicationDate: firstDate(raw['publication-date']),
    deadlineDate: firstDate(
      raw['deadline'],
      raw['deadline-receipt-tender-date-lot'],
      raw['deadline-receipt-request'],
    ),
    valueAmount: firstNumber(raw['total-value'], raw['estimated-value-lot']),
    valueCurrency: firstCurrency(raw['total-value-cur'], raw['total-value']) ?? 'EUR',
    description,
    urlHtml: findUrl(raw['links']) ?? noticeUrl(id),
    language: pickText(raw['notice-language'], 10),
    source,
    raw,
  };
}

/* -------------------------------------------------------------------------- */
/* Query building                                                             */
/* -------------------------------------------------------------------------- */

const compactDate = (d: Date): string => d.toISOString().slice(0, 10).replace(/-/g, '');

/**
 * Builds a TED expert query. Uses explicit YYYYMMDD dates (the documented syntax)
 * rather than relative helpers, so the query is inspectable and reproducible.
 */
export function buildQuery(lookbackDays: number, now = new Date()): string {
  const since = compactDate(new Date(now.getTime() - Math.max(0, lookbackDays) * 86_400_000));
  const parts: string[] = [`publication-date>=${since}`];

  const families = config.ted.cpvFamilies
    .map((f) => f.replace(/\D/g, '').slice(0, 2))
    .filter(Boolean);
  if (families.length) {
    parts.push(`(${families.map((f) => `classification-cpv=${f}*`).join(' OR ')})`);
  }
  if (config.ted.countries.length) {
    parts.push(`buyer-country IN (${config.ted.countries.join(' ')})`);
  }
  return `${parts.join(' AND ')} SORT BY publication-date DESC`;
}

/* -------------------------------------------------------------------------- */
/* HTTP                                                                       */
/* -------------------------------------------------------------------------- */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class TedApiError extends Error {
  constructor(message: string, readonly status: number, readonly body: string) {
    super(message);
    this.name = 'TedApiError';
  }
}

async function postSearch(body: unknown, attempt = 0): Promise<any> {
  let res: Response;
  try {
    res = await fetch(config.ted.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': config.ted.userAgent,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(45_000),
    });
  } catch (err) {
    // Network blips and timeouts are retried; the ingest job is idempotent anyway.
    if (attempt >= 3) throw err;
    await sleep(Math.min(20_000, 1500 * 2 ** attempt));
    return postSearch(body, attempt + 1);
  }

  if (res.status === 429 || res.status >= 500) {
    if (attempt >= 4) throw new TedApiError(`TED API ${res.status} after retries`, res.status, '');
    await sleep(Math.min(30_000, 1000 * 2 ** attempt));
    return postSearch(body, attempt + 1);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new TedApiError(`TED API ${res.status}: ${text.slice(0, 400)}`, res.status, text);
  }
  return res.json();
}

/* -------------------------------------------------------------------------- */
/* Self-healing field resolution                                              */
/* -------------------------------------------------------------------------- */

/**
 * Asks TED for one field at a time to find out which names it currently accepts.
 * Runs at most once per deployment (result cached in the DB) or on demand via
 * `npm run cli -- probe-fields`.
 */
export async function probeFields(opts: { verbose?: boolean } = {}): Promise<{
  working: string[];
  rejected: string[];
}> {
  const query = buildQuery(7);
  const working: string[] = [];
  const rejected: string[] = [];

  for (const field of [...CORE_FIELDS, ...OPTIONAL_FIELDS]) {
    try {
      await postSearch({
        query,
        fields: ['publication-number', field],
        page: 1,
        limit: 1,
        scope: 'ACTIVE',
        paginationMode: 'PAGE_NUMBER',
      });
      working.push(field);
      if (opts.verbose) console.log(`  ✓ ${field}`);
    } catch (err) {
      if (err instanceof TedApiError && err.status === 400) {
        rejected.push(field);
        if (opts.verbose) console.log(`  ✗ ${field} (rejected)`);
      } else {
        throw err;
      }
    }
    await sleep(config.ted.requestDelayMs);
  }

  const unique = [...new Set(['publication-number', ...working])];
  kvSet(FIELD_CACHE_KEY, JSON.stringify({ fields: unique, probedAt: new Date().toISOString() }));
  return { working: unique, rejected };
}

function cachedFields(): string[] | null {
  const raw = kvGet(FIELD_CACHE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.fields) && parsed.fields.length ? parsed.fields : null;
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Fetching                                                                   */
/* -------------------------------------------------------------------------- */

function loadFixtures(): RawNotice[] {
  const dir = path.resolve(process.cwd(), 'data/fixtures');
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .flatMap((f) => {
      const parsed = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      return Array.isArray(parsed) ? parsed : (parsed.notices ?? []);
    });
}

export interface FetchResult {
  notices: Notice[];
  pages: number;
  totalReported: number;
  source: 'ted' | 'fixtures';
  fieldsUsed: string[];
  query: string;
  degraded: boolean;
}

export async function fetchNotices(opts: { lookbackDays?: number } = {}): Promise<FetchResult> {
  const lookbackDays = opts.lookbackDays ?? config.ted.lookbackDays;

  if (config.ted.offline) {
    const notices = loadFixtures()
      .map((r) => normalizeNotice(r, 'fixtures'))
      .filter((n): n is Notice => n !== null);
    return {
      notices, pages: 1, totalReported: notices.length, source: 'fixtures',
      fieldsUsed: [], query: '(offline fixtures)', degraded: false,
    };
  }

  const query = buildQuery(lookbackDays);
  let fields = cachedFields() ?? [...CORE_FIELDS, ...OPTIONAL_FIELDS];
  let degraded = false;

  const collected: Notice[] = [];
  const seen = new Set<string>();
  let page = 1;
  let pages = 0;
  let totalReported = 0;
  const limit = Math.min(config.ted.pageSize, 100); // TED caps page size at 100

  while (collected.length < config.ted.maxNotices) {
    const body = {
      query,
      fields,
      page,
      limit,
      scope: 'ACTIVE',
      paginationMode: 'PAGE_NUMBER',
      onlyLatestVersions: true,
    };

    let json: any;
    try {
      json = await postSearch(body);
    } catch (err) {
      if (err instanceof TedApiError && err.status === 400 && !degraded) {
        // A field name drifted. Find out which ones still work, then continue.
        console.warn('[ted] 400 on field set — probing which fields TED accepts:', err.message);
        const probe = await probeFields();
        fields = probe.working;
        degraded = probe.rejected.length > 0;
        if (probe.rejected.length) {
          console.warn('[ted] dropped rejected fields:', probe.rejected.join(', '));
        }
        continue;
      }
      throw err;
    }

    pages += 1;
    totalReported = Number(json.totalNoticeCount ?? json.total ?? 0) || totalReported;
    const batch: RawNotice[] = json.notices ?? json.results ?? [];
    if (!batch.length) break;

    for (const raw of batch) {
      const n = normalizeNotice(raw);
      if (n && !seen.has(n.id)) {
        seen.add(n.id);
        collected.push(n);
      }
    }

    if (batch.length < limit) break;
    page += 1;
    await sleep(config.ted.requestDelayMs);
  }

  return { notices: collected, pages, totalReported, source: 'ted', fieldsUsed: fields, query, degraded };
}
