# TenderPing — an autonomous tender-alert business

A complete, self-running micro-SaaS: it ingests every EU public procurement notice in the
IT/software sectors from the **official TED API**, matches each one against paying subscribers'
filters, emails them a plain-English brief, and bills them through Stripe. After setup it needs
roughly **10 minutes of attention per month**.

Everything in the stack is open source and free-tier. The only recurring costs are a domain and
a small VPS (~€6/month all-in).

---

## 1. Why this business

| | |
|---|---|
| **The pain** | TED publishes ~2,000 notices/day across 24 languages, indexed by 9,000+ CPV codes. Small IT suppliers cannot monitor it, so they miss contracts they could win. |
| **The proof people pay** | TenderChime £29/mo, Jorpex $49–$149/mo, Supply2Gov ~£95/mo, Tenders Direct / Tracker Intelligence £5,000+/yr, CleanTender £99/mo. Alert-only products are an established, priced category. |
| **Why it can be autonomous** | The input is a free, structured, government-maintained API with a stable publishing cadence. No scraping, no content treadmill, no human curation. |
| **Why it's defensible enough** | Not by data (it's public) but by *filtering quality + deduplication + inbox habit*. Churn on tender alerts is low: suppliers keep paying while they keep bidding. |
| **Legal footing** | TED data is reusable under [Commission Decision 2011/833/EU](https://eur-lex.europa.eu/eli/dec/2011/833/oj). The Search API is explicitly offered to reusers and requires no key. Attribution is built into every page and email. |

**Unit economics at €29/mo:** infra ~€6/mo total *regardless of subscriber count* (SQLite + one
container). Stripe takes ~1.5% + €0.25. Email is free up to 3,000/mo on Resend/Brevo free tiers.
So subscriber #1 covers all infrastructure; every subsequent one is ~96% margin.

```
 10 subscribers → €290/mo revenue → ~€277 net
 30 subscribers → €870/mo revenue → ~€830 net   (still on free email tier)
100 subscribers → €2,900/mo       → ~€2,750 net (add €20/mo email plan)
```

---

## 2. What's built

```
src/
  config.ts              all tuning via env vars, sane defaults
  server.ts              Fastify app: landing, SEO archive, account, checkout, webhook, ops
  cli.ts                 operator commands (ingest, digests, seed, preview, stats, check-ted)
  ingest/ted.ts          TED Search API v3 client: paging, backoff, field-schema fallback,
                         tolerant normaliser for TED's multilingual value maps
  core/db.ts             SQLite (node:sqlite — zero native deps), schema, job-run logging
  core/notices.ts        upsert + query layer
  core/match.ts          explainable relevance scoring (no LLM needed)
  core/subscribers.ts    subscribers, filter profiles, per-user delivery ledger
  core/summarize.ts      plain-language briefs; LLM optional with a hard daily budget cap
  core/mailer.ts         SMTP or safe "outbox" mode; per-run send cap
  core/templates.ts      HTML + text digest emails with RFC 8058 one-click unsubscribe
  core/billing.ts        Stripe checkout, billing portal, subscription lifecycle webhook
  core/tokens.ts         HMAC-signed settings/unsubscribe links (no passwords, no support load)
  jobs/index.ts          ingest, daily paid digest, weekly free digest, built-in scheduler
  web/views.ts           server-rendered pages, no JS framework, no build step for the frontend
test/                    22 tests: normaliser, matcher, tokens, dedupe, full digest pipeline
```

### The three loops that make it run itself

1. **Acquisition loop** — every ingested notice becomes a public, indexable page at `/tender/:id`
   with schema.org markup, plus `sitemap.xml` and `/feed.xml`. The archive grows ~2,000 pages a
   week on its own and pulls long-tail search traffic ("*Rahmenvertrag Softwareentwicklung
   Ausschreibung*"). Visitors convert to the free weekly digest.
2. **Conversion loop** — the free weekly digest shows the top 5 matches and states how many more
   matched, with a trial CTA. No manual marketing.
3. **Retention/billing loop** — Stripe handles trials, dunning, cancellation; the webhook mirrors
   status into the DB, and the digest audience is derived from that status. Nothing to reconcile.

### Design decisions that keep support load near zero

- **No passwords.** Every email carries an HMAC-signed private settings link.
- **Silence when empty.** No "0 new results" emails — the single biggest churn driver.
- **Never repeat a notice.** A per-subscriber delivery ledger guarantees it.
- **Explainable matches.** Each alert says *why* it matched, so users self-tune filters instead
  of emailing you.
- **Failure is visible, not silent.** Every job run is persisted and exposed on `/healthz`.
- **Cost guards everywhere.** Per-run email cap, daily LLM budget cap, notice cap per ingest.

---

## 3. Run it locally in 60 seconds

```bash
npm install
cp .env.example .env          # defaults are fine for local
echo "TED_OFFLINE=true"  >> .env
echo "MAIL_TRANSPORT=outbox" >> .env
echo "APP_SECRET=dev-secret"  >> .env

node scripts/make-fixtures.mjs 36   # realistic offline TED data
npm run cli -- seed
npm run cli -- add-subscriber you@example.com --cpv 72,48 --countries DEU --keywords cloud --pro
npm run cli -- preview you@example.com     # see scored matches + reasons
npm run cli -- digest-daily                # writes .eml files to data/outbox/
npm run dev                                # http://localhost:3000
```

`npm test` runs the suite; `npm run typecheck` runs strict TypeScript.

---

## 4. Go-live runbook (one evening)

1. **Domain** (~€10/yr). Point an A record at your VPS.
2. **VPS** — Hetzner CX22 ≈ €4/mo (Nuremberg/Falkenstein keeps you in EU data residency).
   ```bash
   git clone <this repo> && cd Playground
   cp .env.example .env && $EDITOR .env      # set APP_SECRET (openssl rand -hex 32), BASE_URL, brand, legal
   $EDITOR Caddyfile                         # your domain
   docker compose up -d
   ```
3. **Email sending** — sign up at Resend or Brevo (free tier), verify your domain, add **SPF,
   DKIM and DMARC** records. Put the SMTP URL in `SMTP_URL` and set `MAIL_TRANSPORT=smtp`.
   Deliverability *is* the product; do not skip DMARC.
4. **Stripe** — create a €29/mo recurring price, put its ID in `STRIPE_PRICE_ID`. Add a webhook
   endpoint at `https://yourdomain/stripe/webhook` for `checkout.session.completed`,
   `customer.subscription.*`, `invoice.payment_failed`; copy the signing secret into
   `STRIPE_WEBHOOK_SECRET`. Enable the Customer Portal so cancellations never reach you.
5. **Verify live data**: `./scripts/verify-live.sh` — confirms the TED API contract still holds.
6. **First fill**: `docker compose exec app node dist/cli.js ingest --days 14`
7. **Legal (Germany)**: the `/legal` page renders your Impressum + privacy text from
   `LEGAL_NAME` / `LEGAL_ADDRESS`. Register as *Kleinunternehmer* if applicable; Stripe Tax or
   manual VAT handling once you cross thresholds.

The container's built-in scheduler then runs ingest at 04:00 UTC, the paid digest at 05:00 UTC,
and the free weekly digest on Mondays. If you prefer external cron:

```bash
curl -X POST -H "x-ops-key: $APP_SECRET" https://yourdomain/ops/ingest
curl -X POST -H "x-ops-key: $APP_SECRET" https://yourdomain/ops/digest-daily
```

---

## 5. Getting the first paying subscribers

The machine runs itself; distribution is the part that needs you, and only at the start.

- **Seed the archive first.** `ingest --days 30` before launch so Google finds a real corpus.
- **Cold-start audience:** the notices themselves list *losing* bidders and buyers. Award notices
  (`can-standard`) name companies actively bidding in your sectors — a legitimate, highly
  qualified outreach list for a personal "we watch this for you" email.
- **Where these buyers hang out:** IT-Mittelstand LinkedIn groups, `r/germany`/`r/de` business
  threads, Bitkom / BVMW SME networks, freelance-Ausschreibung communities.
- **Free tier is the funnel.** Give the weekly digest away generously; it demonstrates match
  quality, which is the only thing that converts.
- **Highest-leverage upgrade later:** raise price for multi-country coverage (Pro €29 → Team €79
  with more sectors and Slack delivery) rather than chasing more subscribers.

---

## 6. Monthly maintenance (~10 min)

| Check | How |
|---|---|
| Jobs still succeeding | `GET /healthz` — last 8 job runs with stats and errors |
| TED contract unchanged | `npm run cli -- check-ted` (also runs in CI, non-blocking) |
| Deliverability | Your ESP dashboard: bounce < 2%, complaints < 0.1% |
| Revenue | Stripe dashboard |

**The one real fragility** is TED changing field names in the Search API. The client already
falls back to a minimal field set on HTTP 400, the normaliser tolerates missing fields, and
`check-ted` fails loudly in CI when the shape drifts — so a schema change degrades your alerts
rather than breaking the service.

---

## 7. Extending it

- **More sources, same pipeline:** add a client under `src/ingest/` that returns `Notice[]`
  (UK Contracts Finder, US SAM.gov, TenderNed, bund.de). Coverage breadth is exactly what the
  €49–€149/mo competitors charge for.
- **Slack/Teams delivery** — a webhook URL per subscriber; the highest-value asked-for feature.
- **Award-notice intelligence** — "who won, at what price" is a separate, more expensive product
  sold to the same audience, from data you already store.

---

Data source: Tenders Electronic Daily (TED), © European Union. This project is independent and
not affiliated with or endorsed by the European Union. The notice on ted.europa.eu is always the
legally binding version.

> **Note on CI:** the GitHub Actions workflow ships as
> `ci/github-actions-ci.yml` because this sandbox's GitHub App cannot create
> workflow files. Copy it to `.github/workflows/ci.yml` locally to enable tests + the live TED contract
> check on every push.
