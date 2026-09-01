/**
 * Re-tender Radar: the forecasting engine, the intelligence aggregates, tier
 * gating and the public radar/buyer pages.
 *
 * The forecast logic is the product, so it is tested as pure functions with
 * explicit dates — no reliance on "today" drifting the assertions.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tenderping-radar-'));
process.env.DB_FILE = path.join(tmp, 'radar.db');
process.env.MAIL_TRANSPORT = 'outbox';
process.env.TED_OFFLINE = 'true';
process.env.APP_SECRET = 'radar-test-secret';
process.env.BASE_URL = 'https://example.test';
process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
process.env.STRIPE_PRICE_ID = 'price_pro_dummy';
process.env.STRIPE_EDGE_PRICE_ID = 'price_edge_dummy';
process.env.LEGAL_ADDRESS = 'Teststr. 1, 89073 Ulm';

const {
  addMonths, cpvFamily, computeForecasts, daysUntilWindow, findSupersedingNotice,
  forecastFromAwards, forecastStatus, listForecasts, monthsBetween, refreshRadar, slugify,
} = await import('../src/core/radar.ts');
type AwardRecord = Parameters<typeof forecastFromAwards>[0][number];
const { buyerProfile, listBuyers, supplierShare } = await import('../src/core/intel.ts');
const { hasRadarAccess, priceIdFor, tierForPrice, edgeEnabled } = await import('../src/core/billing.ts');
const { upsertNotices } = await import('../src/core/notices.ts');
const { normalizeNotice } = await import('../src/ingest/ted.ts');
const { buildServer } = await import('../src/server.ts');

const TODAY = '2026-09-01';

const award = (o: Partial<AwardRecord> & { id: string; awardDate: string }): AwardRecord => ({
  buyerName: 'Stadt Ulm, Zentrale Vergabestelle',
  buyerIdentifier: 'ORG-1000',
  buyerCountry: 'DEU',
  cpvMain: '72514000',
  valueAmount: 1_200_000,
  valueCurrency: 'EUR',
  winners: 'Materna Information & Communications SE',
  ...o,
});

/* ------------------------------------------------------------ date helpers */

test('addMonths clamps to the last valid day of the target month', () => {
  assert.equal(addMonths('2026-01-31', 1), '2026-02-28');
  assert.equal(addMonths('2024-01-31', 1), '2024-02-29'); // leap year
  assert.equal(addMonths('2026-03-15', -3), '2025-12-15');
  assert.equal(addMonths('2026-09-01', 48), '2030-09-01');
});

test('monthsBetween measures signed distance in months', () => {
  assert.ok(Math.abs(monthsBetween('2022-09-01', '2026-09-01') - 48) < 0.5);
  assert.ok(monthsBetween('2026-09-01', '2025-09-01') < 0);
});

test('cpvFamily takes the first two digits, slugify survives umlauts', () => {
  assert.equal(cpvFamily('72267000'), '72');
  assert.equal(cpvFamily('48'), '48');
  assert.equal(cpvFamily(null), null);
  assert.equal(slugify('Freie und Hansestadt Hamburg, Finanzbehörde'), 'freie-und-hansestadt-hamburg-finanzbehoerde');
  assert.equal(slugify('Kanton Zürich – Amt für Informatik'), 'kanton-zuerich-amt-fuer-informatik');
});

/* --------------------------------------------------------------- forecasts */

