/**
 * Plain-language summaries.
 *
 * Default path is a deterministic, zero-cost heuristic. If LLM_API_KEY is present the
 * service upgrades to model-written summaries, capped by LLM_MAX_ENRICH_PER_DAY so the
 * bill can never surprise you. Any failure silently falls back to the heuristic.
 */
import { config } from '../config.js';
import { db, kvGet, kvSet, nowIso } from './db.js';
import type { NoticeRow } from './notices.js';

const CPV_LABELS: Array<[string, string]> = [
  ['7222', 'software consultancy'],
  ['7226', 'software-related services'],
  ['7225', 'IT operations / support'],
  ['7224', 'business process services'],
  ['7231', 'data processing'],
  ['7232', 'data services'],
  ['7241', 'internet / provider services'],
  ['7251', 'IT facilities management'],
  ['7253', 'IT network services'],
  ['7261', 'IT support services'],
  ['7271', 'data network services'],
  ['7200', 'IT services'],
  ['4800', 'software packages'],
  ['4861', 'database software'],
  ['4878', 'system management software'],
  ['4800', 'software'],
  ['3020', 'computer hardware'],
  ['3021', 'data-processing machines'],
  ['7200', 'IT services'],
  ['7900', 'business services'],
  ['7141', 'consultancy services'],
  ['3200', 'telecoms equipment'],
  ['7300', 'R&D services'],
  ['8000', 'education / training'],
];

function cpvLabel(cpv: string | null): string {
  if (!cpv) return 'public sector contract';
  for (const [prefix, label] of CPV_LABELS) {
    if (cpv.startsWith(prefix)) return label;
  }
  return `CPV ${cpv.slice(0, 4)} services`;
}

function money(n: number | null, cur: string | null): string | null {
  if (n == null) return null;
  return `${Math.round(n).toLocaleString('en-GB')} ${cur ?? 'EUR'}`;
}

export function heuristicSummary(n: NoticeRow): string {
  const parts: string[] = [];
  const who = n.buyer_name ? n.buyer_name.replace(/\s+/g, ' ').slice(0, 90) : 'A public buyer';
  const where = n.buyer_country ? ` (${n.buyer_country})` : '';
  parts.push(`${who}${where} is procuring ${cpvLabel(n.cpv_main)}.`);
  const val = money(n.value_amount, n.value_currency);
  if (val) parts.push(`Estimated value ${val}.`);
  if (n.deadline_date) parts.push(`Bids close ${n.deadline_date}.`);
  if (n.description) {
    const snippet = n.description.replace(/\s+/g, ' ').slice(0, 220);
    parts.push(`${snippet}${n.description.length > 220 ? '…' : ''}`);
  }
  return parts.join(' ');
}

function todayKey(): string {
  return `llm_enrich_${new Date().toISOString().slice(0, 10)}`;
}

function budgetRemaining(): number {
  const used = Number.parseInt(kvGet(todayKey()) ?? '0', 10) || 0;
  return Math.max(0, config.llm.maxEnrichPerDay - used);
}

function consumeBudget(n: number): void {
  const used = Number.parseInt(kvGet(todayKey()) ?? '0', 10) || 0;
  kvSet(todayKey(), String(used + n));
}

async function llmSummary(n: NoticeRow): Promise<string | null> {
  if (!config.llm.apiKey) return null;
  const prompt = [
    'Summarise this EU public procurement notice for a small IT supplier in 2 sentences of plain English.',
    'Say what is being bought, by whom, and any value or deadline. No preamble, no markdown.',
    '',
    `Title: ${n.title}`,
    `Buyer: ${n.buyer_name ?? 'unknown'} (${n.buyer_country ?? '??'})`,
    `CPV: ${n.cpv ?? ''}`,
    `Value: ${money(n.value_amount, n.value_currency) ?? 'not stated'}`,
    `Deadline: ${n.deadline_date ?? 'not stated'}`,
    `Description: ${(n.description ?? '').slice(0, 1500)}`,
  ].join('\n');

  try {
    const res = await fetch(`${config.llm.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.llm.apiKey}`,
      },
      body: JSON.stringify({
        model: config.llm.model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 160,
        temperature: 0.2,
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return null;
    const json: any = await res.json();
    const text: string | undefined = json?.choices?.[0]?.message?.content;
    return text?.trim() || null;
  } catch {
    return null;
  }
}

/** Fills in summaries for notices that don't have one yet. Safe to call every run. */
export async function enrichPending(limit = 200): Promise<{ llm: number; heuristic: number }> {
  const rows = db()
    .prepare(
      `SELECT * FROM notices WHERE summary IS NULL
       ORDER BY COALESCE(publication_date, first_seen_at) DESC LIMIT ?`,
    )
    .all(limit) as unknown as NoticeRow[];

  const update = db().prepare('UPDATE notices SET summary = ?, summary_source = ?, updated_at = ? WHERE id = ?');
  let llm = 0;
  let heuristic = 0;
  let budget = config.llm.apiKey ? budgetRemaining() : 0;

  for (const n of rows) {
    let text: string | null = null;
    let source = 'heuristic';
    if (budget > 0) {
      text = await llmSummary(n);
      if (text) {
        source = 'llm';
        budget -= 1;
        llm += 1;
        consumeBudget(1);
      }
    }
    if (!text) {
      text = heuristicSummary(n);
      heuristic += 1;
    }
    update.run(text, source, nowIso(), n.id);
  }
  return { llm, heuristic };
}
