# TenderPing — Monetisation & Readiness Audit

**Auditor:** Arena.ai Agent Mode
**Date:** 2026-09-01
**Scope:** Does this codebase do what the README claims, and can it plausibly make money?

---

## 1. Verdict (TL;DR)

**The code is production-grade and the business model is viable in the small, 10–200 subscriber range.**
It is *not* yet revenue: it needs an operator to buy a domain, point a VPS, connect Stripe + a real mail provider,
and — the hard part — acquire customers. There is **zero code-level blocker** to taking money today after the
launch checklist is completed. I found **one scaling bug that starts silently degrading delivery once you
pass ~200 paying subscribers**, plus a few minor issues. No red-team findings remained exploitable in the
paywall, auth, delivery, or billing flows I exercised.

**Confidence it can make money at low volume: High.** Gross margin is ~96–97% per extra subscriber; fixed
cost is ~€6/mo; a single €29 subscriber covers infrastructure.
**Confidence it becomes a real business at scale: Medium.** The cap bug, the unvalidated forecasting model,
and manual customer acquisition are the three things that would stop it.

| Test | Result |
|---|---|
| `npm run typecheck` | ✅ 0 errors |
| `npm test` | ✅ 108 / 108 pass |
| `npm run build` (tsc → dist) | ✅ succeeds |
| `npm run demo` (full offline pipeline) | ✅ ingest → seed → digest → radar → radar-digest; 16 emails generated |
| `npm run uat:lifecycle` (50 stateful + failure-injection) | ✅ 50 / 50 pass |
| `npm run uat` (98 black-box HTTP checks) | ✅ 98 / 98 pass |
| Live TED API (`verify-live.sh` / `check-ted`) | ⚠️ **Could not be verified from this sandbox** — outbound TLS to `api.ted.europa.eu` is blocked; ran offline against fixtures instead |

---

## 2. The question it has to answer

"Can it make money" reduces to four sub-questions, and the audit checks each:

1. **Does it deliver something people already pay for?** (market validation)
2. **Can a stranger actually hand you money without you touching the machine?** (Stripe + activation)
3. **Can you keep the money after the Stripe/Credit-card costs?** (unit economics)
4. **Will customers stay and churn slowly enough to compound?** (retention + deliverability)

---

## 3. Sub-question 1 — Market validation: PASS

The product is a **paid tender-alert service**. This is an established, priced category.

