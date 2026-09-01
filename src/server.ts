import Fastify from 'fastify';
import formbody from '@fastify/formbody';
import { config, isProd } from './config.js';
import { closeDb, db, logEvent } from './core/db.js';
import { countNotices, getNotice, listNotices, noticeStats } from './core/notices.js';
import {
  confirmSubscriber, createSubscriber, getProfile, getSubscriber, getSubscriberByEmail,
  isValidEmail, subscriberStats, suppress, unsubscribe, updateProfile,
} from './core/subscribers.js';
import { accountUrl, signToken, verifyToken, unsubscribeUrl } from './core/tokens.js';
import { createCheckoutSession, createPortalSession, handleWebhook, stripeEnabled } from './core/billing.js';
import {
  runBackup, runDailyDigest, runIngest, runPrune, runWeeklyDigest, startScheduler,
} from './jobs/index.js';
import { CPV_SECTORS, h, layout, money, tenderCard } from './web/views.js';
import { rateLimit, startRateLimitSweeper } from './web/ratelimit.js';
import { sendMail } from './core/mailer.js';
import { accountLinkEmail, confirmEmail } from './core/templates.js';

async function runNamedJob(job: string): Promise<unknown | null> {
  switch (job) {
    case 'ingest': return runIngest();
    case 'digest-daily': return runDailyDigest();
    case 'digest-weekly': return runWeeklyDigest();
    case 'backup': return runBackup();
    case 'prune': return runPrune();
    default: return null;
  }
}

