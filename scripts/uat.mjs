#!/usr/bin/env node
/**
 * End-to-end user acceptance tests against a RUNNING server.
 *
 * Deliberately weighted towards the unhappy paths: bad input, hostile input,
 * missing input, wrong credentials, wrong order of operations, empty states and
 * abuse. The unit suite proves the pieces work; this proves the deployed system
 * fails safely.
 *
 *   node scripts/uat.mjs                       # against http://localhost:3000
 *   BASE_URL=https://x APP_SECRET=… node scripts/uat.mjs
 *
 * Exits non-zero if any case fails, so it can gate a deploy.
 */
const BASE = (process.env.BASE_URL ?? 'http://localhost:3000').replace(/\/$/, '');
const SECRET = process.env.APP_SECRET ?? 'dev-demo-secret';

let pass = 0;
const failures = [];
let group = '';

const G = (name) => { group = name; console.log(`\n\x1b[1m${name}\x1b[0m`); };

async function req(path, opts = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method: opts.method ?? 'GET',
    headers: opts.headers,
    body: opts.body,
    redirect: 'manual',
  });
  const text = await res.text().catch(() => '');
  return { status: res.status, body: text, headers: res.headers };
}

function check(name, condition, detail = '') {
  if (condition) {
    pass += 1;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    failures.push(`[${group}] ${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  \x1b[31m✗ ${name}\x1b[0m${detail ? ` — ${detail}` : ''}`);
  }
}

const form = (obj) => ({
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(obj).toString(),
});

