# Launch checklist

Work top to bottom. Anything marked **BLOCKER** must be done before you send a single
email to a real person. Total time: one focused evening. Total cost: ~€6/month.

Run `npm run cli -- doctor` at any point — it mechanically checks most of section 2 and
exits non-zero if something would break in production.

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

- [ ] Stripe product created: recurring, €29/month. Copy the **price ID** → `STRIPE_PRICE_ID`.
- [ ] **BLOCKER** Webhook endpoint added in Stripe → `https://yourdomain/stripe/webhook`,
      events: `checkout.session.completed`, `customer.subscription.created`,
      `customer.subscription.updated`, `customer.subscription.deleted`,
      `invoice.payment_failed`. Signing secret → `STRIPE_WEBHOOK_SECRET`.
      *Without this, people can pay and never get activated.*
- [ ] Customer Portal enabled in Stripe settings (so cancellations never reach your inbox).
- [ ] Run one real end-to-end test in Stripe **test mode**: subscribe → check the row in
      `/admin` flips to `trialing` → cancel in the portal → check it flips to `canceled`.
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
- [ ] Post the free weekly digest offer where the audience already is:
      IT-Mittelstand LinkedIn groups, Bitkom/BVMW SME networks, freelance-Ausschreibung forums.
- [ ] Mine your own database for outreach: award notices (`can-standard`) name companies
      that already bid in your sectors — a legitimate, pre-qualified list.
      `sqlite3 data/tenderping.db "SELECT DISTINCT buyer_name, buyer_country FROM notices WHERE notice_type LIKE 'can%' LIMIT 50;"`
- [ ] Ask the first 10 free subscribers one question by email: *"did this week's digest
      contain anything you'd actually bid on?"* Their answer tells you which CPV codes to
      keep and which to drop. That is the whole product roadmap for month one.

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