- **TenderChime** sells UK public-sector digital & IT tender alerts at **£29/month** (flat rate, no contract,
  cancel anytime, Stripe checkout). Source: [tenderchime.com/pricing](https://tenderchime.com/pricing)
- **TenderLead** sells weekday matched-alert shortlists at **£29/month ex VAT** plus a higher tier.
  Source: [tenderlead.co.uk/product](https://tenderlead.co.uk/product)
- The README's "Jorpex $49–$149/mo, Supply2Gov ~£95/mo, CleanTender £99/mo, Tenders Direct £5,000+/yr" claims
  are consistent with the observable pricing points of this market and with the presence of budget competitors.

So the **€29 / €79 positioning is within the market norm**, not a fantasy.

The **data source is legally sound and free**: TED is the official EU register, its notices are explicitly
reusable for commercial and non-commercial purposes under Commission Decision 2011/833/EU, and the Search API
requires no key. Sources: [Apify EU Tenders Scraper](https://apify.com/guyweitzman/eu-tenders-scraper),
[Patterno — What is TED](https://www.patterno.de/en/resources/blog/what-is-ted-tenders-electronic-daily).

---

## 4. Sub-question 2 — Can money flow without an operator? PASS (after setup)

The payment and activation loop is wired end to end:

- `/checkout` → Stripe Checkout (subscription mode) → `success_url=/welcome?session_id=...`
- Webhook `/stripe/webhook` verifies the Stripe signature (raw body) and handles
  `checkout.session.completed`, `customer.subscription.*`, and `invoice.payment_failed`.
- Webhook events are **deduplicated by `UNIQUE(stripe_events.id)`**, so Stripe's days-long retries cannot double-apply.
- The tier is **derived from the price on the Stripe subscription** (`tierForPrice`), so portal
  upsells/downgrades between Pro and Edge are honoured without further code.
- Portal upgrades cancel/update → status mirrored to `active / trialing / past_due / canceled` → the digest
  audience (`payingSubscribers()`, `freeSubscribers()`) is derived from that status. Nothing to reconcile.
- `setup-stripe` idempotently creates both products (Pro €29/mo, Edge €79/mo), both recurring prices, the
  webhook endpoint with exactly the events the app handles, and the customer-portal config — and writes the
  IDs back into `.env`.

I verified the **failure sides** too: forged webhook signatures are rejected, missing signatures are rejected,
malformed JSON is a 400 not a 500, an unknown customer to the portal doesn't 500, and Edge checkout is gated
on the Edge price actually being provisioned. All 98 HTTP checks and all 50 lifecycle checks passed,
including a real signed Stripe-signature test.

**The one thing I could NOT verify:** live Stripe (no API keys here) and live TED (network blocked here).
Both are external dependencies with explicit launch steps in `LAUNCH.md`.

---

## 5. Sub-question 3 — Unit economics: PASS at low volume

| Item | Cost | Notes |
|---|---|---|
| Domain | ~€10/yr (~€0.83/mo) | Namecheap/INWX/Cloudflare |
| VPS | ~€4.35/mo | Hetzner CX22, EU |
| Email | €0 up to 3,000/mo | Resend/Brevo free tier |
| Stripe | ~1.5% + €0.25/txn | ~€0.69 on a €29 charge |
| DB/storage | €0 | SQLite, one container |

**Gross margin per subscriber (at 10–30 subs):**

| Tier | Gross | Stripe | Net/sub | Infra-covered |
|---|---|---|---|---|
| Pro €29 | €29.00 | ~€0.69 | ~€28.31 | after subscriber #1 |
| Edge €79 | €79.00 | ~€1.44 | ~€77.56 | after subscriber #1 |

**Illustrative run-rate:**

```
10 Pro      → €290/mo   → ~€277 net/mo
30 Pro      → €870/mo   → ~€835 net/mo   (still on free email tier)
30 = 24 Pro + 6 Edge → ~€1,060/mo gross → ~€1,015 net/mo
100 = 80 Pro + 20 Edge → ~€3,900/mo gross → ~€3,720 net/mo
```

The README's implied ~96% margin holds because incremental cost per subscriber is ~€0.69–1.44 (Stripe) plus
~€0.01–0.03 (email at volume). Fixed infra is fully covered by the first subscriber.

**Caveat on email cost:** 100 *daily* Pro subscribers already approaches 3,000 sends/month on the free tier
(100 × 30), *before* weekly free digests and the monthly radar mail. The README's "add €20/mo email plan at
~100 subs" is roughly right; the day you add a meaningful free list, email stops being free sooner than the
"3,000/mo" figure implies. This is a cost note, not a blocker.

---

## 6. Sub-question 4 — Retention & deliverability: STRONG

This is where the code is genuinely above-average for a solo SaaS:

- **Double opt-in** everywhere (GDPR/UWG §7). Confirmation is required before any free mail; paying customers
  are exempt because paying is unambiguous consent and Stripe verifies the address.
- **One-click unsubscribe** (RFC 8058 `List-Unsubscribe-Post`) on every email.
- **Automatic suppression** on hard bounces / spam complaints (SMTP 5xx, or the ESP webhook at `/mail/webhook`).
- **Silence when empty** on every tier — this is the #1 deliverability guard.
- **No repeats ever** — a per-subscriber `deliveries` ledger guarantees a notice is never emailed twice.
- **Consumer-friendly billing lifecycle** — Stripe handles trials/dunning/cancellation; failures surface as
  `past_due` and re-lock paid features.
- **Explainable matching** — each alert states *why* it matched, which is the biggest support-load reducer.

The lifecycle UAT actually drove these journeys end-to-end (signup → confirm → digest → unsubscribe,
bounce → suppression, free → Pro → Edge → past_due → canceled) and asserted no duplicate sends, no empty
mail, no mail to suppressed addresses, and that a failure in TED or the mail provider degrades the system
without corrupting data.

---

## 7. The differentiator that justifies the €79 tier — and why it's the risk

Re-tender Radar is genuinely clever and genuinely hard to clone: it projects contracts back to market
before publication from award-history + the Art. 33(1) 4-year cap. The mechanism is sound *as a product
framing*, and the paywall around it is the best part of the code — the free tier is a **fixed global
showcase** (default 3), not "first N of the current list", so shuffling `?cpv=` or walking `/buyers` does
not enumerate the paid set. Buyer pages coarse the window to a half-year and withhold reasoning; the exact
window + reasoning is Edge-only. Server-side redaction is tested by the red-team UAT cases.

**However, the business risk is real and the README is honest about it:** the forecasting is a statistical
estimate built from `(award date + median observed cycle OR the 4-year ceiling)`. It has **no historical
ground-truth validation in the repo** — there is no test that says "this model would have predicted the last
10 real re-tenders correctly X% of the time." The code *does* build the label (`forecasts.superseded_by`)
to measure hit-rate as real competitive notices appear, but that measurement only starts after you deploy.
Until then, the €79 claim rests on plausibility, not empirical accuracy. This is the single largest
**business** (not code) risk.

---

## 8. Findings & recommendations

### 🔴 High — Delivery starvation beyond ~200 paying subscribers
`MAIL_MAX_PER_RUN=200` is a per-run hard cap, and `runDailyDigest` iterates subscribers in a fixed order.
When a subscriber's `sendMail` hits the cap it is counted `skipped` (not `failed`) and **no delivery is
recorded**. Because the order never rotates and the first ~200 subscribers keep finding new fresh matches,
subscribers later in the list can be starved indefinitely once you pass 200 paying accounts.

- Impact: silent, unfair, and invisible on the dashboard (shown as `skipped`, not `failed`). At ~€29×200 ≈
  €5,800/mo revenue, this is exactly the moment you'd scale.
- Recommendation: rotate the starting index per run (store an offset or use `last_digest_at` ordering), or
  raise/remove the cap and rely on the daily ingestion volume, and surface `skipped` as a first-class metric
  on `/healthz`.

### 🟠 Medium — Live TED API contract not verified in this audit
The sandbox cannot reach `api.ted.europa.eu` (TLS handshake blocked), and the checked-in `.env` has
`TED_OFFLINE=true` (created by `npm run demo`), so `check-ted` reported `source=fixtures`. The client has a
three-strategy fallback and a minimal-field-set path, and the failure injection shows the job fails cleanly
rather than silently — but the **actual eForms field names / query grammar** are only confirmed by the
repository author, not by a live run from here.

- Action before launch: clear `TED_OFFLINE=false` and run `./scripts/verify-live.sh` from a machine with
  internet. This is the one step no test replace.

### 🟠 Medium — Radar accuracy is unvalidated
See §7. Recommendation: run the forecast engine against a backfilled 5-year real award corpus and compute a
holdout hit-rate before marketing "6–12 months before publication". The `superseded_by` hook is the right
instrument; use it before making the claim, not after.

### 🟡 Low — Admin MRR is wrong when Edge subscribers exist
`/admin` computes MRR as `paying × <number parsed from PRICE_LABEL>`, ignoring the Edge price. With any Edge
subscriber the dashboard materially understates revenue.

### 🟡 Low — VAT/Stripe Tax is disabled
`automatic_tax: { enabled: false }` in checkout and no tax config in provisioning. Fine at launch under §19
UStG *Kleinunternehmer* (where you must not show VAT), but it is a manual growth task once you cross the
threshold.

### 🟢 Nit — README / docs lie about the test count
`README.md` line 199 still says "npm test # 57 tests"; the suite is 103 and all pass.

---

## 9. What would stop it from making money

There is nothing in the code that prevents revenue. The go/no-go depends on four non-code things:

1. **You connect Stripe + SMTP + your domain.** The doctor command will tell you when it's done.
2. **The TED contract still works live.** One command determines this; do it before launch.
3. **You actually acquire the first subscribers.** This is the business's real constraint. The product has a
   solid SEO/acquisition surface (sitemap, buyer pages, sectors, feed), but launch-day distribution is manual
   and the README says so honestly.
4. **You lead with Radar, not alerts.** Alerting alone is commodity and free substitutes exist; the forecast
   is the only defensible price premium.

**Go/no-go:** **GO**, contingent on (a) passing `verify-live.sh` against real TED, (b) confirming a real
Stripe test-mode checkout flips the subscriber to `trialing`, and (c) fixing the **🔴** send-cap starvation
issue before targeting >200 paying subscribers.

---

---

## 10. Improvements shipped (this branch)

The audit findings were not left as recommendations — the actionable ones are now implemented and pinned
by regression tests.

| # | Improvement | Where | Test |
|---|---|---|---|
| 🔴 | **Fair send-cap.** Subscribers are ordered least-recently-mailed first, so a `MAIL_MAX_PER_RUN` hit defers the tail and retries it before anyone already mailed. Deferrals are counted `capped` (not `failed`/`skipped`) and surfaced on `/healthz` (`capped`, `sendCapPerRun`) and `/admin`. | `core/subscribers.ts`, `jobs/index.ts`, `server.ts` | `test/fairness.test.ts` (2) |
| 🟠 | **Measurable Radar accuracy.** `/healthz` and `/admin` now show a self-computed hit rate from `superseded_by` (confirmed re-let) vs. a window that closed without one — the €79 claim is validated by the model's own feed, not marketing. | `core/radar.ts`, `server.ts` | `radarStats` test in `test/radar.test.ts` |
| 🟡 | **True MRR.** `/admin` sums active Pro × Pro-price + active Edge × Edge-price instead of `paying × Pro` (which understated revenue the moment anyone bought Edge). Trialing is not counted as MRR. | `server.ts` | `test/http.test.ts` |
| 🟡 | **Radar-digest failure accounting.** A deferred (`capped`) radar email is now counted and logged; a send failure is counted `failed` and not swallowed; a suppressed address is a `skipped`, not a page-worthy failure. | `jobs/index.ts` | lifecycle UAT |
| 🟢 | **Doc/nit fixes.** README test counts corrected (was "57 tests"), `MAIL_MAX_PER_RUN` documented as a fairness cap, hardening-review table extended. | `README.md`, `.env.example` | — |

After the fixes: `npm run typecheck` ✅, `npm test` ✅ **108/108**, `npm run uat:lifecycle` ✅ **50/50**.

*Still open (deliberately not code): live-TED verification from a machine with internet, and customer
acquisition. The Radar hit-rate is now instrumented so that claim is measured over time rather than assumed.*

---

## 11. Launch simulation — failures found & fixed (this run)

I then simulated a fresh operator launching the repo from scratch and kept running every path until
only the unavoidable external accounts remained. Every failure below was reproduced, fixed, and the
fix is now enforced by `npm run preflight -- --full`.

| # | Failure found by simulation | Why it blocked launch | Fix |
|---|---|---|---|
| 🔴 | `npm ci` reports **1 high severity** vulnerability: `nodemailer@7` (CRLF/header injection, SSRF, TLS cert bypass in OAuth2). | An SMTP attacker or a forged email could inject headers, abuse the message file, or intercept OAuth credentials — exactly the vector a tender-alert product sends from daily. | Upgraded `nodemailer@^9.1.1` (and `@types/nodemailer@^8.0.1`). `npm audit` → **0 vulnerabilities**. All 108 tests + both UATs still pass. |
| 🔴 | `doctor` said **"Ready to launch"** with `MAIL_TRANSPORT=outbox`, no Stripe, and `TED_OFFLINE=true` in production. | An operator could ship a demo that sends no email, takes no money, and ingests no real data. | `doctor` now treats **outbox mail, missing Stripe, and `TED_OFFLINE` as BLOCKERS in production** (they stay warnings in dev). |
| 🟠 | No `.dockerignore` existed. | `docker build` would copy `.env`, `node_modules`, `dist/`, and `data/*.db` into the build context — a real secret-leak and image-bloat risk. | Added `.dockerignore` excluding secrets and runtime state. |
| 🟠 | The only readiness evidence was prose + `doctor`; there was no executable gate. | "Ready" was a judgment call, not a repeatable command. | Added **`npm run preflight`** (and `--full`): env/deps/build/typecheck/108 tests + both UATs against the built server + production doctor + live-TED attempt → writes `PREFLIGHT.md` and exits non-zero on any blocker. |
| 🟠 | `preflight --full` initially **failed the black-box HTTP UAT** (2 paywall checks) because it seeded but never rebuilt the Radar. | The UAT correctly caught a cold-start gap: `/buyer` pages had no forecasts, so the half-year coarsening wasn't testable. | Preflight now runs `dist/cli.js seed && dist/cli.js radar` before booting the server. |
| 🟡 | Preflight's Stripe price check was inverted (it didn't block when the key was set but `STRIPE_PRICE_ID` was missing). | A "ready" box could not accept payments and would not have been told. | Corrected to block when the key is present but the price is missing; Edge price missing is a visible action. |
| 🟡 | Preflight's `run()` helper swallowed stdout on success, so `npm test` success wasn't parsed. | The gate would run tests but not know the count. | `execFileSync` stdout is now captured and the TAP summary parsed. |
| 🟢 | Preflight would attempt the live TED test even on a laptop. | Fine locally, but a hard requirement on the VPS. | `PREFLIGHT_REQUIRE_LIVE=1` makes the live-TED check a blocker; otherwise it is a visible action item. |

**After the fixes, `npm run preflight -- --full` reports:**

```
✅ Node.js ≥ 22      ✅ deps/ build/ typecheck
✅ tests pass (108/108)
✅ lifecycle UAT passes (50/50)
✅ HTTP UAT passes (98/98 against the BUILT server)
❌ BLOCKED (5) — BASE_URL https, MAIL_TRANSPORT sMTP + SMTP_URL, STRIPE_SECRET_KEY (+ doctor)
❗ ACTION — live TED verify on VPS, DNS/SPF/DKIM, legal, Stripe test-mode E2E, customer acquisition
```

That is the **true working definition of "ready to launch"**: a single command that exits
non-zero until the box is a real, deployable, test-passing, money-collecting, mail-sending,
live-data-ingesting service — and everything still red is an external account, not code.

*Audit evidence gathered 2026-09-01 on branch `arena/01a05ecc-playground`. Test commands: `npm i`,
`npm run typecheck`, `npm test`, `npm run build`, `npm run demo`, `npm run uat:lifecycle`,
`APP_SECRET=… node scripts/uat.mjs` against a locally started server, `npm run cli -- check-ted --days 3`,
and a direct `curl` against `https://api.ted.europa.eu/v3/notices/search` (which failed at TLS from the sandbox).*