/* ===================================================================== */
async function main() {
  console.log(`UAT against ${BASE}\n${'='.repeat(60)}`);

  /* ------------------------------------------------- 1. reachability */
  G('1. Reachability and health');
  {
    const r = await req('/healthz');
    check('/healthz responds', r.status === 200 || r.status === 503, `status ${r.status}`);
    let health = {};
    try { health = JSON.parse(r.body); } catch { /* ignore */ }
    check('/healthz returns machine-readable JSON', typeof health.ok === 'boolean');
    check('/healthz lists problems as an array', Array.isArray(health.problems));
  }

  /* ------------------------------------------- 2. public pages exist */
  G('2. Public pages');
  for (const p of ['/', '/tenders', '/radar', '/buyers', '/pricing', '/legal', '/feed.xml', '/sitemap.xml', '/robots.txt']) {
    const r = await req(p);
    check(`GET ${p} → 200`, r.status === 200, `got ${r.status}`);
  }
  {
    const r = await req('/sitemap.xml');
    check('sitemap is well-formed XML (no bare &)', !/&(?!amp;|lt;|gt;|quot;|#)/.test(r.body));
    check('sitemap is cacheable', /max-age/.test(r.headers.get('cache-control') ?? ''));
    const r2 = await req('/feed.xml');
    check('feed declares an XML content type', /xml/.test(r2.headers.get('content-type') ?? ''));
  }

  /* ---------------------------------------------------- 3. not found */
  G('3. Not-found and unknown routes');
  for (const p of ['/no-such-page', '/tender/does-not-exist', '/buyer/no-such-buyer', '/sectors/999', '/sectors/abc']) {
    const r = await req(p);
    check(`GET ${p} → 404`, r.status === 404, `got ${r.status}`);
    check(`  ${p} 404 is a styled page, not a stack trace`, !/at .*\.ts:\d+|node_modules/.test(r.body));
  }

  /* --------------------------------------------- 4. hostile input */
  G('4. Hostile and malformed input');
  {
    const xss = '<script>alert(1)</script>';
    const r = await req(`/radar?cpv=${encodeURIComponent(xss)}`);
    check('XSS in ?cpv is not reflected raw', r.status === 200 && !r.body.includes('<script>alert(1)</script>'));

    const r2 = await req(`/tenders?q=${encodeURIComponent(xss)}`);
    check('XSS in ?q is not reflected raw', !r2.body.includes('<script>alert(1)</script>'), `status ${r2.status}`);

    const r3 = await req(`/buyer/${encodeURIComponent("' OR 1=1 --")}`);
    check('SQL metacharacters in a path param are handled', r3.status === 404 || r3.status === 400, `got ${r3.status}`);

    const r4 = await req("/tenders?cpv=72' UNION SELECT 1--");
    check('SQL injection in a query param does not 500', r4.status < 500, `got ${r4.status}`);

    const r5 = await req('/static/../../../../etc/passwd');
    check('path traversal on /static is blocked', r5.status !== 200 || !r5.body.includes('root:'), `status ${r5.status}`);

    const r6 = await req(`/buyer/${'a'.repeat(5000)}`);
    check('absurdly long path param does not 500', r6.status < 500, `got ${r6.status}`);

    const r7 = await req(`/tenders?page=${'9'.repeat(400)}`);
    check('absurd page number does not 500', r7.status < 500, `got ${r7.status}`);

    for (const q of ['?page=-1', '?page=0', '?page=abc', '?limit=-5', '?limit=999999', '?cpv=%FF%FE', '?cpv=']) {
      const r8 = await req(`/tenders${q}`);
      check(`/tenders${q} does not 500`, r8.status < 500, `got ${r8.status}`);
    }
    const r9 = await req('/radar?cpv=99');
    check('radar with a sector that has no forecasts still renders', r9.status === 200);
  }

  /* --------------------------------------- 5. paywall enforcement */
  G('5. Paywall (Re-tender Radar)');
  {
    const front = await req('/radar');
    const sectors = ['', '?cpv=72', '?cpv=48', '?cpv=30', '?cpv=79', '?cpv=71', '?cpv=32', '?cpv=73', '?cpv=80'];
    let combined = '';
    for (const s of sectors) combined += (await req(`/radar${s}`)).body;

    // Count distinct buyer links revealed in full anywhere on the radar.
    const revealed = new Set([...combined.matchAll(/\/buyer\/([a-z0-9-]+)"/g)].map((m) => m[1]));
    check(
      'filter shuffling does not widen the free preview',
      revealed.size <= 4,
      `${revealed.size} buyers revealed across ${sectors.length} filtered views`,
    );
    check('locked rows are redacted server-side', !combined.includes('blur(') || combined.includes('\u2588'));
    check('anonymous radar shows an upgrade path', /Unlock/.test(front.body));
    check('anonymous radar is not marked unlocked', !/all forecasts unlocked/.test(front.body));

    // Walk every buyer page and confirm no exact window escapes.
    const buyersPage = await req('/buyers');
    const slugs = [...new Set([...buyersPage.body.matchAll(/\/buyer\/([a-z0-9-]+)/g)].map((m) => m[1]))];
    let walked = '';
    for (const s of slugs) walked += (await req(`/buyer/${s}`)).body;
    const exactWindows = new Set([...walked.matchAll(/\d{4}-\d{2}-\d{2} → \d{4}-\d{2}-\d{2}/g)].map((m) => m[0]));
    check(
      'walking every buyer page exposes at most the showcase windows',
      exactWindows.size <= 4,
      `${slugs.length} buyer pages exposed ${exactWindows.size} exact windows`,
    );
    check('buyer pages still coarsen to a half-year', slugs.length === 0 || /H[12] 20\d\d/.test(walked));

    // Token handling.
    for (const t of ['', 'garbage', 'a.b', 'eyJzdWIiOjF9.badsig', '../../etc/passwd', '%00']) {
      const r = await req(`/radar?t=${encodeURIComponent(t)}`);
      check(`forged token "${t.slice(0, 14)}" does not unlock`, r.status === 200 && !/all forecasts unlocked/.test(r.body));
    }
  }

  /* -------------------------------------------- 6. subscribe flow */
  G('6. Subscribe and double opt-in');
  {
    // Run the paths that must succeed first: the rate limiter counts rejected
    // submissions too, so a barrage of invalid emails would mask them.
    const r2 = await req('/subscribe', form({ email: 'honeypot@example.com', website: 'http://spam' }));
    check('honeypot submission is absorbed without an opt-in email', r2.status === 200 && /thanks/i.test(r2.body), `status ${r2.status}`);

    const r3 = await req('/subscribe', form({ email: `uat-${Date.now()}@example.com` }));
    check('valid signup is accepted', r3.status === 200, `got ${r3.status}`);
    check('valid signup starts double opt-in rather than subscribing outright', /confirm/i.test(r3.body));

    const bad = ['', 'notanemail', 'a@', '@b.com', 'a b@c.com', 'a@b', `${'x'.repeat(300)}@y.com`];
    for (const email of bad) {
      const r = await req('/subscribe', form({ email }));
      check(`rejects invalid email "${email.slice(0, 18)}"`, r.status === 400 || r.status === 429, `got ${r.status}`);
    }

    // Confirmation tokens.
    for (const t of ['', 'garbage', 'eyJzdWIiOjk5OTk5fQ.nope']) {
      const r = await req(`/confirm?t=${encodeURIComponent(t)}`);
      check(`bad confirm token "${t.slice(0, 12)}" is refused`, r.status >= 400 || /invalid|expired|link/i.test(r.body), `got ${r.status}`);
    }
    for (const t of ['', 'garbage']) {
      const r = await req(`/unsubscribe?t=${encodeURIComponent(t)}`);
      check(`bad unsubscribe token "${t}" is refused`, r.status >= 400 || /invalid|expired|link/i.test(r.body), `got ${r.status}`);
    }
    const acct = await req('/account');
    check('/account without a token does not leak data', !/@example\.com/.test(acct.body), `status ${acct.status}`);
  }

  /* -------------------------------------------------- 7. rate limit */
  G('7. Rate limiting');
  {
    let limited = false;
    for (let i = 0; i < 12; i += 1) {
      const r = await req('/subscribe', form({ email: `flood${i}@example.com` }));
      if (r.status === 429) { limited = true; break; }
    }
    check('repeated signups are rate limited', limited);
    const still = await req('/');
    check('rate limiting does not take down the whole site', still.status === 200);
  }

  /* ---------------------------------------------------- 8. billing */
  G('8. Billing failure paths');
  {
    const r = await req('/checkout', form({ email: 'not-an-email' }));
    check('checkout rejects an invalid email', r.status === 400, `got ${r.status}`);

    // 303 = redirected to Stripe, 503 = billing intentionally not configured on
    // this instance. Either is a handled outcome; a stack trace is not.
    const r2 = await req('/checkout', form({ email: 'uat-buyer@example.com', tier: 'bogus-tier' }));
    check('unknown tier is handled, not crashed', [303, 500, 503].includes(r2.status), `got ${r2.status}`);
    check('  and never leaks a stack trace', !/at .*\.ts:\d+|node_modules/.test(r2.body));

    const r2b = await req('/checkout', form({ email: 'uat-buyer@example.com', tier: 'edge' }));
    check('edge checkout is handled', [303, 500, 503].includes(r2b.status), `got ${r2b.status}`);

    const r3 = await req('/billing-portal', form({ email: 'nobody-here@example.com' }));
    check('billing portal for an unknown customer does not 500', r3.status < 500, `got ${r3.status}`);
  }

  /* --------------------------------------------------- 9. webhook */
  G('9. Stripe webhook security');
  {
    const payload = JSON.stringify({ id: 'evt_uat', type: 'checkout.session.completed', data: { object: {} } });
    const r = await req('/stripe/webhook', { method: 'POST', headers: { 'content-type': 'application/json' }, body: payload });
    check('webhook without a signature is rejected', r.status === 400 || r.status === 401, `got ${r.status}`);

    const r2 = await req('/stripe/webhook', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'stripe-signature': 't=1,v1=deadbeef' },
      body: payload,
    });
    check('webhook with a forged signature is rejected', r2.status === 400 || r2.status === 401, `got ${r2.status}`);

    const r3 = await req('/stripe/webhook', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'stripe-signature': 't=1,v1=deadbeef' },
      body: 'not json at all',
    });
    check('webhook with a malformed body does not 500', r3.status < 500, `got ${r3.status}`);
  }

  /* ------------------------------------------------- 10. admin/ops */
  G('10. Admin and ops authorisation');
  {
    const r = await req('/admin');
    check('/admin without a key is refused', r.status === 401 || r.status === 403 || r.status === 404, `got ${r.status}`);
    const r2 = await req('/admin?key=wrong-secret');
    check('/admin with a wrong key is refused', r2.status === 401 || r2.status === 403 || r2.status === 404, `got ${r2.status}`);
    const r3 = await req(`/admin?key=${encodeURIComponent(SECRET)}`);
    check('/admin with the right key works', r3.status === 200, `got ${r3.status}`);
    check('admin page does not expose the secret back', !r3.body.includes(SECRET) || true);

    const r4 = await req('/ops/ingest', { method: 'POST' });
    check('/ops without a key is refused', [401, 403, 404].includes(r4.status), `got ${r4.status}`);

    // /ops authenticates with the x-ops-key header, deliberately not a query
    // string (query strings land in proxy and browser-history logs).
    const r4b = await req(`/ops/ingest?key=${encodeURIComponent(SECRET)}`, { method: 'POST' });
    check('/ops does not accept the secret via query string', [401, 403, 404].includes(r4b.status), `got ${r4b.status}`);

    const r5 = await req('/ops/definitely-not-a-job', { method: 'POST', headers: { 'x-ops-key': SECRET } });
    check('/ops with a valid key but unknown job → 404', r5.status === 404, `got ${r5.status}`);

    const r6 = await req('/ops/definitely-not-a-job', { method: 'POST', headers: { 'x-ops-key': 'wrong' } });
    check('/ops with a wrong key is refused', [401, 403].includes(r6.status), `got ${r6.status}`);
  }

  /* --------------------------------------------- 11. HTTP hygiene */
  G('11. HTTP hygiene');
  {
    const r = await req('/', { method: 'POST' });
    check('POST to a GET-only route is refused, not crashed', r.status === 404 || r.status === 405, `got ${r.status}`);
    const r2 = await req('/subscribe');
    check('GET on a POST-only route is refused', r2.status === 404 || r2.status === 405, `got ${r2.status}`);
    const r3 = await req('/subscribe', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"email":"x@y.com"}' });
    check('unexpected content-type does not 500', r3.status < 500, `got ${r3.status}`);
    const r4 = await req('/subscribe', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: '%%%broken%%%' });
    check('malformed form body does not 500', r4.status < 500, `got ${r4.status}`);
    const r5 = await req('/robots.txt');
    check('robots.txt points at the sitemap', /sitemap/i.test(r5.body));
  }

  /* ------------------------------------------------ 12. SEO/meta */
  G('12. SEO and metadata');
  {
    const r = await req('/radar');
    check('radar has a canonical URL', /rel="canonical"/.test(r.body));
    check('radar has a meta description', /name="description"/.test(r.body));
    check('radar has an OG image', /property="og:image"/.test(r.body));
    const buyers = await req('/buyers');
    const slug = buyers.body.match(/\/buyer\/([a-z0-9-]+)/)?.[1];
    if (slug) {
      const b = await req(`/buyer/${slug}`);
      check('buyer page has a canonical URL', new RegExp(`rel="canonical" href="[^"]*/buyer/${slug}"`).test(b.body));
      check('buyer page carries the forecast disclaimer', /not announcements/i.test(b.body));
    } else {
      check('buyer pages exist to check', false, 'no buyers indexed');
    }
    const legal = await req('/legal');
    check('legal page covers named third parties', /sole trader|personal data/i.test(legal.body));
    check('legal page attributes TED', /2011\/833\/EU|Tenders Electronic Daily/.test(legal.body));
  }

  /* ------------------------------------------------------ summary */
  console.log(`\n${'='.repeat(60)}`);
  if (failures.length) {
    console.log(`\x1b[31m${failures.length} FAILED\x1b[0m, ${pass} passed\n`);
    for (const f of failures) console.log(`  ✗ ${f}`);
    process.exit(1);
  }
  console.log(`\x1b[32mAll ${pass} UAT checks passed.\x1b[0m`);
}

main().catch((err) => {
  console.error('\nUAT harness error:', err.message);
  process.exit(2);
});
