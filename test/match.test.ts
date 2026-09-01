import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreNotice, matchNotices, splitList, type Profile } from '../src/core/match.ts';
import type { NoticeRow } from '../src/core/notices.ts';

const NOW = new Date('2026-09-01T00:00:00Z');

const notice = (patch: Partial<NoticeRow> = {}): NoticeRow => ({
  id: 'n1',
  title: 'Framework agreement for custom software development',
  buyer_name: 'Stadt Ulm',
  buyer_country: 'DEU',
  place_nuts: 'DE144',
  cpv: '72212000,72000000',
  cpv_main: '72212000',
  notice_type: 'cn-standard',
  publication_date: '2026-08-30',
  deadline_date: '2026-10-01',
  value_amount: 500_000,
  value_currency: 'EUR',
  description: 'Kubernetes and Java development for municipal services.',
  url_html: 'https://ted.europa.eu/en/notice/n1/html',
  language: 'deu',
  summary: null,
  summary_source: null,
  first_seen_at: '2026-08-30T05:00:00Z',
  updated_at: '2026-08-30T05:00:00Z',
  ...patch,
});

const profile = (patch: Partial<Profile> = {}): Profile => ({
  subscriber_id: 1,
  cpv_prefixes: '72',
  countries: 'DEU',
  nuts_prefixes: '',
  keywords: '',
  exclude_words: '',
  min_value: null,
  max_value: null,
  min_score: 0.35,
  cadence: 'daily',
  ...patch,
});

test('splitList trims and drops empties', () => {
  assert.deepEqual(splitList(' 72 , 48 ,, '), ['72', '48']);
  assert.deepEqual(splitList(null), []);
});

test('a well-matching notice scores high and explains itself', () => {
  const r = scoreNotice(notice(), profile({ keywords: 'kubernetes,java' }), NOW);
  assert.equal(r.matched, true);
  assert.ok(r.score > 0.7, `score was ${r.score}`);
  assert.ok(r.reasons.some((x) => x.includes('CPV')));
  assert.ok(r.reasons.some((x) => x.toLowerCase().includes('kubernetes')));
  assert.ok(r.reasons.some((x) => x.includes('days left')));
});

test('exclusion terms are a hard filter', () => {
  const r = scoreNotice(notice(), profile({ exclude_words: 'Kubernetes' }), NOW);
  assert.equal(r.matched, false);
  assert.equal(r.score, 0);
  assert.match(r.rejectedBy!, /excluded term/);
});

test('CPV outside the profile is rejected', () => {
  const r = scoreNotice(notice({ cpv: '45000000', cpv_main: '45000000' }), profile(), NOW);
  assert.equal(r.matched, false);
  assert.match(r.rejectedBy!, /CPV/);
});

test('country and region filters apply', () => {
  assert.match(scoreNotice(notice(), profile({ countries: 'FRA' }), NOW).rejectedBy!, /country/);
  assert.match(scoreNotice(notice(), profile({ nuts_prefixes: 'AT' }), NOW).rejectedBy!, /region/);
  assert.equal(scoreNotice(notice(), profile({ nuts_prefixes: 'DE1' }), NOW).matched, true);
});

test('value band filters apply in both directions', () => {
  assert.match(scoreNotice(notice(), profile({ min_value: 1_000_000 }), NOW).rejectedBy!, /below/);
  assert.match(scoreNotice(notice(), profile({ max_value: 100_000 }), NOW).rejectedBy!, /above/);
  assert.equal(scoreNotice(notice(), profile({ min_value: 100_000, max_value: 1_000_000 }), NOW).matched, true);
});

test('missing value never hard-filters a notice out', () => {
  const r = scoreNotice(notice({ value_amount: null }), profile({ min_value: 1_000_000 }), NOW);
  assert.equal(r.matched, true);
});

test('expired deadlines are penalised', () => {
  const fresh = scoreNotice(notice(), profile(), NOW).score;
  const expired = scoreNotice(notice({ deadline_date: '2026-08-01' }), profile(), NOW).score;
  assert.ok(expired < fresh - 0.3, `${expired} vs ${fresh}`);
});

test('min_score gates delivery', () => {
  const p = profile({ min_score: 0.99 });
  assert.equal(scoreNotice(notice(), p, NOW).matched, false);
});

test('matchNotices sorts by score descending and honours the limit', () => {
  const pool = [
    notice({ id: 'a', deadline_date: '2026-08-01' }),
    notice({ id: 'b', description: 'kubernetes platform' }),
    notice({ id: 'c', cpv: '45000000', cpv_main: '45000000' }),
  ];
  const res = matchNotices(pool, profile({ keywords: 'kubernetes' }), { now: NOW });
  assert.equal(res[0]!.notice.id, 'b');
  assert.ok(!res.some((r) => r.notice.id === 'c'));
  assert.equal(matchNotices(pool, profile(), { limit: 1, now: NOW }).length, 1);
});