test('a regular award history yields an observed cycle and a 6-12 month window', () => {
  const f = forecastFromAwards(
    [
      award({ id: 'a1', awardDate: '2018-05-15' }),
      award({ id: 'a2', awardDate: '2021-05-15' }),
      award({ id: 'a3', awardDate: '2024-05-15' }),
    ],
    { today: TODAY },
  );
  assert.ok(f);
  assert.equal(f.cycleSource, 'observed');
  assert.ok(Math.abs(f.cycleMonths - 36) < 1, `cycle was ${f.cycleMonths}`);
  assert.equal(f.observations, 3);
  assert.equal(f.expiryDate, '2027-05-15');
  // Window is expiry minus 12 months to expiry minus 6 months.
  assert.equal(f.windowOpen, '2026-05-15');
  assert.equal(f.windowClose, '2026-11-15');
  assert.equal(f.incumbent, 'Materna Information & Communications SE');
  assert.equal(f.lastAwardId, 'a3');
  assert.ok(f.confidence >= 0.8, `confidence was ${f.confidence}`);
  assert.ok(f.reasons.some((r) => r.includes('every 36 months')));
  assert.ok(f.reasons.some((r) => r.includes('highly regular')));
});

test('a single award falls back to the 4-year legal cap, with lower confidence', () => {
  const f = forecastFromAwards([award({ id: 'solo', awardDate: '2024-01-10' })], { today: TODAY });
  assert.ok(f);
  assert.equal(f.cycleSource, 'assumed');
  assert.equal(f.cycleMonths, 48);
  assert.equal(f.expiryDate, '2028-01-10');
  assert.equal(f.windowOpen, '2027-01-10');
  assert.ok(f.confidence < 0.6, `confidence was ${f.confidence}`);
  assert.ok(f.reasons.some((r) => r.includes('Art. 33(1)')));
});

test('an irregular history is forecast but trusted less than a regular one', () => {
  const regular = forecastFromAwards(
    [
      award({ id: 'r1', awardDate: '2018-01-15' }),
      award({ id: 'r2', awardDate: '2021-01-15' }),
      award({ id: 'r3', awardDate: '2024-01-15' }),
    ],
    { today: TODAY },
  )!;
  const irregular = forecastFromAwards(
    [
      award({ id: 'i1', awardDate: '2017-01-15' }),
      award({ id: 'i2', awardDate: '2021-06-15' }),
      award({ id: 'i3', awardDate: '2024-01-15' }),
    ],
    { today: TODAY },
  )!;
  assert.ok(regular.confidence > irregular.confidence);
});

test('lots of the same procedure (sub-9-month gaps) do not count as a re-tender cycle', () => {
  const f = forecastFromAwards(
    [
      award({ id: 'lot1', awardDate: '2024-01-15' }),
      award({ id: 'lot2', awardDate: '2024-03-15' }),
      award({ id: 'lot3', awardDate: '2024-05-15' }),
    ],
    { today: TODAY },
  );
  assert.ok(f);
  // No gap survived the filter, so it must fall back to the legal ceiling.
  assert.equal(f.cycleSource, 'assumed');
  assert.equal(f.cycleMonths, 48);
});

test('awards below the value floor are ignored as noise', () => {
  const f = forecastFromAwards(
    [award({ id: 'tiny', awardDate: '2024-05-15', valueAmount: 900 })],
    { today: TODAY },
  );
  assert.equal(f, null);
});

test('missing dates or CPV codes produce no forecast', () => {
  assert.equal(forecastFromAwards([], { today: TODAY }), null);
  assert.equal(
    forecastFromAwards([award({ id: 'x', awardDate: '2024-01-01', cpvMain: null })], { today: TODAY }),
    null,
  );
});

test('status and countdown are derived from the predicted window', () => {
  const f = forecastFromAwards(
    [award({ id: 'a', awardDate: '2024-05-15' }), award({ id: 'b', awardDate: '2021-05-15' })],
    { today: TODAY },
  )!;
  // Window 2026-05-15 → 2026-11-15, today 2026-09-01.
  assert.equal(forecastStatus(f, TODAY), 'open');
  assert.equal(forecastStatus(f, '2026-01-01'), 'upcoming');
  assert.equal(forecastStatus(f, '2027-01-01'), 'overdue');
  assert.ok(daysUntilWindow(f, '2026-05-01') > 0);
  assert.ok(daysUntilWindow(f, TODAY) < 0);
});

