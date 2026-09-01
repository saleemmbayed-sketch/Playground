import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeNotice, pickText, buildQuery, TED_FIELDS } from '../src/ingest/ted.ts';

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
  assert.equal(n.urlHtml, 'https://ted.europa.eu/en/notice/123456-2026/html');
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

test('buildQuery produces valid TED expert-query syntax', () => {
  const q = buildQuery(3);
  assert.match(q, /publication-date >= today\(-3\)/);
  assert.match(q, /classification-cpv IN \(/);
  assert.ok(TED_FIELDS.includes('publication-number'));
});
