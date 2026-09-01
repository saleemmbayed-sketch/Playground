/**
 * TED (Tenders Electronic Daily) Search API v3 client.
 *
 * Endpoint: POST https://api.ted.europa.eu/v3/notices/search  (anonymous, no API key)
 * Docs:     https://docs.ted.europa.eu/api/latest/search.html
 *
 * Verified constraints (see docs + TED reusers workshop material):
 *  - `limit` must be <= 100.
 *  - Field names are eForms kebab-case names, NOT the legacy two-letter TED codes.
 *  - Multilingual fields arrive as {"eng": [...], "deu": [...]} maps.
 *  - Notice permalink: https://ted.europa.eu/en/notice/-/detail/{publication-number}
 *  - PAGE_NUMBER pagination caps at 15,000 notices per query; ITERATION goes further.
 *
 * Because the expert-search grammar has changed across TED versions, this client does not
 * bet on a single query dialect: it walks a fallback chain of query strategies and remembers
 * which one worked, so a syntax change degrades to a broader query instead of returning zero.
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
  contractNature: string | null;
  publicationDate: string | null;
  deadlineDate: string | null;
  valueAmount: number | null;
  valueCurrency: string | null;
  description: string | null;
  urlHtml: string;
  language: string | null;
  /** Award-notice intelligence: who won, and the buyer's stable registry id. */
  winnerNames: string[];
  buyerIdentifier: string | null;
  isAward: boolean;
  raw: RawNotice;
}

/** Fields requested from TED, richest first. */
export const TED_FIELDS = [
  'publication-number',
  'notice-title',
  'notice-type',
  'contract-nature',
  'publication-date',
  'buyer-name',
  'buyer-country',
  'place-of-performance',
  'classification-cpv',
  'deadline',
  'deadline-receipt-tender-date-lot',
  'total-value',
  'total-value-cur',
  'estimated-value-lot',
  'description-lot',
  'description-proc',
  'notice-language',
  'links',
  // Award-notice intelligence. Present on can-* notices; harmless on others.
  'winner-name',
  'winner-identifier',
  'buyer-identifier',
] as const;

/** Fallback field set if TED rejects any optional field above. */
const TED_FIELDS_MINIMAL = [
  'publication-number',
  'notice-title',
  'publication-date',
  'buyer-name',
  'buyer-country',
  'classification-cpv',
  'deadline',
] as const;

const PREFERRED_LANGS = ['eng', 'deu', 'fra', 'en', 'de', 'fr'];

export const noticeUrl = (id: string): string =>
  `https://ted.europa.eu/en/notice/-/detail/${encodeURIComponent(id)}`;

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
    for (const v of Object.values(obj)) {
      const got = collectStrings(v);
      if (got.length) return got;
    }
  }
  return [];
}

/** TED joins per-lot values with ';'. Splits, trims and de-duplicates them. */
export function splitMulti(value: unknown, maxItems = 25): string[] {
  const text = pickText(value, 4000);
  if (!text) return [];
  const seen = new Set<string>();
  for (const part of text.split(';')) {
    const clean = part.trim().replace(/\s+/g, ' ');
    if (clean && clean.length <= 200) seen.add(clean);
    if (seen.size >= maxItems) break;
  }
  return [...seen];
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
      const compact = s.match(/\b(\d{4})(\d{2})(\d{2})\b/);
      if (compact) return `${compact[1]}-${compact[2]}-${compact[3]}`;
    }
  }
  return null;
}

/**
 * Parses money written in any European convention:
 *   "360 000,00EUR" -> 360000    "1,250,000.50 GBP" -> 1250000.5
 *   "1.250.000,00"  -> 1250000   "2400000"          -> 2400000
 * The separator that appears LAST is the decimal separator; the other is grouping.
 */
