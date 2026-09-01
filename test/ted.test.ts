import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tenderping-ted-'));
process.env.DB_FILE = path.join(tmp, 'ted.db');
process.env.TED_CPV_FAMILIES = '72,48';
process.env.TED_COUNTRIES = '';

const { normalizeNotice, pickText, buildQuery, noticeUrl, CORE_FIELDS, OPTIONAL_FIELDS } =
  await import('../src/ingest/ted.ts');

test('pickText prefers English from a multilingual map', () => {
  assert.equal(pickText({ deu: ['Hallo Welt'], eng: ['Hello world'] }), 'Hello world');
  assert.equal(pickText(['a', 'b']), 'a b');
  assert.equal(pickText(null), null);
  assert.equal(pickText({ pol: ['tylko polski'] }), 'tylko polski', 'falls back to any language present');
  assert.equal(pickText('  spaced   out  '), 'spaced out');
});

test('normalizeNotice maps a real-shaped TED payload', () => {
  const n = normalizeNotice({
    'publication-number': '123456-2026',
    'notice-title': { eng: ['Framework for software development'], deu: ['Rahmenvertrag'] },
    'buyer-name': { deu: ['Stadt Ulm'] },
    'buyer-country': ['DEU'],
    'place-of-performance': ['DE144'],
    'classification-cpv': ['72212000', '72000000'],
    'publication-date': '2026-08-20Z',
    deadline: ['2026-09-30+02:00'],
    'total-value': [2400000],
    'total-value-cur': ['EUR'],
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
  assert.equal(n.deadlineDate, '2026-09-30', 'reads the documented `deadline` field');
  assert.equal(n.valueAmount, 2400000);
  assert.equal(n.valueCurrency, 'EUR', 'currency comes from total-value-cur');
  assert.equal(n.urlHtml, 'https://ted.europa.eu/en/notice/123456-2026/html');
  assert.equal(n.source, 'ted');
});

test('normalizeNotice handles YYYYMMDD dates and nested value objects', () => {
  const n = normalizeNotice({
    'publication-number': '1-2026',
    'total-value': [{ amount: 500000, currency: 'CHF' }],
    'publication-date': '20260815',
    deadline: '20260901',
  });
  assert.equal(n!.publicationDate, '2026-08-15');
  assert.equal(n!.deadlineDate, '2026-09-01');
  assert.equal(n!.valueAmount, 500000);
  assert.equal(n!.valueCurrency, 'CHF');
});

test('normalizeNotice prefers the links object for the notice URL', () => {
  const n = normalizeNotice({
    'publication-number': '7-2026',
    links: { html: { ENG: 'https://ted.europa.eu/en/notice/-/detail/7-2026' } },
  });
  assert.equal(n!.urlHtml, 'https://ted.europa.eu/en/notice/-/detail/7-2026');
  assert.equal(noticeUrl('7-2026'), 'https://ted.europa.eu/en/notice/7-2026/html');
});

test('normalizeNotice rejects payloads without a publication number', () => {
  assert.equal(normalizeNotice({ 'notice-title': 'x' }), null);
});

test('normalizeNotice survives sparse and unexpected shapes', () => {
  const n = normalizeNotice({ 'publication-number': '9-2026' });
  assert.ok(n);
  assert.equal(n.title, 'TED notice 9-2026');
  assert.deepEqual(n.cpv, []);
  assert.equal(n.deadlineDate, null);
  assert.equal(n.valueAmount, null);

  const weird = normalizeNotice({
    'publication-number': '10-2026',
    'classification-cpv': 'not-a-code 72000000',
    'place-of-performance': ['DE144', 'garbage-value'],
  });
  assert.deepEqual(weird!.cpv, ['72000000'], 'non-numeric CPV tokens are dropped');
  assert.deepEqual(weird!.placeNuts, ['DE144'], 'malformed NUTS codes are dropped');
});

test('buildQuery uses the documented expert-search syntax', () => {
  const q = buildQuery(3, new Date('2026-09-01T00:00:00Z'));
  // TED expects YYYYMMDD dates, not ISO or relative helpers.
  assert.match(q, /publication-date>=20260829/);
  // Wildcard CPV families are OR-ed; the IN operator does not accept wildcards.
  assert.match(q, /classification-cpv=72\*/);
  assert.match(q, /classification-cpv=48\*/);
  assert.match(q, / OR /);
  assert.match(q, /SORT BY publication-date DESC$/);
  assert.doesNotMatch(q, /today\(/, 'relative date helpers are not documented TED syntax');
});

test('field lists are sane', () => {
  assert.ok(CORE_FIELDS.includes('publication-number'));
  assert.ok(CORE_FIELDS.includes('notice-title'));
  assert.ok(OPTIONAL_FIELDS.includes('deadline'));
  assert.ok(OPTIONAL_FIELDS.includes('total-value-cur'));
  const overlap = CORE_FIELDS.filter((f) => (OPTIONAL_FIELDS as readonly string[]).includes(f));
  assert.deepEqual(overlap, [], 'core and optional field sets must not overlap');
});

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