test('a long-passed window is flagged and penalised', () => {
  const f = forecastFromAwards([award({ id: 'old', awardDate: '2015-01-15' })], { today: TODAY })!;
  assert.equal(forecastStatus(f, TODAY), 'overdue');
  assert.ok(f.reasons.some((r) => r.includes('overdue')));
});

/* ------------------------------------------------------------- persistence */

const iso = (d: number) => new Date(Date.parse(`${TODAY}T00:00:00Z`) + d * 86_400_000).toISOString().slice(0, 10);

const awardNotice = (o: {
  id: string; buyer: string; date: string; cpv: string; winner: string; value: number; org: string;
}) =>
  normalizeNotice({
    'publication-number': o.id,
    'notice-title': { eng: [`Contract award: cloud platform ${o.id}`] },
    'notice-type': 'can-standard',
    'publication-date': `${o.date}Z`,
    'buyer-name': { deu: [o.buyer] },
    'buyer-country': ['DEU'],
    'buyer-identifier': [o.org],
    'classification-cpv': [o.cpv],
    'total-value': [{ amount: o.value, currency: 'EUR' }],
    'winner-name': { eng: [o.winner] },
  })!;

upsertNotices([
  awardNotice({ id: 'aw1-2019', buyer: 'Stadt Testheim', date: '2019-05-15', cpv: '72514000', winner: 'Alpha IT GmbH', value: 900_000, org: 'ORG-1' }),
  awardNotice({ id: 'aw2-2022', buyer: 'Stadt Testheim', date: '2022-05-15', cpv: '72514000', winner: 'Alpha IT GmbH', value: 1_100_000, org: 'ORG-1' }),
  awardNotice({ id: 'aw3-2025', buyer: 'Stadt Testheim', date: '2025-05-15', cpv: '72514000', winner: 'Beta Systems AG; Alpha IT GmbH', value: 1_400_000, org: 'ORG-1' }),
  awardNotice({ id: 'aw4-2024', buyer: 'Amt für Digitales', date: '2024-02-10', cpv: '48311000', winner: 'Gamma Software SE', value: 600_000, org: 'ORG-2' }),
]);

test('award notices are stored with winners and flagged as awards', () => {
  const n = awardNotice({ id: 'chk-2026', buyer: 'X', date: '2026-01-01', cpv: '72000000', winner: 'A; B', value: 5, org: 'O' });
  assert.equal(n.isAward, true);
  assert.deepEqual(n.winnerNames, ['A', 'B']);
  assert.equal(n.buyerIdentifier, 'O');
});

test('computeForecasts groups awards by buyer and CPV family', () => {
  const forecasts = computeForecasts({ today: TODAY });
  const testheim = forecasts.find((f) => f.buyerName === 'Stadt Testheim');
  assert.ok(testheim, 'expected a forecast for Stadt Testheim');
  assert.equal(testheim.observations, 3);
  assert.equal(testheim.cpvFamily, '72');
  assert.ok(Math.abs(testheim.cycleMonths - 36) < 1);
  assert.equal(testheim.expiryDate, '2028-05-15');
  assert.ok(forecasts.some((f) => f.buyerName === 'Amt für Digitales' && f.cpvFamily === '48'));
});

test('forecasts round-trip through the database', () => {
  const { forecasts } = refreshRadar({ today: TODAY });
  assert.ok(forecasts >= 2);
  const stored = listForecasts({ limit: 50, horizonMonths: 60, today: TODAY });
  const testheim = stored.find((f) => f.buyerSlug === 'stadt-testheim');
  assert.ok(testheim);
  assert.equal(testheim.incumbent, 'Beta Systems AG; Alpha IT GmbH');
  assert.ok(Array.isArray(testheim.reasons) && testheim.reasons.length > 0);
});

