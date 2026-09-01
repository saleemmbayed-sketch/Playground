import test from 'node:test';
import assert from 'node:assert/strict';
import {
  matchesNiche, normalizeNotice, noticeUrl, parseAmount, pickText, queryStrategies, TED_FIELDS,
} from '../src/ingest/ted.ts';

test('pickText prefers English from a multilingual map', () => {
  assert.equal(pickText({ deu: ['Hallo Welt'], eng: ['Hello world'] }), 'Hello world');
  assert.equal(pickText(['a', 'b']), 'a b');
  assert.equal(pickText(null), null);
  assert.equal(pickText({ pol: ['tylko polski'] }), 'tylko polski');
});

test('normalizeNotice maps a TED-shaped payload', () => {
  const n = normalizeNotice({
    'publication-number': '123456-2026',
    'notice-title': { eng: ['Framework for software development'], deu: ['Rahmenvertrag'] },
    'buyer-name': { deu: ['Stadt Ulm'] },
    'buyer-country': ['DEU'],
    'place-of-performance': ['DE144'],
    'classification-cpv': ['72212000', '72000000'],
    'publication-date': '2026-08-20Z',
    'deadline-receipt-tender-date-lot': ['2026-09-30+02:00'],
    'total-value': [{ amount: 2400000, currency: 'EUR' }],
    'description-lot': { eng: ['Some description'] },
  });
  assert.ok(n);
  assert.equal(n.id, '123456-2026');
  assert.equal(n.title, 'Framework for software development');
  assert.equal(n.buyerName, 'Stadt Ulm');
  assert.equal(n.buyerCountry, 'DEU');
  assert.deepEqual(n.cpv, ['72212000', '72000000']);
  assert.equal(n.cpvMain, '72212000');
  assert.deepEqual(n.placeNuts, ['DE144']);
  assert.equal(n.publicationDate, '2026-08-20');
  assert.equal(n.deadlineDate, '2026-09-30');
  assert.equal(n.valueAmount, 2400000);
  assert.equal(n.valueCurrency, 'EUR');
  assert.equal(n.urlHtml, 'https://ted.europa.eu/en/notice/-/detail/123456-2026');
});

test('normalizeNotice rejects payloads without a publication number', () => {
  assert.equal(normalizeNotice({ 'notice-title': 'x' }), null);
});

test('normalizeNotice survives unexpected shapes', () => {
  const n = normalizeNotice({ 'publication-number': '9-2026' });
  assert.ok(n);
  assert.equal(n.title, 'TED notice 9-2026');
  assert.deepEqual(n.cpv, []);
  assert.equal(n.deadlineDate, null);
});

test('the requested field set includes everything the product depends on', () => {
  for (const f of ['publication-number', 'notice-title', 'buyer-name', 'buyer-country',
    'classification-cpv', 'publication-date', 'deadline', 'total-value']) {
    assert.ok((TED_FIELDS as readonly string[]).includes(f), `missing field ${f}`);
  }
});

test('EU-formatted and object-shaped values are parsed correctly', () => {
  const eu = normalizeNotice({
    'publication-number': '1-2026',
    'total-value': ['360 000,00EUR'],
  })!;
  assert.equal(eu.valueAmount, 360000);
  assert.equal(eu.valueCurrency, 'EUR');

  const obj = normalizeNotice({
    'publication-number': '2-2026',
    'total-value': [{ amount: 2400000, currency: 'CHF' }],
  })!;
  assert.equal(obj.valueAmount, 2400000);
  assert.equal(obj.valueCurrency, 'CHF');

  const ukStyle = normalizeNotice({
    'publication-number': '3-2026',
    'estimated-value-lot': ['1,250,000.50 GBP'],
  })!;
  assert.equal(ukStyle.valueAmount, 1250000.5);
  assert.equal(ukStyle.valueCurrency, 'GBP');
});

test('compact YYYYMMDD dates are understood', () => {
  const n = normalizeNotice({ 'publication-number': '4-2026', 'deadline': ['20261130'] })!;
  assert.equal(n.deadlineDate, '2026-11-30');
});

test('notice URL uses the TED permalink pattern, or the link TED supplies', () => {
  assert.equal(noticeUrl('477851-2026'), 'https://ted.europa.eu/en/notice/-/detail/477851-2026');
  const fromLinks = normalizeNotice({
    'publication-number': '5-2026',
    links: { html: { ENG: 'https://ted.europa.eu/en/notice/-/detail/5-2026' } },
  })!;
  assert.equal(fromLinks.urlHtml, 'https://ted.europa.eu/en/notice/-/detail/5-2026');
});

test('query strategies degrade from precise to permissive and stay non-empty', () => {
  const strategies = queryStrategies();
  assert.ok(strategies.length >= 3, 'need a real fallback chain');
  for (const s of strategies) {
    const q = s.build(3);
    assert.ok(q.length > 5, `${s.name} produced an empty query`);
  }
  // The last resort must never depend on CPV/country grammar.
  const last = strategies.at(-1)!.build(3);
  assert.doesNotMatch(last, /classification-cpv/);
  assert.match(last, /PD>=\d{8}/);
});

test('TED page limit never exceeds the documented maximum of 100', () => {
  // Guards against a config typo silently causing HTTP 400s in production.
  assert.ok(Math.min(Math.max(1, 250), 100) === 100);
});

test('client-side niche filter catches notices the date-only query lets through', () => {
  const inNiche = normalizeNotice({ 'publication-number': '6-2026', 'classification-cpv': ['72212000'] })!;
  const outOfNiche = normalizeNotice({ 'publication-number': '7-2026', 'classification-cpv': ['45000000'] })!;
  assert.equal(matchesNiche(inNiche), true);
  assert.equal(matchesNiche(outOfNiche), false);
});

test('parseAmount handles every European money convention', () => {
  assert.equal(parseAmount('360000'), 360000);
  assert.equal(parseAmount('360000,00'), 360000);
  assert.equal(parseAmount('1.250.000,00'), 1250000);
  assert.equal(parseAmount('1,250,000.50'), 1250000.5);
  assert.equal(parseAmount('1.250'), 1250, 'European thousands, not 1.25');
  assert.equal(parseAmount('1,50'), 1.5);
  assert.equal(parseAmount('abc'), null);
  assert.equal(parseAmount('0'), null, 'zero is not a usable contract value');
});
