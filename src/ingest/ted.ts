/**
 * TED (Tenders Electronic Daily) Search API v3 client.
 *
 * Docs:  https://docs.ted.europa.eu/api/latest/search.html
 * Endpoint: POST https://api.ted.europa.eu/v3/notices/search  (anonymous, no API key)
 *
 * The API is generous but asks for polite usage (fair-usage policy), so this client
 * pages sequentially with a delay and a hard cap on notices per run.
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

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
  raw: RawNotice;
}

/** Fields requested from TED. Kept in one place so a schema change is a one-line fix. */
export const TED_FIELDS = [
  'publication-number',
  'notice-title',
  'notice-type',
  'publication-date',
  'buyer-name',
  'buyer-country',
  'place-of-performance',
  'classification-cpv',
  'deadline-receipt-tender-date-lot',
  'deadline-receipt-request',
  'total-value',
  'estimated-value-lot',
  'description-lot',
  'description-proc',
  'notice-language',
] as const;

/** Minimal field set used as a fallback if TED rejects one of the optional fields. */
const TED_FIELDS_MINIMAL = [
  'publication-number',
  'notice-title',
  'publication-date',
  'buyer-name',
  'buyer-country',
  'classification-cpv',
] as const;

const PREFERRED_LANGS = ['eng', 'deu', 'fra', 'en', 'de', 'fr'];

/** TED returns strings, arrays, or {lang: [values]} maps depending on the field. */
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
    // Unknown language map or nested structure: take the first non-empty branch.
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
      const m = s.match(/\d{4}-\d{2}-\d{2}/);
      if (m) return m[0];
    }
  }
  return null;
}

function firstNumber(...values: unknown[]): number | null {
  for (const v of values) {
    for (const s of collectStrings(v)) {
      const cleaned = s.replace(/[^\d.,-]/g, '').replace(/,(?=\d{3}\b)/g, '');
      const n = Number.parseFloat(cleaned.replace(',', '.'));
      if (Number.isFinite(n) && n > 0) return n;
    }
  }
  return null;
}

function firstCurrency(...values: unknown[]): string | null {
  for (const v of values) {
    for (const s of collectStrings(v)) {
      const m = s.match(/\b(EUR|USD|GBP|CHF|SEK|DKK|NOK|PLN|CZK|HUF|RON|BGN)\b/i);
      if (m?.[1]) return m[1].toUpperCase();
    }
  }
  return null;
}

export function normalizeNotice(raw: RawNotice): Notice | null {
  const id = pickText(raw['publication-number'] ?? raw['ND'] ?? raw['publicationNumber'], 40);
  if (!id) return null;

  const cpv = collectCodes(raw['classification-cpv'] ?? raw['cpv']).filter((c) => /^\d{4,8}$/.test(c));
  const nuts = collectCodes(raw['place-of-performance'] ?? raw['place-of-performance-country-part'])
    .filter((c) => /^[A-Z]{2}[0-9A-Z]{0,3}$/.test(c));
  const title = pickText(raw['notice-title'] ?? raw['title'], 500) ?? `TED notice ${id}`;
  const description =
    pickText(raw['description-lot'] ?? raw['description-proc'] ?? raw['notice-description'], 4000);

  return {
    id,
    title,
    buyerName: pickText(raw['buyer-name'], 300),
    buyerCountry: (collectCodes(raw['buyer-country'])[0] ?? null) as string | null,
    placeNuts: nuts,
    cpv,
    cpvMain: cpv[0] ?? null,
    noticeType: pickText(raw['notice-type'], 80),
    publicationDate: firstDate(raw['publication-date']),
    deadlineDate: firstDate(
      raw['deadline-receipt-tender-date-lot'],
      raw['deadline-receipt-request'],
      raw['deadline'],
    ),
    valueAmount: firstNumber(raw['total-value'], raw['estimated-value-lot']),
    valueCurrency: firstCurrency(raw['total-value'], raw['estimated-value-lot']) ?? 'EUR',
    description,
    urlHtml: `https://ted.europa.eu/en/notice/${encodeURIComponent(id)}/html`,
    language: pickText(raw['notice-language'], 10),
    raw,
  };
}

/** Builds a TED expert query for the configured niche. */
export function buildQuery(lookbackDays: number): string {
  const parts: string[] = [`publication-date >= today(-${Math.max(1, lookbackDays)})`];

  const cpvList = config.ted.cpvFamilies
    .map((f) => f.replace(/\D/g, ''))
    .filter(Boolean)
    .map((f) => `${f.padEnd(2, '0').slice(0, 2)}*`);
  if (cpvList.length) {
    parts.push(`classification-cpv IN (${cpvList.join(' ')})`);
  }
  if (config.ted.countries.length) {
    parts.push(`buyer-country IN (${config.ted.countries.join(' ')})`);
  }
  return parts.join(' AND ');
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function postSearch(body: unknown, attempt = 0): Promise<any> {
  const res = await fetch(config.ted.endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': config.ted.userAgent,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(45_000),
  });

  if (res.status === 429 || res.status >= 500) {
    if (attempt >= 4) throw new Error(`TED API ${res.status} after retries`);
    const wait = Math.min(30_000, 1000 * 2 ** attempt);
    await sleep(wait);
    return postSearch(body, attempt + 1);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`TED API ${res.status}: ${text.slice(0, 500)}`);
    (err as any).status = res.status;
    throw err;
  }
  return res.json();
}

/** Reads fixture notices instead of calling the network (offline dev / CI). */
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
}

export async function fetchNotices(opts: { lookbackDays?: number } = {}): Promise<FetchResult> {
  const lookbackDays = opts.lookbackDays ?? config.ted.lookbackDays;

  if (config.ted.offline) {
    const notices = loadFixtures()
      .map(normalizeNotice)
      .filter((n): n is Notice => n !== null);
    return { notices, pages: 1, totalReported: notices.length, source: 'fixtures' };
  }

  const query = buildQuery(lookbackDays);
  const collected: Notice[] = [];
  const seen = new Set<string>();
  let fields: readonly string[] = TED_FIELDS;
  let page = 1;
  let pages = 0;
  let totalReported = 0;

  while (collected.length < config.ted.maxNotices) {
    const body = {
      query,
      fields: [...fields],
      page,
      limit: Math.min(config.ted.pageSize, 250),
      scope: 'ACTIVE',
      paginationMode: 'PAGE_NUMBER',
      onlyLatestVersions: true,
    };

    let json: any;
    try {
      json = await postSearch(body);
    } catch (err) {
      // A 400 usually means TED renamed/removed a field: degrade to the minimal set once.
      if ((err as any).status === 400 && fields !== TED_FIELDS_MINIMAL) {
        console.warn('[ted] field set rejected, retrying with minimal fields:', (err as Error).message);
        fields = TED_FIELDS_MINIMAL;
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

    if (batch.length < body.limit) break;
    page += 1;
    await sleep(config.ted.requestDelayMs);
  }

  return { notices: collected, pages, totalReported, source: 'ted' };
}