export function parseAmount(input: string): number | null {
  const cleaned = input.replace(/[^\d.,]/g, '');
  if (!cleaned) return null;

  const lastDot = cleaned.lastIndexOf('.');
  const lastComma = cleaned.lastIndexOf(',');
  let normalized: string;

  if (lastDot >= 0 && lastComma >= 0) {
    const decimalSep = lastDot > lastComma ? '.' : ',';
    const groupSep = decimalSep === '.' ? ',' : '.';
    normalized = cleaned.split(groupSep).join('').replace(decimalSep, '.');
  } else if (lastComma >= 0) {
    const decimals = cleaned.length - lastComma - 1;
    // "1,50" is a decimal; "1,250" and "1,250,000" are thousands groups.
    normalized = decimals <= 2 && cleaned.indexOf(',') === lastComma
      ? cleaned.replace(',', '.')
      : cleaned.split(',').join('');
  } else if (lastDot >= 0) {
    const decimals = cleaned.length - lastDot - 1;
    normalized = decimals === 3 && cleaned.indexOf('.') === lastDot
      ? cleaned.split('.').join('') // "1.250" = European thousands
      : cleaned.split('.').slice(0, -1).join('') + '.' + cleaned.split('.').pop();
  } else {
    normalized = cleaned;
  }

  const n = Number.parseFloat(normalized);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function firstNumber(...values: unknown[]): number | null {
  for (const v of values) {
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v;
    // Objects like {amount: 360000, currency: 'EUR'} are common in TED payloads.
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const amount = (v as Record<string, unknown>).amount;
      if (typeof amount === 'number' && amount > 0) return amount;
      if (typeof amount === 'string') {
        const parsed = parseAmount(amount);
        if (parsed != null) return parsed;
      }
    }
    if (Array.isArray(v)) {
      const nested = firstNumber(...v);
      if (nested != null) return nested;
    }
    for (const s of collectStrings(v)) {
      const parsed = parseAmount(s.replace(/\s/g, ''));
      if (parsed != null) return parsed;
    }
  }
  return null;
}

function firstCurrency(...values: unknown[]): string | null {
  for (const v of values) {
    if (Array.isArray(v)) {
      const nested = firstCurrency(...v);
      if (nested) return nested;
      continue;
    }
    if (v && typeof v === 'object') {
      const cur = (v as Record<string, unknown>).currency;
      if (typeof cur === 'string' && cur.trim()) return cur.trim().toUpperCase();
    }
    for (const s of collectStrings(v)) {
      const m = s.match(/\b(EUR|USD|GBP|CHF|SEK|DKK|NOK|PLN|CZK|HUF|RON|BGN|ISK|HRK)\b/i);
      if (m?.[1]) return m[1].toUpperCase();
    }
  }
  return null;
}

/** Prefers the HTML permalink TED itself hands back, falls back to the documented pattern. */
function extractUrl(raw: RawNotice, id: string): string {
  const links = raw['links'];
  if (links && typeof links === 'object') {
    const flat = JSON.stringify(links);
    const m = flat.match(/https:\/\/ted\.europa\.eu\/[^"']*?\/notice\/[^"']*?(?:detail|html)[^"']*/i);
    if (m) return m[0];
  }
  return noticeUrl(id);
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

  const noticeType = pickText(raw['notice-type'], 80);
  // TED joins multi-lot winners with ';' — split so each supplier is queryable.
  const winnerNames = splitMulti(raw['winner-name']);
  // can-* = contract award notice: the only notice type that names a winner.
  const isAward = Boolean(noticeType?.toLowerCase().startsWith('can')) || winnerNames.length > 0;

  return {
    id,
    title,
    buyerName: pickText(raw['buyer-name'], 300),
    buyerCountry: (collectCodes(raw['buyer-country'])[0] ?? null) as string | null,
    placeNuts: nuts,
    cpv,
    cpvMain: cpv[0] ?? null,
    noticeType,
    winnerNames,
    buyerIdentifier: pickText(raw['buyer-identifier'], 80),
    isAward,
    contractNature: pickText(raw['contract-nature'], 40),
    publicationDate: firstDate(raw['publication-date']),
    deadlineDate: firstDate(
      raw['deadline'],
      raw['deadline-receipt-tender-date-lot'],
      raw['deadline-receipt-request'],
    ),
    valueAmount: firstNumber(raw['total-value'], raw['estimated-value-lot']),
    valueCurrency:
      firstCurrency(raw['total-value-cur'], raw['total-value'], raw['estimated-value-lot']) ?? 'EUR',
    description,
    urlHtml: extractUrl(raw, id),
    language: pickText(raw['notice-language'], 10),
    raw,
  };
}

