# Launch checklist

Work top to bottom. Anything marked **BLOCKER** must be done before you send a single
email to a real person. Total time: one focused evening. Total cost: ~€6/month.

The machine-checkable part is now a single command:
```bash
npm run preflight -- --full
```
It installs deps, builds `dist/`, typechecks, runs all 108 tests, runs both UAT harnesses
(50 lifecycle + 98 black-box against the built server), runs the production `doctor`, and
attempts the live TED smoke test. It exits non-zero and writes `PREFLIGHT.md` listing
exactly what is still blocking, which is why "ready to launch" is now a gate, not a vibe.

Run `npm run cli -- doctor` any time — it checks most of section 2 and exits non-zero if
something would break in production.

---

## 1. Accounts and assets (≈45 min)

| Item | Where | Cost | Notes |
|---|---|---|---|
| Domain | Namecheap / INWX / Cloudflare | ~€10/yr | Short, spellable. `.eu` or `.de` reads trustworthy for this audience. |
| VPS | Hetzner CX22 (Nuremberg/Falkenstein) | €4.35/mo | EU data residency matters when your customers are public-sector suppliers. |
| Email sending | Resend or Brevo | €0 (3k/mo free) | You will not exceed the free tier until ~300 subscribers. |
| Stripe account | stripe.com | €0 + 1.5% + €0.25/txn | Needs your real legal identity for payouts. |
| GitHub repo | this repo | €0 | Copy `ci/github-actions-ci.yml` to `.github/workflows/ci.yml`. |

---

## 2. Configure and deploy (≈45 min)

```bash
git clone <your repo> tenderping && cd tenderping
cp .env.example .env
openssl rand -hex 32          # paste into APP_SECRET
$EDITOR .env                  # BASE_URL, brand, LEGAL_*, SMTP_URL, STRIPE_*
$EDITOR Caddyfile             # your domain, twice
docker compose up -d
docker compose exec app node dist/cli.js doctor
```

- [ ] **BLOCKER** `APP_SECRET` is a fresh random 32-byte hex value. It signs every
      unsubscribe/settings link and guards `/admin` and `/ops/*`. Never reuse the default.
- [ ] **BLOCKER** `BASE_URL` is your real `https://` domain, no trailing slash.
- [ ] **BLOCKER** `LEGAL_NAME` and `LEGAL_ADDRESS` are your actual Impressum details
      (German law requires them on the site and in commercial email).
- [ ] DNS A record → VPS IP; Caddy will issue TLS automatically on first request.
- [ ] `curl https://yourdomain/healthz` returns `ok: true`.
- [ ] Free uptime monitor (UptimeRobot / Better Stack) pointed at
      `https://yourdomain/healthz?strict=1` every 5 min. It returns **503** when the
      ingest is stale (>36h), a job failed, or a digest could not be delivered — which is
      the only alarm you actually need for this business.

## 3. Email deliverability (≈30 min) — do not skip

Deliverability *is* the product. A digest in spam is worth nothing.

- [ ] **BLOCKER** SPF record published for your sending domain.
- [ ] **BLOCKER** DKIM record published (your ESP gives you the exact CNAME/TXT).
- [ ] **BLOCKER** DMARC record: start with `v=DMARC1; p=none; rua=mailto:you@domain`.
- [ ] `MAIL_TRANSPORT=smtp` and `SMTP_URL` set; `doctor` reports `smtp verified`.
- [ ] Point your ESP's bounce/complaint webhook at
      `https://yourdomain/mail/webhook?key=YOUR_APP_SECRET` so hard bounces are
      suppressed automatically.
- [ ] Send yourself a test: `docker compose exec app node dist/cli.js add-subscriber you@you.com --pro`
      then `... digest-daily`. Check it lands in **Inbox**, not Promotions/Spam.
- [ ] Confirm the email shows a working unsubscribe link and your postal address.

## 4. Billing (≈20 min)

- [ ] Put your Stripe secret key in `.env`, then run **`npm run cli -- setup-stripe`**. It creates
      **both** products (Pro €29/month and Edge €79/month), their recurring prices, the webhook
      endpoint (with exactly the events the app handles) and the Customer Portal, and writes
      `STRIPE_PRICE_ID`, `STRIPE_EDGE_PRICE_ID` and `STRIPE_WEBHOOK_SECRET` back into `.env`.
      Re-running it is safe. The items below are then already done — verify rather than redo them.
      Change the amounts with `--amount 2900 --edge-amount 7900`.
- [ ] Stripe products created: Pro recurring €29/month → `STRIPE_PRICE_ID`, Edge recurring
      €79/month → `STRIPE_EDGE_PRICE_ID`. Edge is the tier that includes Re-tender Radar; without
      its price ID the `/pricing` page shows Edge as unavailable and only Pro can be bought.
- [ ] **BLOCKER** Webhook endpoint added in Stripe → `https://yourdomain/stripe/webhook`,
      events: `checkout.session.completed`, `customer.subscription.created`,
      `customer.subscription.updated`, `customer.subscription.deleted`,
      `invoice.payment_failed`. Signing secret → `STRIPE_WEBHOOK_SECRET`.
      *Without this, people can pay and never get activated.*
- [ ] Customer Portal enabled in Stripe settings (so cancellations never reach your inbox).
- [ ] Run one real end-to-end test in Stripe **test mode**: subscribe → check the row in
      `/admin` flips to `trialing` → cancel in the portal → check it flips to `canceled`.
