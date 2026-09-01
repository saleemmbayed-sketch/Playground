# Launch checklist

Everything below is a one-time action. Total: about 90 minutes, most of it waiting for DNS.
Recurring cost after this: **one domain (~€10/yr) + one VPS (~€4/mo)**. Nothing else is metered
until you pass 3,000 emails/month.

Tick these in order. Steps marked **[you]** genuinely need a human; everything else is a command.

---

## Phase 1 — Accounts (30 min, mostly waiting)

- [ ] **[you]** Register a domain. Short, spellable, `.eu` or `.de` reads as local to German buyers.
- [ ] **[you]** Create a **Hetzner** account (or any VPS). CX22 in Nuremberg/Falkenstein, ~€4/mo,
      keeps data in the EU which matters for your GDPR page.
- [ ] **[you]** Create a **Resend** or **Brevo** account (free tier). Add your domain and copy the
      **SPF, DKIM and DMARC** DNS records they give you into your registrar.
      *Do not skip DMARC* — Gmail and Yahoo reject bulk senders without it, and deliverability is
      the entire product.
- [ ] **[you]** Create a **Stripe** account and complete identity verification (this is the slowest
      step — start it first). Copy the secret key from dashboard.stripe.com/apikeys.
- [ ] **[you]** Point an `A` record for your domain (and `www`) at the VPS IP.

## Phase 2 — Deploy (15 min)

```bash
ssh root@YOUR_VPS_IP
apt update && apt install -y docker.io docker-compose-plugin git
git clone <this-repo> tenderping && cd tenderping

npm install          # only needed if you want to run CLI commands outside Docker
npm run setup        # interactive wizard, writes .env
```

The wizard asks for: your URL, brand, legal name/address, CPV families, countries, SMTP URL,
Stripe key. It generates a strong `APP_SECRET` for you.

- [ ] Edit `Caddyfile`, replacing `tenderping.eu` with your domain (2 places).
- [ ] `docker compose up -d` — Caddy issues TLS certificates automatically.

## Phase 3 — Provision Stripe (2 min, automated)

```bash
npm run cli -- setup-stripe
```

Creates the product, the €29/mo recurring price, the webhook endpoint pointing at
`https://yourdomain/stripe/webhook` with the right events, and the customer portal
(so cancellations never reach your inbox). It writes `STRIPE_PRICE_ID` and
`STRIPE_WEBHOOK_SECRET` straight into `.env`. Re-running it is safe — it reuses what exists.

- [ ] `docker compose restart app` to load the new values.
- [ ] **[you]** In Stripe, switch from test mode to live mode when you are ready to charge.

## Phase 4 — Fill the archive and verify (10 min)

```bash
npm run cli -- probe-fields         # confirms which TED fields are live today
npm run cli -- ingest --days 30     # ~2-4k notices; this is your SEO corpus
npm run cli -- doctor               # preflight: every dependency, end to end
```

`doctor` must show **no blocking issues**. Warnings about archive depth disappear after ingest.

- [ ] `npm run cli -- test-email you@yourdomain.com` — then check **inbox *and* spam**.
      If it lands in spam, your DNS records are not right yet. Fix that before sending to anyone.
- [ ] Visit `https://yourdomain/admin?key=YOUR_APP_SECRET` — bookmark it. This is your whole
      back office.
- [ ] **[you]** Sign up on your own site with a personal address and click the confirmation link.
      That is the exact experience a customer gets.

## Phase 5 — Get found (30 min)

- [ ] **[you]** Google Search Console: add the domain, verify via DNS TXT, submit
      `https://yourdomain/sitemap.xml`.
- [ ] **[you]** Bing Webmaster Tools: same (it also feeds DuckDuckGo).
- [ ] **[you]** Point **UptimeRobot** (free) at `https://yourdomain/healthz` every 5 minutes with
      email alerts. This is your only monitoring and it is enough.
- [ ] **[you]** Set a calendar reminder: *first of the month, open /admin, run doctor.*

## Phase 6 — First customers

The machine runs itself from here. This is the only part that needs you, and only at the start.

- [ ] Ingest award notices (`can-standard`) for your sectors — they name companies **already
      bidding** on exactly the contracts you monitor. That is a legitimate, pre-qualified list.
      Personal, non-templated emails only; a cold blast will burn your sending domain.
- [ ] Post the free weekly digest where German IT SMEs already are: Bitkom and BVMW groups,
      IT-Mittelstand LinkedIn groups, freelance/Ausschreibung communities.
- [ ] Give the free tier away generously. Match quality is the only thing that converts, and the
      only way to show it is to let people see it in their inbox.

---

## What "done" looks like

| Signal | Where to check |
|---|---|
| Pipeline alive | `/admin` shows an ingest run in the last 24h |
| Emails delivering | ESP dashboard: bounce < 2%, complaints < 0.1% |
| Archive growing | `/tenders` page count climbing daily |
| Search picking it up | Search Console impressions after ~2–6 weeks |
| Revenue | Stripe dashboard, mirrored as MRR on `/admin` |

## If something breaks

| Symptom | Cause | Fix |
|---|---|---|
| No new notices | TED renamed a field | `npm run cli -- probe-fields` (ingest also self-heals on the next run) |
| `doctor` fails on TED | Query returned 0 rows | Widen `TED_CPV_FAMILIES` or clear `TED_COUNTRIES` |
| Emails in spam | DNS | Recheck SPF/DKIM/DMARC at your ESP |
| Nobody upgrades | Match quality | Run `preview <email>` for real subscribers and tune default filters |
| Digest not sending | Scheduler | `/admin` → run the job manually; check `SCHEDULER_ENABLED=true` |

## Pricing notes

€29/mo is deliberately at the bottom of the market (competitors: £29–£149/mo, enterprise
£5,000+/yr). It is the easiest price to say yes to for a 5-person IT firm, and one won contract
pays for a decade of subscription — that is the line to use in outreach.

Raise revenue by *widening coverage*, not by chasing volume: a Team tier at €79 with more CPV
families, more countries and Slack delivery is the natural second product, and the pipeline
already supports all of it.
