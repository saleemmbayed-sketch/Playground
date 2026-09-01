/**
 * Operator dashboard at /admin?key=APP_SECRET.
 *
 * The point of this page is that running the business never requires SSH: revenue,
 * audience, pipeline health and the last job runs are all one URL away, and the jobs
 * can be triggered by hand if a run is ever missed.
 */
import { config } from '../config.js';
import { db } from '../core/db.js';
import { noticeStats } from '../core/notices.js';
import { subscriberStats } from '../core/subscribers.js';
import { layout, h } from './views.js';

interface JobRow {
  job: string;
  started_at: string;
  ended_at: string | null;
  ok: number | null;
  stats: string | null;
  error: string | null;
}

const ago = (iso: string | null): string => {
  if (!iso) return '—';
  const mins = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (!Number.isFinite(mins)) return '—';
  if (mins < 60) return `${mins}m ago`;
  if (mins < 1440) return `${Math.round(mins / 60)}h ago`;
  return `${Math.round(mins / 1440)}d ago`;
};

export function adminPage(key: string): string {
  const d = db();
  const notices = noticeStats();
  const subs = subscriberStats();

  const jobs = d
    .prepare('SELECT job, started_at, ended_at, ok, stats, error FROM job_runs ORDER BY id DESC LIMIT 12')
    .all() as unknown as JobRow[];

  const lastIngest = d
    .prepare("SELECT started_at, ok FROM job_runs WHERE job = 'ingest' ORDER BY id DESC LIMIT 1")
    .get() as { started_at: string; ok: number | null } | undefined;

  const sentTotal = (d.prepare('SELECT COUNT(*) c FROM deliveries').get() as any).c as number;
  const sent7 = (
    d.prepare("SELECT COUNT(*) c FROM deliveries WHERE sent_at >= datetime('now','-7 day')").get() as any
  ).c as number;

  const signups = d
    .prepare(
      `SELECT date(created_at) d, COUNT(*) c FROM subscribers
       WHERE created_at >= datetime('now','-14 day') GROUP BY date(created_at) ORDER BY d DESC`,
    )
    .all() as unknown as Array<{ d: string; c: number }>;

  const recent = d
    .prepare('SELECT email, status, plan, created_at, last_digest_at FROM subscribers ORDER BY id DESC LIMIT 15')
    .all() as unknown as Array<{ email: string; status: string; plan: string; created_at: string; last_digest_at: string | null }>;

  const mrrCents = subs.paying * 2900;
  const priceHint = config.billing.priceLabel;

  // A stale ingest is the one failure that silently kills the product.
  const ingestStale = !lastIngest || Date.now() - Date.parse(lastIngest.started_at) > 36 * 3600_000;
  const warnings: string[] = [];
  if (ingestStale) warnings.push('Ingest has not run successfully in over 36 hours — the pipeline may be stalled.');
  if (config.mail.transport === 'outbox') warnings.push('MAIL_TRANSPORT=outbox — emails are written to disk, not sent.');
  if (!config.stripe.secretKey || !config.stripe.priceId) warnings.push('Stripe is not configured — nobody can pay yet.');
  if (config.security.secret === 'dev-insecure-secret-change-me') warnings.push('APP_SECRET is still the insecure default.');
  if (config.ted.offline) warnings.push('TED_OFFLINE=true — running on fixtures, not live EU data.');

  const jobRows = jobs
    .map((j) => {
      const badge = j.ok === 1 ? '<span class="tag" style="background:#f0fdf4;border-color:#bbf7d0">ok</span>'
        : j.ended_at ? '<span class="tag" style="background:#fef2f2;border-color:#fecaca">failed</span>'
        : '<span class="tag">running</span>';
      const detail = j.error ? h(j.error.split('\n')[0]!.slice(0, 120)) : h((j.stats ?? '').slice(0, 160));
      return `<tr><td>${h(j.job)}</td><td>${ago(j.started_at)}</td><td>${badge}</td><td style="font-size:12.5px;color:#475569">${detail}</td></tr>`;
    })
    .join('');

  const body = `
  <h1 style="margin-top:28px">Operations</h1>
  <p class="lede">${h(config.brand.name)} · ${h(config.baseUrl)}</p>

  ${warnings.length ? `<div class="notice error"><strong>Attention</strong><ul style="margin:8px 0 0 18px">${warnings.map((w) => `<li>${h(w)}</li>`).join('')}</ul></div>` : '<div class="notice ok">All systems nominal.</div>'}

  <div class="grid">
    <div class="card"><div class="stat">€${(mrrCents / 100).toLocaleString('en-GB')}</div><p>MRR estimate (${h(priceHint)} × ${subs.paying})</p></div>
    <div class="card"><div class="stat">${subs.paying}</div><p>paying / trialing</p></div>
    <div class="card"><div class="stat">${subs.free}</div><p>free confirmed</p></div>
    <div class="card"><div class="stat">${subs.pending}</div><p>awaiting confirmation</p></div>
  </div>
  <div class="grid">
    <div class="card"><div class="stat">${notices.total.toLocaleString('en-GB')}</div><p>notices indexed</p></div>
    <div class="card"><div class="stat">${notices.last7.toLocaleString('en-GB')}</div><p>published last 7 days</p></div>
    <div class="card"><div class="stat">${sent7.toLocaleString('en-GB')}</div><p>matches delivered (7d)</p></div>
    <div class="card"><div class="stat">${sentTotal.toLocaleString('en-GB')}</div><p>matches delivered (all time)</p></div>
  </div>

  <h2>Run a job now</h2>
  <p style="font-size:14px;color:#64748b">The scheduler runs these automatically; use these if you ever need to force one.</p>
  <div style="display:flex;gap:10px;flex-wrap:wrap">
    ${['ingest', 'digest-daily', 'digest-weekly']
      .map((j) => `<form method="post" action="/admin/run/${j}"><input type="hidden" name="key" value="${h(key)}"><button class="btn secondary" type="submit">${h(j)}</button></form>`)
      .join('')}
  </div>

  <h2>Recent job runs</h2>
  <table class="kv"><tr><td><strong>Job</strong></td><td><strong>Started</strong></td><td><strong>Result</strong></td><td><strong>Detail</strong></td></tr>${jobRows || '<tr><td colspan="4">No runs yet.</td></tr>'}</table>

  <h2>Signups (14 days)</h2>
  <table class="kv">${signups.map((s) => `<tr><td>${h(s.d)}</td><td>${s.c}</td></tr>`).join('') || '<tr><td>None yet</td><td></td></tr>'}</table>

  <h2>Latest subscribers</h2>
  <table class="kv"><tr><td><strong>Email</strong></td><td><strong>Status</strong></td><td><strong>Joined</strong></td><td><strong>Last digest</strong></td></tr>
  ${recent.map((r) => `<tr><td>${h(r.email)}</td><td>${h(r.status)}</td><td>${ago(r.created_at)}</td><td>${ago(r.last_digest_at)}</td></tr>`).join('') || '<tr><td colspan="4">None yet.</td></tr>'}</table>

  <h2>Health JSON</h2>
  <p><a href="/healthz">/healthz</a> — point an uptime monitor (UptimeRobot free tier) at this.</p>`;

  return layout({ title: 'Admin', body, description: 'Operator dashboard' });
}