- [ ] Test the **Edge** checkout too, and confirm the subscriber's `plan` reads `edge`
      (the webhook derives the tier from the price on the subscription, so portal
      upgrades/downgrades between Pro and Edge are honoured automatically).
- [ ] Switch to live keys, then repeat the checkout once with a real card and refund yourself.

## 5. Data (≈15 min)

- [ ] `TED_OFFLINE=false`.
- [ ] `./scripts/verify-live.sh` — confirms the live TED API contract still holds.
      This is the one thing this repo could not test in the build sandbox.
- [ ] Backfill the archive so search engines find a real corpus:
      `docker compose exec app node dist/cli.js ingest --days 30`
- [ ] `docker compose exec app node dist/cli.js stats` shows a few thousand notices.
- [ ] Tune `TED_CPV_FAMILIES` / `TED_COUNTRIES` to the niche you actually want to sell to.
      Narrower = better match quality = lower churn.
- [ ] **Build the Re-tender Radar** — this is what Edge subscribers are paying for, and it needs
      history, so do it before launch, not after:
      `docker compose exec app node dist/cli.js ingest-awards --days 1825`
      then `... node dist/cli.js radar`. Five years of award notices gives every buyer at least one
      completed framework cycle to measure. Check `/radar` shows forecasts and `/buyers` lists
      authorities; both are then in your sitemap.

## 6. Legal (Germany) (≈30 min)

- [ ] `/legal` page shows correct Impressum + privacy text (rendered from your env vars).
- [ ] Double opt-in is on by default — do not disable it. Confirmed addresses only.
- [ ] Decide *Kleinunternehmerregelung* (§19 UStG) vs regular VAT with your tax advisor.
      Under Kleinunternehmer you must **not** show VAT on invoices.
- [ ] If you sell to consumers rather than businesses, add a Widerrufsbelehrung. Selling
      B2B only (which this is) keeps that simpler — say so in your terms.
- [ ] Register the business (Gewerbeanmeldung) before taking money.

## 7. Launch day

- [ ] `SCHEDULER_ENABLED=true` and confirm in `/admin` that ingest + digest ran overnight.
- [ ] Submit `https://yourdomain/sitemap.xml` in Google Search Console + Bing Webmaster.
- [ ] **Lead with the Radar, not the alerts.** Alerting is a commodity; "see the tender 6–12
      months before it is published, with the incumbent's name and what they were paid" is not.
      Use a real forecast from your own `/radar` page as the hook in every post — it is concrete,
      checkable, and impossible for an alerts-only competitor to answer.
- [ ] Post the free weekly digest offer where the audience already is:
      IT-Mittelstand LinkedIn groups, Bitkom/BVMW SME networks, freelance-Ausschreibung forums.
- [ ] Mine your own database for outreach: award notices (`can-standard`) name companies
      that already bid in your sectors — a legitimate, pre-qualified list.
      `sqlite3 data/tenderping.db "SELECT DISTINCT buyer_name, buyer_country FROM notices WHERE notice_type LIKE 'can%' LIMIT 50;"`
- [ ] Ask the first 10 free subscribers one question by email: *"did this week's digest
      contain anything you'd actually bid on?"* Their answer tells you which CPV codes to
      keep and which to drop. That is the whole product roadmap for month one.

## 7.1 Paywall sanity check (5 min, before you announce)

The Radar is the reason Edge costs €79, so confirm it is not being given away:

- [ ] Open `/radar` in a private window and count the forecasts shown in full — it must equal
      `RADAR_SHOWCASE_COUNT` (default 3), no matter which `?cpv=` filter you apply.
- [ ] Open two or three `/buyer/...` pages logged out. You should see the incumbent, the contract
      value and a **half-year** estimate ("H1 2027") — never an exact `date → date` window.
- [ ] Click an unsubscribe link from a test email and append it to `/radar?t=…`. It must **not**
      unlock the radar; only the "Adjust filters" account link does.
- [ ] Run `npm run cli -- radar-digest` twice. The second run must report
      `emailsSent: 0` and `skippedAlreadySent`.

## 8. Ongoing (10 min/month)

- [ ] `/admin?key=...` — job runs all green, MRR, pending confirmations.
- [ ] ESP dashboard — bounces < 2%, complaints < 0.1%.
- [ ] Backups exist in `data/backups/` (nightly, 14 kept). Copy them off the box
      periodically: `scp -r root@vps:/var/lib/docker/volumes/..._tenderping-data/_data/backups .`
- [ ] CI's `check-ted` step warns you if the TED API contract drifts.

---

## What breaks, and what happens when it does

| Failure | Detection | Blast radius |
|---|---|---|
| TED renames a search field | ingest logs a warning, client retries with the minimal field set | alerts lose optional detail, keep flowing |
| TED changes query grammar | client walks its fallback chain to a date-only query and filters locally | precision drops, service continues |
| TED is down | job fails, you get an alert email, next run retries | one missed digest, no data loss |
| SMTP rejects a recipient | address is auto-suppressed | that one subscriber; reputation protected |
| Stripe webhook missed | status stays stale until Stripe retries (it retries for 3 days) | self-healing |
| VPS dies | restore the newest file from `data/backups/` onto a new box | minutes of downtime |
