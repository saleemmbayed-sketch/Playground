import { config } from '../config.js';
import type { ScoredNotice } from './match.js';

export const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const money = (n: number | null, cur: string | null): string =>
  n == null ? '—' : `${Math.round(n).toLocaleString('en-GB')} ${cur ?? 'EUR'}`;

export interface DigestOptions {
  items: ScoredNotice[];
  accountUrl: string;
  unsubscribeUrl: string;
  intro?: string;
  upsell?: boolean;
  totalAvailable?: number;
}

export function digestSubject(items: ScoredNotice[], period: string): string {
  const n = items.length;
  if (n === 0) return `${config.brand.name}: no new matches ${period}`;
  const top = items[0]!.notice.title.replace(/\s+/g, ' ').slice(0, 60);
  return n === 1
    ? `${config.brand.name}: 1 new tender — ${top}`
    : `${config.brand.name}: ${n} new tenders — ${top}…`;
}

export function digestHtml(o: DigestOptions): string {
  const rows = o.items
    .map((it) => {
      const n = it.notice;
      const reasons = it.reasons.length
        ? `<div style="font-size:12px;color:#5b6472;margin-top:6px">Why: ${escapeHtml(it.reasons.join(' · '))}</div>`
        : '';
      return `
      <tr><td style="padding:16px 0;border-bottom:1px solid #e6e8ec">
        <div style="font-size:12px;color:#6b7280;letter-spacing:.02em">
          ${escapeHtml(n.buyer_country ?? '??')} · ${escapeHtml(n.publication_date ?? '')} · match ${Math.round(it.score * 100)}%
        </div>
        <a href="${escapeHtml(`${config.baseUrl}/tender/${encodeURIComponent(n.id)}`)}"
           style="display:block;margin:4px 0;font-size:16px;font-weight:600;color:#111827;text-decoration:none">
          ${escapeHtml(n.title)}
        </a>
        <div style="font-size:14px;color:#374151;line-height:1.5">${escapeHtml(n.summary ?? '')}</div>
        <div style="font-size:13px;color:#374151;margin-top:8px">
          <strong>Buyer:</strong> ${escapeHtml(n.buyer_name ?? 'n/a')} &nbsp;·&nbsp;
          <strong>Value:</strong> ${escapeHtml(money(n.value_amount, n.value_currency))} &nbsp;·&nbsp;
          <strong>Deadline:</strong> ${escapeHtml(n.deadline_date ?? 'see notice')}
        </div>
        ${reasons}
        <div style="margin-top:10px">
          <a href="${escapeHtml(n.url_html ?? '')}" style="font-size:13px;color:#1d4ed8">Official TED notice →</a>
        </div>
      </td></tr>`;
    })
    .join('');

  const upsell = o.upsell
    ? `<div style="margin:24px 0;padding:16px;background:#f1f5ff;border-radius:10px;font-size:14px;color:#1f2937">
         <strong>You're on the free weekly digest.</strong> ${
           o.totalAvailable ? `${o.totalAvailable} more tenders matched your profile this week. ` : ''
         }Pro sends every match the morning it is published, filtered to your CPV codes, regions and keywords —
         ${escapeHtml(config.billing.priceLabel)}, cancel anytime.
         <div style="margin-top:12px"><a href="${escapeHtml(`${config.baseUrl}/pricing`)}"
           style="background:#1d4ed8;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none;display:inline-block">
           Start ${config.billing.trialDays}-day free trial</a></div>
       </div>`
    : '';

  return `<!doctype html><html><body style="margin:0;background:#f6f7f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
  <div style="max-width:640px;margin:0 auto;padding:24px 20px;background:#ffffff">
    <div style="font-size:18px;font-weight:700;color:#111827">${escapeHtml(config.brand.name)}</div>
    <div style="font-size:13px;color:#6b7280;margin-bottom:16px">${escapeHtml(o.intro ?? 'Your new matching tenders')}</div>
    ${o.items.length ? `<table width="100%" cellpadding="0" cellspacing="0">${rows}</table>` : '<p style="font-size:14px;color:#374151">No new tenders matched your profile. We only email when there is something worth your time.</p>'}
    ${upsell}
    <div style="margin-top:28px;font-size:12px;color:#9ca3af;line-height:1.6">
      <a href="${escapeHtml(o.accountUrl)}" style="color:#6b7280">Adjust filters</a> ·
      <a href="${escapeHtml(o.unsubscribeUrl)}" style="color:#6b7280">Unsubscribe</a><br>
      Source: Tenders Electronic Daily (TED), © European Union. ${escapeHtml(config.brand.name)} is not affiliated with the EU.<br>
      ${escapeHtml(config.brand.legalName)} · ${escapeHtml(config.brand.legalAddress)}
    </div>
  </div></body></html>`;
}

export function digestText(o: DigestOptions): string {
  const lines: string[] = [config.brand.name, o.intro ?? 'Your new matching tenders', ''];
  if (!o.items.length) lines.push('No new tenders matched your profile.');
  for (const it of o.items) {
    const n = it.notice;
    lines.push(
      `— ${n.title}`,
      `  ${n.buyer_name ?? 'n/a'} (${n.buyer_country ?? '??'}) · value ${money(n.value_amount, n.value_currency)} · deadline ${n.deadline_date ?? 'see notice'}`,
      `  ${n.summary ?? ''}`,
      `  Match ${Math.round(it.score * 100)}%${it.reasons.length ? ` — ${it.reasons.join(' · ')}` : ''}`,
      `  ${config.baseUrl}/tender/${encodeURIComponent(n.id)}`,
      '',
    );
  }
  if (o.upsell) {
    lines.push(
      `Free weekly digest. Pro = every match, every morning, ${config.billing.priceLabel}.`,
      `${config.baseUrl}/pricing`,
      '',
    );
  }
  lines.push(`Adjust filters: ${o.accountUrl}`, `Unsubscribe: ${o.unsubscribeUrl}`, '',
    'Source: Tenders Electronic Daily (TED), © European Union. Not affiliated with the EU.');
  return lines.join('\n');
}