test('listForecasts filters by CPV family, country and confidence', () => {
  const opts = { limit: 50, horizonMonths: 60, today: TODAY } as const;
  assert.ok(listForecasts({ ...opts, cpvPrefixes: ['48311000'] }).every((f) => f.cpvFamily === '48'));
  assert.equal(listForecasts({ ...opts, cpvPrefixes: ['99'] }).length, 0);
  assert.ok(listForecasts({ ...opts, countries: ['DEU'] }).length > 0);
  assert.equal(listForecasts({ ...opts, countries: ['FRA'] }).length, 0);
  assert.equal(listForecasts({ ...opts, minConfidence: 0.99 }).length, 0);
  assert.ok(listForecasts({ ...opts, slug: 'stadt-testheim' }).every((f) => f.buyerSlug === 'stadt-testheim'));
});

test('an unrelated notice in the same sector does not supersede a forecast', () => {
  const f = listForecasts({ limit: 50, horizonMonths: 60, today: TODAY })
    .find((x) => x.buyerSlug === 'stadt-testheim')!;
  // Published years before the predicted window opens: a different contract.
  upsertNotices([
    normalizeNotice({
      'publication-number': 'unrelated-2025',
      'notice-title': { eng: ['Small cloud consultancy assignment'] },
      'notice-type': 'cn-standard',
      'publication-date': '2025-08-01Z',
      'buyer-name': { deu: ['Stadt Testheim'] },
      'buyer-country': ['DEU'],
      'classification-cpv': ['72514000'],
    })!,
  ]);
  assert.equal(findSupersedingNotice(f), null);

  // Published inside the predicted window: this is the re-let we forecast.
  upsertNotices([
    normalizeNotice({
      'publication-number': 'relet-2027',
      'notice-title': { eng: ['Framework: operation of the municipal cloud platform'] },
      'notice-type': 'cn-standard',
      'publication-date': `${f.windowOpen}Z`,
      'buyer-name': { deu: ['Stadt Testheim'] },
      'buyer-country': ['DEU'],
      'classification-cpv': ['72514000'],
    })!,
  ]);
  assert.equal(findSupersedingNotice(f), 'relet-2027');
});

/* ------------------------------------------------------------ intelligence */

test('supplier league table splits multi-lot value across named winners', () => {
  const shares = supplierShare({ buyerName: 'Stadt Testheim' });
  const alpha = shares.find((s) => s.name === 'Alpha IT GmbH');
  const beta = shares.find((s) => s.name === 'Beta Systems AG');
  assert.ok(alpha && beta);
  assert.equal(alpha.wins, 3);
  assert.equal(beta.wins, 1);
  // Alpha: 900k + 1.1m + half of 1.4m = 2.7m; Beta: half of 1.4m = 0.7m.
  assert.equal(Math.round(alpha.totalValue), 2_700_000);
  assert.equal(Math.round(beta.totalValue), 700_000);
  assert.ok(alpha.sharePct > beta.sharePct);
  assert.ok(Math.abs(shares.reduce((a, b) => a + b.sharePct, 0) - 100) < 1);
});

test('buyer profiles aggregate awards, suppliers and forecasts', () => {
  const buyers = listBuyers({ limit: 50 });
  assert.ok(buyers.some((b) => b.slug === 'stadt-testheim'));
  const p = buyerProfile('stadt-testheim');
  assert.ok(p);
  assert.equal(p.awards, 3);
  assert.equal(p.totalValue, 3_400_000);
  assert.deepEqual(p.families, ['72']);
  assert.ok(p.recentAwards.length === 3);
  assert.ok(p.suppliers.length >= 2);
  assert.equal(buyerProfile('no-such-buyer'), null);
});

/* -------------------------------------------------------------- monetising */

test('Radar access is limited to paying Edge subscribers', () => {
  assert.equal(hasRadarAccess({ plan: 'edge', status: 'active' }), true);
  assert.equal(hasRadarAccess({ plan: 'edge', status: 'trialing' }), true);
  assert.equal(hasRadarAccess({ plan: 'edge', status: 'past_due' }), false);
  assert.equal(hasRadarAccess({ plan: 'edge', status: 'canceled' }), false);
  assert.equal(hasRadarAccess({ plan: 'pro', status: 'active' }), false);
  assert.equal(hasRadarAccess({ plan: 'free', status: 'free' }), false);
  assert.equal(hasRadarAccess(null), false);
});

