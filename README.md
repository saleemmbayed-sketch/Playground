# TenderPing — an autonomous tender-alert business

A complete, self-running micro-SaaS: it ingests every EU public procurement notice in the
IT/software sectors from the **official TED API**, matches each one against paying subscribers'
filters, emails them a plain-English brief, and bills them through Stripe. After setup it needs
roughly **10 minutes of attention per month**.

Its hero feature, **Re-tender Radar**, forecasts contracts *before they are published* — see
[§1.1](#11-the-hero-feature-re-tender-radar).

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

### 1.1 The hero feature: Re-tender Radar

Everything above describes a good alerting product. Alerting is also a commodity — a dozen
companies sell it, and a saved TED search is a free substitute. **Re-tender Radar is the part
competitors cannot copy from the same public feed without building the same model.**

**The claim:** *see tenders 6–12 months before they are published.*

**Why that is possible, not marketing:**

1. A **contract award notice** is a countdown timer. It is published when a contract is signed,
   and it names the winner, the buyer and the value.
2. EU **framework agreements may not run longer than four years** — Article 33(1) of
   [Directive 2014/24/EU](https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=celex%3A32014L0024):
   *"the term of a framework agreement shall not exceed four years, save in exceptional cases duly
   justified"*. The clock starts at the award.
3. When it expires the buyer **must re-compete the work**, and the replacement competition is
   normally published **6–12 months before expiry**.

So for every buyer we measure how often they actually re-buy in each CPV family, project the next
competition, and publish it as a forecast **with the reasoning shown**:

```
Comune di Milano — CPV 72 — confidence 90%
  Expected back on the market 2027-01-15 → 2027-07-15
  Incumbent: Computacenter AG & Co. oHG · Last value: 469,200 EUR · Cycle: 36 months (observed)
  Why: re-tendered CPV 72 three times since 2019-01, on average every 36 months ·
       last awarded 2025-01-15, so the contract is projected to expire around 2028-01-15 ·
       replacement competitions are normally published 6-12 months before expiry ·
       the buyer re-tenders on a highly regular cycle
```

**Why it makes money:**

| Lever | Effect |
|---|---|
| **Premium tier** | Alerts sell for €29. Foresight sells for €79. Same infrastructure, same data pull. |
| **Retention** | An alert is skimmed and deleted; a pipeline is checked every month. Radar changes the product from a notification into a planning tool. |
| **Sales cycle** | By the time a tender is published, the budget is fixed and the scope is written — often with the incumbent's help. Radar puts the customer in the room *before* that, which is legal and expected. |
| **SEO** | Every contracting authority gets a `/buyer/:slug` page with award history, a supplier league table and its forecast. That is a large body of genuinely unique pages, because nobody else publishes derived re-tender intelligence. |
| **Proof of demand** | Tenders Direct already sells "advance re-tender alerts on frameworks and DPS" as a premium feature — the category is validated. |

**Honesty guardrails.** Forecasts are labelled as statistical estimates, never announcements.
Every card shows its confidence score and the reasons behind it, a single award falls back to the
4-year legal ceiling with visibly lower confidence, and a forecast is retired automatically once a
matching notice is actually published inside its predicted window.

**Unit economics at €29/mo (Pro) and €79/mo (Edge):** infra ~€6/mo total *regardless of subscriber count* (SQLite + one
container). Stripe takes ~1.5% + €0.25. Email is free up to 3,000/mo on Resend/Brevo free tiers.
So subscriber #1 covers all infrastructure; every subsequent one is ~96% margin.

```
 10 Pro                → €290/mo   → ~€277 net
 30 Pro                → €870/mo   → ~€830 net    (still on free email tier)
100 Pro                → €2,900/mo → ~€2,750 net  (add €20/mo email plan)

With Radar as the upsell (a conservative 20% of subscribers take Edge):
 30 subs = 24 Pro + 6 Edge  → €696 + €474 = €1,170/mo  (+34% on the same traffic)
100 subs = 80 Pro + 20 Edge → €2,320 + €1,580 = €3,900/mo (+34%)
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
  core/radar.ts          Re-tender Radar: the forecasting engine (pure, deterministic)
  core/intel.ts          buyer profiles and supplier league tables from award notices
  core/subscribers.ts    subscribers, filter profiles, per-user delivery ledger
  core/summarize.ts      plain-language briefs; LLM optional with a hard daily budget cap
  core/mailer.ts         SMTP or safe "outbox" mode; per-run send cap
  core/templates.ts      HTML + text digest emails with RFC 8058 one-click unsubscribe
  core/billing.ts        Stripe checkout, billing portal, subscription lifecycle webhook
  core/tokens.ts         HMAC-signed settings/unsubscribe links (no passwords, no support load)
  jobs/index.ts          ingest, daily paid digest, weekly free digest, monthly award ingest
                         + radar digest, built-in scheduler
  web/views.ts           server-rendered pages, no JS framework, no build step for the frontend
  web/ratelimit.ts       in-memory rate limiting for public forms
test/                    92 tests: normaliser, money parsing, matcher, tokens, dedupe,
                         opt-in gating, suppression, backups, every HTTP route,
                         signature-verified Stripe webhooks, and the full forecasting
                         engine (cycle detection, confidence, paywall redaction)
```

### The three loops that make it run itself

1. **Acquisition loop** — every ingested notice becomes a public, indexable page at `/tender/:id`
   with schema.org markup, plus `sitemap.xml` and `/feed.xml`. The archive grows ~2,000 pages a
   week on its own and pulls long-tail search traffic ("*Rahmenvertrag Softwareentwicklung
   Ausschreibung*"). Visitors convert to the free weekly digest.
2. **Conversion loop** — the free weekly digest shows the top 5 matches and states how many more
   matched, with a trial CTA. Once a month the free Radar teaser shows *one* real forecast and
   locks the rest — the strongest upgrade prompt in the product, because the locked rows are
   information no competitor is selling. No manual marketing.
3. **Foresight loop** — a monthly pass over TED award notices rebuilds the forecast table, which
   feeds `/radar`, every `/buyer/:slug` page and the Edge email. Awards move slowly, so this is one
   extra API pass per month for the feature that carries the premium tier.
4. **Retention/billing loop** — Stripe handles trials, dunning, cancellation; the webhook mirrors
   status into the DB, and the digest audience is derived from that status. Nothing to reconcile.

### Compliance and deliverability (built in, not bolted on)

- **Double opt-in.** A signup stores the address unconfirmed and sends exactly one
  confirmation email. Nothing else is ever sent until the user clicks. Required under
  GDPR + German UWG §7, and the strongest possible protection for sender reputation.
- **Automatic suppression.** Hard bounces and spam complaints — via SMTP 5xx responses or
  your ESP's webhook at `/mail/webhook` — permanently remove an address from every audience.
- **One-click unsubscribe** (RFC 8058 `List-Unsubscribe-Post`), as Gmail and Yahoo now require.
- **Rate limiting + honeypot** on every public form.
- **Impressum and reuse attribution** rendered on every page and email from your env vars.

### Design decisions that keep support load near zero

- **No passwords.** Every email carries an HMAC-signed private settings link.
- **Silence when empty.** No "0 new results" emails — the single biggest churn driver.
- **Never repeat a notice.** A per-subscriber delivery ledger guarantees it.
- **Explainable matches.** Each alert says *why* it matched, so users self-tune filters instead
  of emailing you.
- **Failure is visible, not silent.** Every job run is persisted and exposed on `/healthz`,
  which distinguishes a quiet day from a broken one (a send failure is counted as `failed`,
  never as "nothing to send").
- **Failures are isolated and retried.** One refused recipient cannot abort the run for
  everyone else, and an undelivered digest is not marked delivered — so the next run
  catches that subscriber up automatically.
- **Duplicate-safe billing.** Stripe retries webhooks for days; each event id is claimed
  once, so a replay cannot double-apply a subscription change.
- **Clean shutdown.** SIGTERM drains in-flight requests and checkpoints the SQLite WAL,
  so redeploys and restarts never corrupt or lose the last writes.
- **Cost guards everywhere.** Per-run email cap, daily LLM budget cap, notice cap per ingest.
- **It tells you when it breaks.** A failed job emails the operator once per day per job.
- **It backs itself up.** Nightly `VACUUM INTO` snapshot, 14 kept, verified by a test that
  reopens the snapshot and reads from it.
- **It prunes itself.** Stale notices and old logs are dropped weekly, so the box never fills.

---

## 3. Run it locally in 60 seconds

```bash
npm install
npm run demo          # fixtures + seed + a paying subscriber + a generated digest
npm run dev           # http://localhost:3000
```

`npm run demo` prints the demo account's private settings link and writes the generated
emails to `data/outbox/*.eml` so you can read exactly what a subscriber receives.

Useful commands:

```bash
npm test                     # 57 tests, no network required
npm run typecheck            # strict TypeScript
npm run setup                # interactive wizard: writes a complete .env, generates APP_SECRET
npm run cli -- setup-stripe  # creates product, price, webhook and portal; writes IDs into .env
npm run cli -- doctor        # pre-launch readiness check
npm run cli -- preview you@example.com    # score today's pool for one subscriber
npm run cli -- check-ted     # live TED API contract smoke test (needs internet)
npm run cli -- ingest-awards # pull historical award notices (the Radar input)
npm run cli -- radar         # rebuild forecasts from stored awards (no network)
npm run cli -- radar-digest  # send the monthly Re-tender Radar email
npm run cli                  # list every command
```

Admin dashboard: `http://localhost:3000/admin?key=$APP_SECRET`.

---

## 4. Go-live runbook (one evening)

> The step-by-step version with tick boxes is in **[LAUNCH.md](LAUNCH.md)**.
> Run `npm run cli -- doctor` to have the machine check its own readiness.

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
| Everything at a glance | `/admin?key=$APP_SECRET` — MRR, subscribers, pending opt-ins, job runs, 30-day event funnel, and a button to run any job |
| Jobs still succeeding | `GET /healthz` — last 8 job runs, plus a `problems[]` verdict. `?strict=1` returns 503 when degraded, so an uptime monitor pages you instead of you remembering to look. |
| TED contract unchanged | `npm run cli -- check-ted` (also runs in CI, non-blocking) |
| Deliverability | Your ESP dashboard: bounce < 2%, complaints < 0.1% |
| Revenue | Stripe dashboard |

**The one real fragility** is TED changing its Search API. Three independent defences cover it:
the client walks a **fallback chain of query dialects** (precise eForms syntax → set syntax →
date-only with client-side filtering), it **degrades to a minimal field set** on HTTP 400, and
the normaliser tolerates missing or reshaped fields. `check-ted` reports which strategy is
currently working, and CI runs it on every push. A TED change costs you precision, not uptime.

See the failure-mode table at the end of [LAUNCH.md](LAUNCH.md) for what breaks, how you find
out, and what the blast radius is.

---

## 7. Extending it

- **More sources, same pipeline:** add a client under `src/ingest/` that returns `Notice[]`
  (UK Contracts Finder, US SAM.gov, TenderNed, bund.de). Coverage breadth is exactly what the
  €49–€149/mo competitors charge for.
- **Slack/Teams delivery** — a webhook URL per subscriber; the highest-value asked-for feature.
- **Sharper forecasts** — the engine in `core/radar.ts` is deliberately simple and explainable
  (median interval + the legal 4-year cap). Obvious upgrades from data already stored: read the
  stated framework duration out of the notice text, model per-CPV renewal behaviour, and learn
  from forecasts that were confirmed by an actual publication (`forecasts.superseded_by` is the
  ground-truth label — the product measures its own hit rate for free).
- **Sell the forecast to the other side** — incumbents will pay to know when *their* contract is
  about to be re-competed. Same table, opposite persona.

---

Data source: Tenders Electronic Daily (TED), © European Union. This project is independent and
not affiliated with or endorsed by the European Union. The notice on ted.europa.eu is always the
legally binding version.

> **Note on CI:** the GitHub Actions workflow ships as
> `ci/github-actions-ci.yml` because this sandbox's GitHub App cannot create
> workflow files. Copy it to `.github/workflows/ci.yml` locally to enable tests + the live TED contract
> check on every push.
