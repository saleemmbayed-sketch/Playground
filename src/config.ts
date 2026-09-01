import 'dotenv/config';
import path from 'node:path';

const bool = (v: string | undefined, dflt = false): boolean =>
  v === undefined ? dflt : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());

const int = (v: string | undefined, dflt: number): number => {
  const n = Number.parseInt(v ?? '', 10);
  return Number.isFinite(n) ? n : dflt;
};

export const config = {
  env: process.env.NODE_ENV ?? 'development',
  /** Public base URL, used in emails, sitemap and Stripe redirects. */
  baseUrl: (process.env.BASE_URL ?? 'http://localhost:3000').replace(/\/$/, ''),
  port: int(process.env.PORT, 3000),
  host: process.env.HOST ?? '0.0.0.0',

  brand: {
    name: process.env.BRAND_NAME ?? 'TenderPing',
    tagline:
      process.env.BRAND_TAGLINE ??
      'Every new EU public IT & software tender, filtered to the ones you could actually win.',
    fromEmail: process.env.FROM_EMAIL ?? 'alerts@localhost',
    replyTo: process.env.REPLY_TO ?? process.env.FROM_EMAIL ?? 'alerts@localhost',
    legalName: process.env.LEGAL_NAME ?? 'TenderPing (sole trader)',
    legalAddress: process.env.LEGAL_ADDRESS ?? 'Set LEGAL_ADDRESS in .env',
  },

  db: {
    file: process.env.DB_FILE ?? path.resolve(process.cwd(), 'data/tenderping.db'),
  },

  ted: {
    endpoint: process.env.TED_ENDPOINT ?? 'https://api.ted.europa.eu/v3/notices/search',
    /** Days of publication history to pull on each ingest run. */
    lookbackDays: int(process.env.TED_LOOKBACK_DAYS, 2),
    /**
     * Days of award history for Re-tender Radar. Default 5 years: frameworks are
     * capped at 4 years by Art. 33(1) of Directive 2014/24/EU, so a 5-year window
     * reliably contains at least one completed cycle per buyer.
     */
    awardLookbackDays: int(process.env.TED_AWARD_LOOKBACK_DAYS, 1825),
    /** Max notices per ingest run (safety valve against runaway pagination). */
    maxNotices: int(process.env.TED_MAX_NOTICES, 1500),
    pageSize: int(process.env.TED_PAGE_SIZE, 100),
    /** Polite delay between paged requests, ms (TED fair-usage policy). */
    requestDelayMs: int(process.env.TED_REQUEST_DELAY_MS, 400),
    /** CPV families we ingest. Everything else is out of scope for this niche. */
    cpvFamilies: (process.env.TED_CPV_FAMILIES ?? '72,48,30,79,71,32,73,80')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    /** Optional country restriction, ISO3 codes as used by TED (e.g. DEU,AUT,CHE). */
    countries: (process.env.TED_COUNTRIES ?? '')
      .split(',')
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean),
    /** When true, ingest reads data/fixtures instead of the network (offline dev). */
    offline: bool(process.env.TED_OFFLINE, false),
    userAgent:
      process.env.TED_USER_AGENT ??
      'TenderPing/0.1 (+https://github.com/; tender alert service; contact via website)',
  },

  mail: {
    /** 'smtp' sends for real, 'outbox' writes .eml files to data/outbox (safe default). */
    transport: (process.env.MAIL_TRANSPORT ?? 'outbox') as 'smtp' | 'outbox',
    smtpUrl: process.env.SMTP_URL ?? '',
    /** Hard cap per run so a bug can never burn an entire sending quota. */
    maxPerRun: int(process.env.MAIL_MAX_PER_RUN, 200),
  },

  llm: {
    /** Optional. Without a key the service degrades to deterministic summaries. */
    apiKey: process.env.LLM_API_KEY ?? '',
    baseUrl: process.env.LLM_BASE_URL ?? 'https://api.openai.com/v1',
    model: process.env.LLM_MODEL ?? 'gpt-4o-mini',
    /** Daily spend guard: max notices enriched per day. */
    maxEnrichPerDay: int(process.env.LLM_MAX_ENRICH_PER_DAY, 120),
  },

  stripe: {
    secretKey: process.env.STRIPE_SECRET_KEY ?? '',
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET ?? '',
    priceId: process.env.STRIPE_PRICE_ID ?? '',
    /** Price for the Edge tier (Re-tender Radar + buyer intel). */
    edgePriceId: process.env.STRIPE_EDGE_PRICE_ID ?? '',
    portalReturnPath: '/account',
  },

  billing: {
    priceLabel: process.env.PRICE_LABEL ?? '€29 / month',
    edgePriceLabel: process.env.EDGE_PRICE_LABEL ?? '€79 / month',
    trialDays: int(process.env.TRIAL_DAYS, 14),
  },

  radar: {
    /**
     * Default assumed contract cycle when a buyer has only one observed award.
     * 48 months = the legal ceiling for framework agreements (Art. 33(1),
     * Directive 2014/24/EU); most public frameworks run the full term.
     */
     defaultCycleMonths: int(process.env.RADAR_DEFAULT_CYCLE_MONTHS, 48),
    /**
     * Re-let competitions are published 6-12 months before the incumbent
     * contract expires, so the actionable window opens 12 months out.
     */
    windowOpensMonthsBefore: int(process.env.RADAR_WINDOW_OPEN_MONTHS, 12),
    windowClosesMonthsBefore: int(process.env.RADAR_WINDOW_CLOSE_MONTHS, 6),
    /** How far ahead the radar lists forecasts. */
    horizonMonths: int(process.env.RADAR_HORIZON_MONTHS, 18),
    /** Ignore awards below this value — noise, not pipeline. */
    minValue: int(process.env.RADAR_MIN_VALUE, 25000),
    /**
     * How many forecasts are shown in full to non-subscribers. This is a fixed
     * global set (see showcaseForecastIds), not "the first N of the current
     * list", so filtering or browsing buyer pages cannot widen it.
     */
    showcaseCount: int(process.env.RADAR_SHOWCASE_COUNT, 3),
  },

  security: {
    /** Used to sign unsubscribe / magic-link tokens. MUST be set in production. */
    secret: process.env.APP_SECRET ?? 'dev-insecure-secret-change-me',
  },

  jobs: {
    /** Enable the in-process scheduler (single-box deployments). */
    enabled: bool(process.env.SCHEDULER_ENABLED, true),
    /** UTC hour for the daily ingest + digest run. */
    ingestHourUtc: int(process.env.INGEST_HOUR_UTC, 4),
    digestHourUtc: int(process.env.DIGEST_HOUR_UTC, 5),
    /** Weekday (0=Sun) for the free weekly public digest. */
    weeklyDigestDay: int(process.env.WEEKLY_DIGEST_DAY, 1),
  },
} as const;

export const isProd = config.env === 'production';