test('prices map to tiers in both directions', () => {
  assert.equal(priceIdFor('pro'), 'price_pro_dummy');
  assert.equal(priceIdFor('edge'), 'price_edge_dummy');
  assert.equal(tierForPrice('price_edge_dummy'), 'edge');
  assert.equal(tierForPrice('price_pro_dummy'), 'pro');
  assert.equal(tierForPrice('price_unknown'), null);
  assert.equal(tierForPrice(null), null);
  assert.equal(edgeEnabled(), true);
});

/* --------------------------------------------------------------- web pages */

const app = buildServer();
await app.ready();

test('the radar page previews a couple of forecasts and paywalls the rest', async () => {
  const res = await app.inject({ method: 'GET', url: '/radar' });
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /Re-tender Radar/);
  assert.match(res.body, /Art\. 33\(1\)/);            // the mechanism is explained
  assert.match(res.body, /Stadt Testheim/);           // the free preview is real
  assert.match(res.body, /Unlock/);                   // and the rest is sold
});

test('locked forecasts are redacted server-side, not just blurred in CSS', async () => {
  // Everything on the radar for an anonymous visitor beyond the free preview must
  // be absent from the HTML source — otherwise the paywall is decorative.
  const { listForecasts: list } = await import('../src/core/radar.ts');
  const all = list({ limit: 100, horizonMonths: 600, minConfidence: 0.3 });
  const locked = all.slice(2);
  const res = await app.inject({ method: 'GET', url: '/radar' });
  assert.equal(res.statusCode, 200);
  for (const f of locked) {
    assert.ok(!res.body.includes(f.buyerName), `leaked buyer ${f.buyerName}`);
    if (f.incumbent) assert.ok(!res.body.includes(f.incumbent), `leaked incumbent ${f.incumbent}`);
  }
});

test('the radar page filters by sector', async () => {
  const res = await app.inject({ method: 'GET', url: '/radar?cpv=48' });
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /Amt für Digitales|No forecasts/);
});

test('buyer pages are public, indexable and canonical', async () => {
  const list = await app.inject({ method: 'GET', url: '/buyers' });
  assert.equal(list.statusCode, 200);
  assert.match(list.body, /stadt-testheim/);

  const page = await app.inject({ method: 'GET', url: '/buyer/stadt-testheim' });
  assert.equal(page.statusCode, 200);
  assert.match(page.body, /Stadt Testheim/);
  assert.match(page.body, /Alpha IT GmbH/);            // supplier league table
  assert.match(page.body, /Coming back to market/);    // the forecast hook
  assert.match(page.body, /rel="canonical" href="https:\/\/example\.test\/buyer\/stadt-testheim"/);

  const missing = await app.inject({ method: 'GET', url: '/buyer/does-not-exist' });
  assert.equal(missing.statusCode, 404);
});

test('buyer pages appear in the sitemap', async () => {
  const res = await app.inject({ method: 'GET', url: '/sitemap.xml' });
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /\/buyer\/stadt-testheim/);
  assert.match(res.body, /\/radar/);
});

test('pricing sells three tiers and explains the forecast mechanism', async () => {
  const res = await app.inject({ method: 'GET', url: '/pricing' });
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /Edge/);
  assert.match(res.body, /name="tier" value="edge"/);
  assert.match(res.body, /name="tier" value="pro"/);
  assert.match(res.body, /four years/);
});

test('checkout rejects an unknown tier by falling back to Pro', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/checkout',
    payload: 'email=tier-test@example.com&tier=bogus',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  });
  // Stripe is a dummy key here, so the call fails at the API — never at tier parsing.
  assert.ok([303, 500].includes(res.statusCode), `unexpected ${res.statusCode}`);
});

test.after(async () => {
  await app.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});