// ---------------------------------------------------------------- queries

const compactDate = (daysAgo: number): string =>
  new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10).replace(/-/g, '');

export interface QueryStrategy {
  name: string;
  build: (lookbackDays: number) => string;
}

/**
 * Ordered from most precise to most permissive. The client walks this list until one
 * strategy returns notices, so a grammar change costs precision, never availability.
 */
export function queryStrategies(): QueryStrategy[] {
  const cpvGroup = (): string => {
    const fams = config.ted.cpvFamilies.map((f) => f.replace(/\D/g, '')).filter(Boolean);
    if (!fams.length) return '';
    return `(${fams.map((f) => `classification-cpv=${f}*`).join(' OR ')})`;
  };
  const countryGroup = (): string => {
    const cs = config.ted.countries;
    if (!cs.length) return '';
    return `(${cs.map((c) => `buyer-country=${c}`).join(' OR ')})`;
  };

  return [
    {
      // Documented eForms grammar: field=value, PD>=YYYYMMDD, explicit OR groups.
      name: 'eforms-equals',
      build: (d) =>
        [`PD>=${compactDate(d)}`, cpvGroup(), countryGroup()]
          .filter(Boolean)
          .join(' AND ') + ' SORT BY publication-date DESC',
    },
    {
      // Set syntax used by TED's own expert-search UI.
      name: 'eforms-in',
      build: (d) => {
        const parts = [`publication-date >= today(-${d})`];
        const fams = config.ted.cpvFamilies.map((f) => f.replace(/\D/g, '')).filter(Boolean);
        if (fams.length) parts.push(`classification-cpv IN (${fams.map((f) => `${f}*`).join(' ')})`);
        if (config.ted.countries.length) {
          parts.push(`buyer-country IN (${config.ted.countries.join(' ')})`);
        }
        return parts.join(' AND ');
      },
    },
    {
      // No CPV/country filter — we filter client-side. Last resort, always valid.
      name: 'date-only',
      build: (d) => `PD>=${compactDate(d)} SORT BY publication-date DESC`,
    },
  ];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
    // Network flake / timeout: retry with backoff before giving up.
    if (attempt >= 3) throw err;
    await sleep(Math.min(20_000, 1000 * 2 ** attempt));
    return postSearch(body, attempt + 1);
  }

  if (res.status === 429 || res.status >= 500) {
    if (attempt >= 4) throw new Error(`TED API ${res.status} after retries`);
    await sleep(Math.min(30_000, 1000 * 2 ** attempt));
    return postSearch(body, attempt + 1);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`TED API ${res.status}: ${text.slice(0, 400)}`);
    (err as any).status = res.status;
    throw err;
  }
  return res.json();
}

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

/** Client-side safety net: TED's own filter may be absent under the 'date-only' strategy. */
export function matchesNiche(n: Notice): boolean {
  const fams = config.ted.cpvFamilies.map((f) => f.replace(/\D/g, '')).filter(Boolean);
  const cpvOk = !fams.length || n.cpv.some((c) => fams.some((f) => c.startsWith(f)));
  const countryOk =
    !config.ted.countries.length ||
    !n.buyerCountry ||
    config.ted.countries.includes(n.buyerCountry.toUpperCase());
  return cpvOk && countryOk;
}

export interface FetchResult {
  notices: Notice[];
  pages: number;
  totalReported: number;
  source: 'ted' | 'fixtures';
  strategy: string;
  fieldSet: 'full' | 'minimal';
  discarded: number;
}

/** TED notice types that carry a named winner (contract award notices). */
export const AWARD_NOTICE_TYPES = ['can-standard', 'can-social', 'can-desg', 'can-tran'] as const;

/**
 * Rewrites competition strategies into award-notice strategies: same CPV/country
 * filters, but restricted to can-* notices. Awards are historical, so the caller
 * must also widen the scope to ALL (ACTIVE only covers currently-open notices).
 */