export function buildServer() {
  const app = Fastify({ logger: { level: isProd ? 'info' : 'warn' } });

  // HTML forms post application/x-www-form-urlencoded.
  app.register(formbody);

  // Stripe needs the raw body to verify signatures.
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
    (req as any).rawBody = body;
    try {
      done(null, body.length ? JSON.parse(body.toString('utf8')) : {});
    } catch (err) {
      done(err as Error, undefined);
    }
  });

  const html = (reply: any, body: string) => reply.type('text/html; charset=utf-8').send(body);

  /** Returns a 429 reply when the caller is over budget, otherwise null. */
  const limitOr429 = (req: any, reply: any, bucket: string, max: number, windowMs: number) => {
    const ip = (req.headers['x-forwarded-for']?.split(',')[0] ?? req.ip ?? 'unknown').trim();
    const { ok, retryAfter } = rateLimit(`${bucket}:${ip}`, max, windowMs);
    if (ok) return null;
    logEvent('ratelimit.hit', { bucket, ip });
    return reply
      .code(429)
      .header('retry-after', String(retryAfter))
      .type('text/html; charset=utf-8')
      .send(layout({
        title: 'Too many requests',
        body: `<div class="notice error">Too many requests. Try again in ${retryAfter} seconds.</div>`,
      }));
  };

  // ---------------------------------------------------------------- landing
  app.get('/', async (_req, reply) => {
    const stats = noticeStats();
    const latest = listNotices({ limit: 6 });
    const body = `
    <section class="hero">
      <h1>Stop reading TED. Get only the tenders you could actually win.</h1>
      <p class="lede">${h(config.brand.tagline)} We watch every notice published on Tenders Electronic Daily,
      filter it to your CPV codes, regions, keywords and contract size, and email you a plain-English brief
      the morning it appears.</p>
      <form class="inline" method="post" action="/subscribe">
        <input type="email" name="email" placeholder="you@company.com" required>
        <select name="cpv_prefixes">
          ${CPV_SECTORS.map((s) => `<option value="${s.code}">${h(s.label)}</option>`).join('')}
        </select>
        <input type="text" name="website" style="display:none" tabindex="-1" autocomplete="off">
        <button class="btn" type="submit">Get free weekly alerts</button>
      </form>
      <p style="color:#64748b;font-size:14px">Free weekly digest, no card. Pro (${h(config.billing.priceLabel)})
      sends every match daily — ${config.billing.trialDays}-day trial.</p>
    </section>

    <div class="grid">
      <div class="card"><div class="stat">${stats.total.toLocaleString('en-GB')}</div><p>notices indexed</p></div>
      <div class="card"><div class="stat">${stats.last7.toLocaleString('en-GB')}</div><p>published in the last 7 days</p></div>
      <div class="card"><div class="stat">${stats.countries}</div><p>buyer countries covered</p></div>
    </div>

    <h2>Why this beats a saved TED search</h2>
    <div class="grid">
      <div class="card"><h3>Explainable matching</h3><p>Every alert says why it matched: CPV, region, keyword, value band, days left to bid.</p></div>
      <div class="card"><h3>Never the same tender twice</h3><p>Deduplicated per subscriber, so your inbox stays a to-do list, not a firehose.</p></div>
      <div class="card"><h3>Plain-language briefs</h3><p>Each notice condensed to what is being bought, by whom, for how much, by when.</p></div>
      <div class="card"><h3>Silence when there is nothing</h3><p>No daily "0 results" email. We only write when there is something worth your time.</p></div>
    </div>

    <h2>Browse by sector</h2>
    <p>${CPV_SECTORS.map((s2) => `<a class="tag" href="/sectors/${s2.code}">${h(s2.label)}</a>`).join(' ')}</p>

    <h2>Latest indexed tenders</h2>
    ${latest.map(tenderCard).join('') || '<p>No notices indexed yet — run the ingest job.</p>'}
    <p style="margin-top:20px"><a class="btn secondary" href="/tenders">Browse all tenders →</a></p>`;
    return html(reply, layout({ title: `${config.brand.name} — EU public IT tender alerts`, body, canonical: `${config.baseUrl}/` }));
  });

  // ------------------------------------------------------- public archive (SEO)
  app.get('/tenders', async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const page = Math.max(1, Number.parseInt(q.page ?? '1', 10) || 1);
    const limit = 25;
    const rows = listNotices({
      limit, offset: (page - 1) * limit,
      cpvPrefix: q.cpv, country: q.country, q: q.q,
    });
    const filters = `
    <form class="inline" method="get" action="/tenders">
      <input type="search" name="q" placeholder="keyword" value="${h(q.q ?? '')}">
      <select name="cpv"><option value="">All sectors</option>
        ${CPV_SECTORS.map((s) => `<option value="${s.code}"${q.cpv === s.code ? ' selected' : ''}>${h(s.label)}</option>`).join('')}
      </select>
      <input name="country" placeholder="Country (DEU)" value="${h(q.country ?? '')}" size="10">
      <button class="btn secondary" type="submit">Filter</button>
    </form>`;
    const pager = `<p style="margin-top:24px">
      ${page > 1 ? `<a href="/tenders?page=${page - 1}">← Previous</a>` : ''}
      ${rows.length === limit ? `<a style="margin-left:16px" href="/tenders?page=${page + 1}">Next →</a>` : ''}</p>`;
    const body = `<h1 style="margin-top:32px">Live EU public IT tenders</h1>
      <p class="lede">Every notice we index from TED, newest first. Free to browse.</p>
      ${filters}${rows.map(tenderCard).join('') || '<p>No matching notices.</p>'}${pager}`;
    return html(reply, layout({ title: 'Live EU public IT tenders', body, canonical: `${config.baseUrl}/tenders` }));
  });

  app.get('/tender/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const n = getNotice(id);
    if (!n) return reply.code(404).type('text/html').send(layout({ title: 'Not found', body: '<h1>Notice not found</h1>' }));
    const body = `
      <h1 style="margin-top:32px;font-size:30px">${h(n.title)}</h1>
      <p class="lede">${h(n.summary ?? '')}</p>
      <table class="kv">
        <tr><td>Buyer</td><td>${h(n.buyer_name ?? 'n/a')}</td></tr>
        <tr><td>Country</td><td>${h(n.buyer_country ?? 'n/a')}</td></tr>
        <tr><td>Place of performance</td><td>${h(n.place_nuts ?? 'n/a')}</td></tr>
        <tr><td>CPV codes</td><td>${h(n.cpv ?? 'n/a')}</td></tr>
        <tr><td>Estimated value</td><td>${h(money(n.value_amount, n.value_currency))}</td></tr>
        <tr><td>Published</td><td>${h(n.publication_date ?? 'n/a')}</td></tr>
        <tr><td>Deadline</td><td>${h(n.deadline_date ?? 'see official notice')}</td></tr>
        <tr><td>TED publication no.</td><td>${h(n.id)}</td></tr>
      </table>
      <p><a class="btn" href="${h(n.url_html ?? '#')}" rel="nofollow noopener" target="_blank">Read the official TED notice →</a></p>
      <div class="notice">Want notices like this the morning they publish, filtered to your sectors?
        <a href="/pricing">Start a ${config.billing.trialDays}-day trial</a> or
        <a href="/">get the free weekly digest</a>.</div>`;
    return html(reply, layout({
      title: `${n.title.slice(0, 70)} — ${n.buyer_name ?? 'EU tender'}`,
      description: (n.summary ?? n.title).slice(0, 180),
      canonical: `${config.baseUrl}/tender/${encodeURIComponent(n.id)}`,
      body,
      jsonLd: {
        '@context': 'https://schema.org', '@type': 'GovernmentService', name: n.title,
        provider: { '@type': 'GovernmentOrganization', name: n.buyer_name ?? 'Public buyer' },
        areaServed: n.buyer_country, url: `${config.baseUrl}/tender/${encodeURIComponent(n.id)}`,
      },
    }));
  });

  /**
   * Sector landing pages. Each is a real, useful page targeting a buying-intent query
   * ("EU IT services tenders"), backed by live data, with its own signup form.
   * This is the organic acquisition surface that grows without any work from the operator.
   */
  app.get('/sectors/:code', async (req, reply) => {
    const { code } = req.params as { code: string };
    const sector = CPV_SECTORS.find((s2) => s2.code === code.replace(/\D/g, ''));
    if (!sector) return reply.code(404).type('text/html').send(layout({ title: 'Not found', body: '<h1>Unknown sector</h1>' }));

    const rows = listNotices({ limit: 20, cpvPrefix: sector.code });
    const countries = db()
      .prepare(
        `SELECT buyer_country c, COUNT(*) n FROM notices
         WHERE cpv LIKE ? AND buyer_country IS NOT NULL
         GROUP BY buyer_country ORDER BY n DESC LIMIT 8`,
      )
      .all(`${sector.code}%`) as any[];

    const body = `
      <h1 style="margin-top:32px">${h(sector.label)} tenders in the EU</h1>
      <p class="lede">Every CPV ${h(sector.code)}xxxxxx notice published on TED, indexed daily and
      summarised in plain English. ${rows.length ? `Showing the ${rows.length} most recent.` : ''}</p>
      <form class="inline" method="post" action="/subscribe">
        <input type="email" name="email" placeholder="you@company.com" required>
        <input type="hidden" name="cpv_prefixes" value="${h(sector.code)}">
        <input type="text" name="website" style="display:none" tabindex="-1" autocomplete="off">
        <button class="btn" type="submit">Email me new ${h(sector.label.toLowerCase())} tenders</button>
      </form>
      ${countries.length ? `<p style="font-size:14px;color:#64748b">Most active buyers by country:
        ${countries.map((c) => `${h(c.c)} (${c.n})`).join(' · ')}</p>` : ''}
      <h2>Recent notices</h2>
      ${rows.map(tenderCard).join('') || '<p>No notices indexed in this sector yet.</p>'}
      <p style="margin-top:24px"><a class="btn secondary" href="/tenders?cpv=${h(sector.code)}">Browse all →</a></p>
      <h2>Other sectors</h2>
      <p>${CPV_SECTORS.filter((s2) => s2.code !== sector.code)
        .map((s2) => `<a class="tag" href="/sectors/${s2.code}">${h(s2.label)}</a>`).join(' ')}</p>`;

    return html(reply, layout({
      title: `${sector.label} tenders in the EU — ${config.brand.name}`,
      description: `Live EU public procurement notices for ${sector.label.toLowerCase()} (CPV ${sector.code}), updated daily from the official TED feed.`,
      canonical: `${config.baseUrl}/sectors/${sector.code}`,
      body,
    }));
  });

  // -------------------------------------------------------------- pricing
  app.get('/pricing', async (req, reply) => {
    const canceled = (req.query as any).canceled ? '<div class="notice">Checkout canceled — no charge was made.</div>' : '';
    const body = `${canceled}
      <h1 style="margin-top:32px">One plan. Every match, every morning.</h1>
      <div class="grid">
        <div class="card"><h3>Free</h3><div class="price">€0</div>
          <p>Weekly digest, top 5 matches, full public archive.</p>
          <p style="margin-top:14px"><a class="btn secondary" href="/">Get the weekly digest</a></p></div>
        <div class="card" style="border-color:#1d4ed8">
          <h3>Pro</h3><div class="price">${h(config.billing.priceLabel)}</div>
          <p>Daily alerts · unlimited matches · custom CPV, NUTS, keyword and value filters ·
             exclusion terms · match explanations · cancel anytime.</p>
          <form class="inline" method="post" action="/checkout" style="margin-top:14px">
            <input type="email" name="email" placeholder="you@company.com" required>
            <button class="btn" type="submit">Start ${config.billing.trialDays}-day trial</button>
          </form>
          ${stripeEnabled() ? '' : '<p style="color:#991b1b;font-size:13px">Billing not configured yet (set STRIPE_* env vars).</p>'}
        </div>
      </div>
      <h2>Questions</h2>
      <table class="kv">
        <tr><td>Where does the data come from?</td><td>The official EU TED Search API — the legal source of record for EU public procurement above threshold.</td></tr>
        <tr><td>Can I cancel?</td><td>One click in the Stripe billing portal, any time. No contract.</td></tr>
        <tr><td>Do you email me every day?</td><td>Only when something new matches. Empty days stay silent.</td></tr>
      </table>`;
    return html(reply, layout({ title: `Pricing — ${config.brand.name}`, body, canonical: `${config.baseUrl}/pricing` }));
  });

  // ------------------------------------------------------------ subscribe
  //
  // Double opt-in: the address is stored unconfirmed and receives nothing but a
  // confirmation email until the user clicks. Required under GDPR + German UWG §7,
  // and it is also the single best protection for sender reputation.
  app.post('/subscribe', async (req, reply) => {
    const limited = limitOr429(req, reply, 'subscribe', 5, 60_000);
    if (limited) return limited;

    const b = (req.body ?? {}) as Record<string, string>;
    const email = (b.email ?? '').trim();
    if (b.website) return html(reply, layout({ title: 'Thanks', body: '<p>Thanks.</p>' })); // honeypot
    if (!isValidEmail(email)) {
      return html(reply.code(400), layout({
        title: 'Invalid email',
        body: '<div class="notice error">That email address does not look valid.</div><p><a href="/">Try again</a></p>',
      }));
    }

    const sub = createSubscriber(email, {
      cpv_prefixes: (b.cpv_prefixes ?? '72,48').replace(/[^\d,]/g, '') || '72,48',
      cadence: 'weekly',
    });
    logEvent('subscriber.created', { id: sub.id, source: 'landing' });

    if (sub.confirmed_at) {
      const token = signToken({ sub: sub.id, scope: 'account' });
      return html(reply, layout({
        title: 'Already subscribed',
        body: `<h1 style="margin-top:32px">You're already subscribed.</h1>
          <p class="lede">Nothing to do. You can fine-tune your filters any time.</p>
          <p><a class="btn" href="/account?t=${encodeURIComponent(token)}">Adjust my filters →</a></p>`,
      }));
    }

    const confirmUrl = `${config.baseUrl}/confirm?t=${signToken({ sub: sub.id, scope: 'confirm' }, 30)}`;
    const mail = confirmEmail(confirmUrl);
    await sendMail({ to: sub.email, ...mail }).catch((err) => req.log.error(err));

    const devHint = config.mail.transport === 'outbox'
      ? `<p style="font-size:13px;color:#6b7280">Dev mode: confirmation written to data/outbox.
         <a href="${h(confirmUrl)}">Confirm now</a>.</p>`
      : '';
    return html(reply, layout({
      title: 'Confirm your subscription',
      body: `<h1 style="margin-top:32px">Check your inbox.</h1>
        <p class="lede">We sent a confirmation link to <strong>${h(sub.email)}</strong>.
        Click it and your alerts start — we send nothing until you do.</p>${devHint}`,
    }));
  });

  app.get('/confirm', async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const claims = q.t ? verifyToken<{ sub: number; scope: string }>(q.t) : null;
    if (!claims?.sub || claims.scope !== 'confirm' || !getSubscriber(claims.sub)) {
      return html(reply.code(400), layout({
        title: 'Link expired',
        body: `<h1 style="margin-top:32px">That link has expired.</h1>
          <p class="lede">Confirmation links are valid for 30 days.
          <a href="/">Sign up again</a> and we'll send a fresh one.</p>`,
      }));
    }
    confirmSubscriber(claims.sub);
    logEvent('subscriber.confirmed', { id: claims.sub });
    const token = signToken({ sub: claims.sub, scope: 'account' });
    return html(reply, layout({
      title: 'Subscription confirmed',
      body: `<h1 style="margin-top:32px">Confirmed. You're in.</h1>
        <p class="lede">Your first weekly digest goes out on the next run. Tune your filters now so it lands relevant.</p>
        <p><a class="btn" href="/account?t=${encodeURIComponent(token)}">Set my filters →</a>
        <a class="btn secondary" style="margin-left:10px" href="/pricing">Upgrade to daily alerts</a></p>`,
    }));
  });

  // ------------------------------------------------------------- checkout
  app.post('/checkout', async (req, reply) => {
    const limited = limitOr429(req, reply, 'checkout', 10, 60_000);
    if (limited) return limited;
    const b = (req.body ?? {}) as Record<string, string>;
    const email = (b.email ?? '').trim();
    if (!isValidEmail(email)) return reply.code(400).send({ error: 'invalid email' });
    if (!stripeEnabled()) {
      return html(reply.code(503), layout({
        title: 'Billing not configured',
        body: '<div class="notice error">Billing is not configured on this instance yet. Set STRIPE_SECRET_KEY and STRIPE_PRICE_ID.</div>',
      }));
    }
    try {
      const url = await createCheckoutSession(email);
      return reply.redirect(url, 303);
    } catch (err) {
      req.log.error(err);
      return html(reply.code(500), layout({ title: 'Checkout error', body: '<div class="notice error">Could not start checkout. Please try again.</div>' }));
    }
  });

  app.get('/welcome', async (_req, reply) => {
    const body = `<h1 style="margin-top:32px">Welcome aboard.</h1>
      <p class="lede">Your trial is live. Set your filters and your first daily alert arrives on the next run.</p>
      <p><a class="btn" href="/account">Set my filters →</a></p>`;
    return html(reply, layout({ title: 'Welcome', body }));
  });

  app.post('/stripe/webhook', async (req, reply) => {
    const sig = req.headers['stripe-signature'];
    if (typeof sig !== 'string') return reply.code(400).send({ error: 'missing signature' });
    try {
      const result = await handleWebhook((req as any).rawBody, sig);
      return reply.send(result);
    } catch (err) {
      req.log.error(err);
      return reply.code(400).send({ error: 'webhook verification failed' });
    }
  });

  // --------------------------------------------------------------- account
  const accountForm = (subId: number, token: string, saved: boolean): string => {
    const s = getSubscriber(subId)!;
    const p = getProfile(subId)!;
    const planLabel = ({ active: 'Pro (active)', trialing: `Pro (trial)`, past_due: 'Pro (payment failed)', canceled: 'Canceled', free: 'Free weekly' } as Record<string, string>)[s.status] ?? s.status;
    return `
    ${saved ? '<div class="notice ok">Filters saved.</div>' : ''}
    <h1 style="margin-top:32px">Your alert filters</h1>
    <p class="lede">${h(s.email)} · ${h(planLabel)}</p>
    <form method="post" action="/account">
      <input type="hidden" name="t" value="${h(token)}">
      <div class="row">
        <div><label>CPV prefixes (comma separated)</label>
          <input name="cpv_prefixes" value="${h(p.cpv_prefixes)}" style="width:100%"></div>
        <div><label>Buyer countries (ISO3, empty = all)</label>
          <input name="countries" value="${h(p.countries)}" style="width:100%"></div>
      </div>
      <div class="row">
        <div><label>NUTS region prefixes (e.g. DE1,DE2)</label>
          <input name="nuts_prefixes" value="${h(p.nuts_prefixes)}" style="width:100%"></div>
        <div><label>Keywords (boost matches)</label>
          <input name="keywords" value="${h(p.keywords)}" style="width:100%"></div>
      </div>
      <div class="row">
        <div><label>Exclude terms (hard filter)</label>
          <input name="exclude_words" value="${h(p.exclude_words)}" style="width:100%"></div>
        <div><label>Cadence</label>
          <select name="cadence" style="width:100%">
            <option value="daily"${p.cadence === 'daily' ? ' selected' : ''}>Daily (Pro)</option>
            <option value="weekly"${p.cadence === 'weekly' ? ' selected' : ''}>Weekly</option>
          </select></div>
      </div>
      <div class="row">
        <div><label>Minimum contract value (EUR)</label>
          <input name="min_value" type="number" min="0" value="${p.min_value ?? ''}" style="width:100%"></div>
        <div><label>Maximum contract value (EUR)</label>
          <input name="max_value" type="number" min="0" value="${p.max_value ?? ''}" style="width:100%"></div>
      </div>
      <label>Minimum match score (0–1) — raise it if you get too much</label>
      <input name="min_score" type="number" step="0.05" min="0" max="1" value="${p.min_score}">
      <p style="margin-top:20px"><button class="btn" type="submit">Save filters</button>
      ${s.stripe_customer_id ? `<a class="btn secondary" style="margin-left:10px" href="/billing-portal?t=${h(token)}">Manage billing</a>` : `<a class="btn secondary" style="margin-left:10px" href="/pricing">Upgrade to Pro</a>`}
      </p>
    </form>
    <p style="margin-top:24px;font-size:13px"><a href="${h(unsubscribeUrl(subId))}">Unsubscribe from all emails</a></p>`;
  };

  app.get('/account', async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const claims = q.t ? verifyToken<{ sub: number }>(q.t) : null;
    if (!claims?.sub || !getSubscriber(claims.sub)) {
      const body = `<h1 style="margin-top:32px">Find your settings link</h1>
        <p class="lede">Every email we send contains a private link to this page. Enter your address and we'll send it again.</p>
        <form class="inline" method="post" action="/account/link">
          <input type="email" name="email" placeholder="you@company.com" required>
          <button class="btn" type="submit">Email me my link</button></form>`;
      return html(reply, layout({ title: 'Account', body }));
    }
    return html(reply, layout({ title: 'Your filters', body: accountForm(claims.sub, q.t!, q.saved === '1') }));
  });

  app.post('/account', async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, string>;
    const claims = verifyToken<{ sub: number }>(b.t ?? '');
    if (!claims?.sub) return reply.code(403).send({ error: 'invalid or expired link' });
    const num = (v: string | undefined): number | null => {
      const n = Number.parseFloat(v ?? '');
      return Number.isFinite(n) ? n : null;
    };
    updateProfile(claims.sub, {
      cpv_prefixes: (b.cpv_prefixes ?? '').replace(/[^\d,]/g, ''),
      countries: (b.countries ?? '').toUpperCase().replace(/[^A-Z,]/g, ''),
      nuts_prefixes: (b.nuts_prefixes ?? '').toUpperCase().replace(/[^A-Z0-9,]/g, ''),
      keywords: (b.keywords ?? '').slice(0, 500),
      exclude_words: (b.exclude_words ?? '').slice(0, 500),
      min_value: num(b.min_value),
      max_value: num(b.max_value),
      min_score: Math.min(1, Math.max(0, num(b.min_score) ?? 0.35)),
      cadence: b.cadence === 'weekly' ? 'weekly' : 'daily',
    });
    return reply.redirect(`/account?t=${encodeURIComponent(b.t!)}&saved=1`, 303);
  });

  app.post('/account/link', async (req, reply) => {
    const limited = limitOr429(req, reply, 'account-link', 5, 300_000);
    if (limited) return limited;

    const b = (req.body ?? {}) as Record<string, string>;
    const email = (b.email ?? '').trim();
    const sub = isValidEmail(email) ? getSubscriberByEmail(email) : null;
    if (sub) {
      const mail = accountLinkEmail(accountUrl(sub.id));
      await sendMail({ to: sub.email, ...mail }).catch((err) => req.log.error(err));
    }
    logEvent('account.link.requested', { found: Boolean(sub) });
    // Identical response either way: no account enumeration.
    const body = `<h1 style="margin-top:32px">Check your inbox</h1>
      <p class="lede">If ${h(email || 'that address')} is subscribed, your private settings link is on its way.</p>`;
    return html(reply, layout({ title: 'Link sent', body }));
  });

  app.get('/billing-portal', async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const claims = q.t ? verifyToken<{ sub: number }>(q.t) : null;
    const sub = claims?.sub ? getSubscriber(claims.sub) : null;
    if (!sub?.stripe_customer_id) return reply.code(403).send({ error: 'no billing account' });
    const url = await createPortalSession(sub.stripe_customer_id);
    return reply.redirect(url, 303);
  });

  app.get('/unsubscribe', async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const claims = q.t ? verifyToken<{ sub: number }>(q.t) : null;
    if (claims?.sub) {
      unsubscribe(claims.sub);
      logEvent('subscriber.unsubscribed', { id: claims.sub });
    }
    return html(reply, layout({
      title: 'Unsubscribed',
      body: '<h1 style="margin-top:32px">Unsubscribed.</h1><p class="lede">You will not receive further emails. No hard feelings.</p>',
    }));
  });

  // One-click unsubscribe (RFC 8058) — required by Gmail/Yahoo bulk sender rules.
  app.post('/unsubscribe', async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const claims = q.t ? verifyToken<{ sub: number }>(q.t) : null;
    if (claims?.sub) unsubscribe(claims.sub);
    return reply.code(200).send('ok');
  });

  // ------------------------------------------------------------ SEO plumbing
  app.get('/feed.xml', async (_req, reply) => {
    const rows = listNotices({ limit: 50 });
    const items = rows.map((n) => `<item>
      <title>${h(n.title)}</title>
      <link>${config.baseUrl}/tender/${encodeURIComponent(n.id)}</link>
      <guid isPermaLink="false">${h(n.id)}</guid>
      <pubDate>${new Date(`${n.publication_date ?? n.first_seen_at.slice(0, 10)}T00:00:00Z`).toUTCString()}</pubDate>
      <description>${h(n.summary ?? '')}</description></item>`).join('');
    return reply.type('application/rss+xml').send(
      `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel>
       <title>${h(config.brand.name)} — EU public IT tenders</title>
       <link>${config.baseUrl}</link><description>${h(config.brand.tagline)}</description>${items}</channel></rss>`,
    );
  });

  app.get('/sitemap.xml', async (_req, reply) => {
    const rows = listNotices({ limit: 5000 });
    const urls = ['', '/tenders', '/pricing', '/legal']
      .concat(CPV_SECTORS.map((s2) => `/sectors/${s2.code}`))
      .map((p) => `<url><loc>${config.baseUrl}${p}</loc></url>`)
      .concat(rows.map((n) => `<url><loc>${config.baseUrl}/tender/${encodeURIComponent(n.id)}</loc>${
        n.publication_date ? `<lastmod>${n.publication_date}</lastmod>` : ''}</url>`));
    return reply.type('application/xml').send(
      `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.join('')}</urlset>`,
    );
  });

  app.get('/robots.txt', async (_req, reply) =>
    reply.type('text/plain').send(`User-agent: *\nAllow: /\nSitemap: ${config.baseUrl}/sitemap.xml\n`));

  app.get('/legal', async (_req, reply) => {
    const body = `<h1 style="margin-top:32px">Legal &amp; privacy</h1>
      <h2>Data source and reuse</h2>
      <p>All procurement notices shown here originate from Tenders Electronic Daily (TED), published by the
      Publications Office of the European Union, and are reused under Commission Decision 2011/833/EU on the reuse
      of Commission documents. ${h(config.brand.name)} is independent and not affiliated with, or endorsed by, the
      European Union. The official notice on ted.europa.eu is always the legally binding version.</p>
      <h2>What we store</h2>
      <p>Your email address, your alert filters, and a record of which notices we have already sent you (so we never
      repeat one). Payment data is handled entirely by Stripe; we never see card details.</p>
      <h2>Your rights</h2>
      <p>Unsubscribe in one click from any email — that stops all sending. Email
      <a href="mailto:${h(config.brand.replyTo)}">${h(config.brand.replyTo)}</a> to request export or deletion of your data.</p>
      <h2>Operator</h2><p>${h(config.brand.legalName)}<br>${h(config.brand.legalAddress)}</p>`;
    return html(reply, layout({ title: 'Legal & privacy', body, canonical: `${config.baseUrl}/legal` }));
  });

  // ----------------------------------------------------------------- ops
  app.get('/healthz', async (_req, reply) => {
    const jobs = db()
      .prepare('SELECT job, started_at, ended_at, ok, stats, error FROM job_runs ORDER BY id DESC LIMIT 8')
      .all() as Array<{ job: string; started_at: string; ended_at: string | null; ok: number | null; stats: string | null; error: string | null }>;

    // Turn the raw job log into a single verdict an uptime monitor can alert on.
    const problems: string[] = [];
    const lastIngest = jobs.find((j) => j.job === 'ingest');
    const staleAfterHours = 36;
    if (!lastIngest) {
      problems.push('no ingest has ever run');
    } else {
      const ageHours = (Date.now() - Date.parse(lastIngest.started_at)) / 3_600_000;
      if (ageHours > staleAfterHours) problems.push(`last ingest was ${Math.round(ageHours)}h ago`);
      if (lastIngest.ok === 0) problems.push('last ingest failed');
    }
    for (const j of jobs) {
      if (j.ok === 0) problems.push(`${j.job} failed`);
      const failed = Number(JSON.parse(j.stats ?? '{}')?.failed ?? 0);
      if (failed > 0) problems.push(`${j.job}: ${failed} recipient send failure(s)`);
    }

    const degraded = problems.length > 0;
    // Liveness (Docker healthcheck) and business-health (uptime monitor) are different
    // questions. A brand-new box with no ingest yet is alive but degraded — returning 503
    // here would make Docker restart-loop it. Monitors ask for ?strict=1.
    const strict = (_req.query as Record<string, string | undefined>).strict === '1';
    return reply.code(strict && degraded ? 503 : 200).send({
      ok: !degraded,
      degraded,
      problems: [...new Set(problems)],
      notices: countNotices(),
      subscribers: subscriberStats(),
      stripe: stripeEnabled(),
      mail: config.mail.transport,
      offline: config.ted.offline,
      recentJobs: jobs,
    });
  });

  /**
   * Operator dashboard. Token-gated with APP_SECRET so there is no login to maintain:
   *   https://yourdomain/admin?key=$APP_SECRET
   */
  app.get('/admin', async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    if (q.key !== config.security.secret) {
      return reply.code(403).type('text/html').send(layout({
        title: 'Forbidden',
        body: '<div class="notice error">Add ?key=YOUR_APP_SECRET to this URL.</div>',
      }));
    }
    const d = db();
    const subs = subscriberStats();
    const notices = noticeStats();
    const mrr = subs.paying * (Number.parseFloat((config.billing.priceLabel.match(/[\d.]+/) ?? ['0'])[0]) || 0);
    const jobs = d
      .prepare('SELECT job, started_at, ended_at, ok, stats, error FROM job_runs ORDER BY id DESC LIMIT 15')
      .all() as any[];
    const recentSubs = d
      .prepare('SELECT email, status, plan, confirmed_at, created_at FROM subscribers ORDER BY id DESC LIMIT 15')
      .all() as any[];
    const funnel = d
      .prepare(`SELECT kind, COUNT(*) c FROM events WHERE created_at >= date('now','-30 day') GROUP BY kind ORDER BY c DESC LIMIT 15`)
      .all() as any[];

    const jobRows = jobs.map((j) => `<tr>
      <td>${h(j.job)}</td><td>${h((j.started_at ?? '').slice(0, 19).replace('T', ' '))}</td>
      <td>${j.ok === 1 ? '<span style="color:#166534">ok</span>' : j.ok === 0 ? '<span style="color:#991b1b">FAILED</span>' : 'running'}</td>
      <td style="font-size:12px;color:#475569">${h((j.error ?? j.stats ?? '').slice(0, 160))}</td></tr>`).join('');
    const subRows = recentSubs.map((r) => `<tr><td>${h(r.email)}</td><td>${h(r.status)}</td>
      <td>${r.confirmed_at ? 'yes' : '<span style="color:#b45309">pending</span>'}</td>
      <td>${h((r.created_at ?? '').slice(0, 10))}</td></tr>`).join('');
    const funnelRows = funnel.map((f) => `<tr><td>${h(f.kind)}</td><td>${f.c}</td></tr>`).join('');

    const body = `<h1 style="margin-top:32px">Operations</h1>
      <div class="grid">
        <div class="card"><div class="stat">€${mrr.toLocaleString('en-GB')}</div><p>MRR (${subs.paying} paying)</p></div>
        <div class="card"><div class="stat">${subs.confirmed}</div><p>confirmed subscribers</p></div>
        <div class="card"><div class="stat">${subs.pending}</div><p>awaiting opt-in confirmation</p></div>
        <div class="card"><div class="stat">${notices.total.toLocaleString('en-GB')}</div><p>notices (${notices.last7} in 7d)</p></div>
        <div class="card"><div class="stat">${subs.suppressed}</div><p>suppressed addresses</p></div>
        <div class="card"><div class="stat">${config.mail.transport}</div><p>mail transport · stripe ${stripeEnabled() ? 'on' : 'off'}</p></div>
      </div>
      <h2>Recent job runs</h2>
      <table class="kv"><tr><td>Job</td><td>Started</td><td>Result</td><td>Detail</td></tr>${jobRows}</table>
      <h2>Newest subscribers</h2>
      <table class="kv"><tr><td>Email</td><td>Status</td><td>Confirmed</td><td>Joined</td></tr>${subRows}</table>
      <h2>Events (30 days)</h2>
      <table class="kv">${funnelRows}</table>
      <h2>Run a job now</h2>
      <form method="post" action="/admin/run?key=${h(q.key)}" class="inline">
        <select name="job">
          <option value="ingest">ingest</option>
          <option value="digest-daily">digest-daily</option>
          <option value="digest-weekly">digest-weekly</option>
          <option value="backup">backup</option>
          <option value="prune">prune</option>
        </select>
        <button class="btn" type="submit">Run</button>
      </form>`;
    return html(reply, layout({ title: 'Operations', body }));
  });

  app.post('/admin/run', async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    if (q.key !== config.security.secret) return reply.code(403).send({ error: 'forbidden' });
    const job = ((req.body ?? {}) as any).job as string;
    const result = await runNamedJob(job);
    if (!result) return reply.code(404).send({ error: 'unknown job' });
    return html(reply, layout({
      title: 'Job finished',
      body: `<h1 style="margin-top:32px">${h(job)}</h1>
        <pre style="background:#f8fafc;padding:14px;border-radius:9px;overflow:auto;font-size:13px">${h(JSON.stringify(result, null, 2))}</pre>
        <p><a class="btn secondary" href="/admin?key=${h(q.key)}">← Back</a></p>`,
    }));
  });

  /**
   * Bounce/complaint webhook for the email provider (Resend, Brevo, Mailgun, Postmark …).
   * Point your ESP here with ?key=APP_SECRET. Any recognised bounce or complaint payload
   * suppresses the address permanently, which is what keeps the sending domain healthy.
   */
  app.post('/mail/webhook', async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    if (q.key !== config.security.secret) return reply.code(403).send({ error: 'forbidden' });
    const payload = (req.body ?? {}) as any;
    const flat = JSON.stringify(payload).toLowerCase();
    const email: string | undefined =
      payload?.data?.to?.[0] ?? payload?.email ?? payload?.recipient ?? payload?.Email ??
      payload?.data?.email ?? payload?.['event-data']?.recipient;
    const isBad = /bounce|complaint|complained|spam|dropped|failed|invalid/.test(flat);
    if (email && isBad) {
      suppress(email, /complain|spam/.test(flat) ? 'complaint' : 'hard-bounce', flat.slice(0, 300));
      logEvent('mail.suppression.added', { email });
      return reply.send({ suppressed: email });
    }
    return reply.send({ ignored: true });
  });

  /** Manual job triggers, protected by APP_SECRET, for cron-from-outside setups. */
  app.post('/ops/:job', async (req, reply) => {
    const key = req.headers['x-ops-key'];
    if (key !== config.security.secret) return reply.code(403).send({ error: 'forbidden' });
    const { job } = req.params as { job: string };
    const result = await runNamedJob(job);
    if (!result) return reply.code(404).send({ error: 'unknown job' });
    return result;
  });

  return app;
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop() ?? '#');
if (isMain) {
  const app = buildServer();
  app.listen({ port: config.port, host: config.host }).then(() => {
    console.log(`${config.brand.name} listening on http://${config.host}:${config.port}`);
    startScheduler();
    startRateLimitSweeper();
  }).catch((err) => {
    console.error(err);
    process.exit(1);
  });

  // Graceful shutdown: finish in-flight requests, checkpoint the WAL, then exit.
  // Docker sends SIGTERM on `stop`/`restart`/redeploy; without this a send loop or a
  // write can be cut mid-transaction.
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[shutdown] ${signal} received, draining…`);
    const forceExit = setTimeout(() => {
      console.error('[shutdown] drain timed out after 15s, forcing exit');
      process.exit(1);
    }, 15_000);
    forceExit.unref();
    try {
      await app.close();
      closeDb();
      console.log('[shutdown] clean');
      process.exit(0);
    } catch (err) {
      console.error('[shutdown] error while draining', err);
      process.exit(1);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  // A crash inside a background job must be logged, not silently swallowed.
  process.on('unhandledRejection', (reason) => {
    console.error('[unhandledRejection]', reason);
    try {
      logEvent('process.unhandledRejection', { reason: String(reason) });
    } catch { /* logging must never mask the original failure */ }
  });
}