export function awardStrategies(): QueryStrategy[] {
  const clause = `notice-type IN (${AWARD_NOTICE_TYPES.join(' ')})`;
  return queryStrategies().map((s) => ({
    name: `award-${s.name}`,
    build: (d: number) => {
      const base = s.build(d);
      const [head, ...sortTail] = base.split(' SORT BY ');
      const sorted = sortTail.length ? ` SORT BY ${sortTail.join(' SORT BY ')}` : '';
      return `${head} AND ${clause}${sorted}`;
    },
  }));
}

async function fetchWithStrategy(
  strategy: QueryStrategy,
  lookbackDays: number,
  scope: 'ACTIVE' | 'ALL' = 'ACTIVE',
): Promise<Omit<FetchResult, 'source'>> {
  const query = strategy.build(lookbackDays);
  const collected: Notice[] = [];
  const seen = new Set<string>();
  let fields: readonly string[] = TED_FIELDS;
  let fieldSet: 'full' | 'minimal' = 'full';
  let page = 1;
  let pages = 0;
  let totalReported = 0;
  let discarded = 0;
  const limit = Math.min(Math.max(1, config.ted.pageSize), 100); // TED hard cap

  while (collected.length < config.ted.maxNotices) {
    const body = {
      query,
      fields: [...fields],
      page,
      limit,
      scope,
      paginationMode: 'PAGE_NUMBER',
      onlyLatestVersions: true,
    };

    let json: any;
    try {
      json = await postSearch(body);
    } catch (err) {
      if ((err as any).status === 400 && fieldSet === 'full') {
        console.warn(`[ted] field set rejected (${(err as Error).message}); retrying minimal fields`);
        fields = TED_FIELDS_MINIMAL;
        fieldSet = 'minimal';
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
      if (!n || seen.has(n.id)) continue;
      seen.add(n.id);
      if (!matchesNiche(n)) {
        discarded += 1;
        continue;
      }
      collected.push(n);
    }

    if (batch.length < limit) break;
    page += 1;
    await sleep(config.ted.requestDelayMs);
  }

  return { notices: collected, pages, totalReported, strategy: strategy.name, fieldSet, discarded };
}

async function runFetch(
  strategies: QueryStrategy[],
  lookbackDays: number,
  scope: 'ACTIVE' | 'ALL',
  keep: (n: Notice) => boolean,
): Promise<FetchResult> {
  if (config.ted.offline) {
    const all = loadFixtures().map(normalizeNotice).filter((n): n is Notice => n !== null);
    const notices = all.filter((n) => matchesNiche(n) && keep(n));
    return {
      notices, pages: 1, totalReported: notices.length, source: 'fixtures',
      strategy: 'fixtures', fieldSet: 'full', discarded: all.length - notices.length,
    };
  }

  const errors: string[] = [];
  for (const strategy of strategies) {
    try {
      const res = await fetchWithStrategy(strategy, lookbackDays, scope);
      const notices = res.notices.filter(keep);
      if (notices.length > 0) return { ...res, notices, source: 'ted' };
      errors.push(`${strategy.name}: 0 notices`);
      console.warn(`[ted] strategy "${strategy.name}" returned nothing, trying next`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`${strategy.name}: ${msg}`);
      console.warn(`[ted] strategy "${strategy.name}" failed: ${msg}`);
    }
  }
  throw new Error(`All TED query strategies failed — ${errors.join(' | ')}`);
}

/** Open competitions — the daily alert feed. */
export async function fetchNotices(opts: { lookbackDays?: number } = {}): Promise<FetchResult> {
  return runFetch(
    queryStrategies(),
    opts.lookbackDays ?? config.ted.lookbackDays,
    'ACTIVE',
    () => true,
  );
}

/**
 * Historical contract award notices — the raw material for Re-tender Radar.
 * Defaults to a 5-year lookback so that at least one full framework cycle
 * (capped at 4 years by Art. 33(1) of Directive 2014/24/EU) is observable.
 */
export async function fetchAwards(opts: { lookbackDays?: number } = {}): Promise<FetchResult> {
  return runFetch(
    awardStrategies(),
    opts.lookbackDays ?? config.ted.awardLookbackDays,
    'ALL',
    (n) => n.isAward,
  );
}
