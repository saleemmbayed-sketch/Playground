import { config } from '../config.js';
import { escapeHtml } from '../core/templates.js';
import type { NoticeRow } from '../core/notices.js';

export const h = escapeHtml;

const CSS = `
:root{--ink:#0f172a;--muted:#64748b;--line:#e2e8f0;--brand:#1d4ed8;--bg:#f8fafc}
*{box-sizing:border-box}
body{margin:0;font:16px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:var(--ink);background:#fff}
a{color:var(--brand)}
header.top{border-bottom:1px solid var(--line);position:sticky;top:0;background:#fffe;backdrop-filter:blur(6px);z-index:10}
.wrap{max-width:960px;margin:0 auto;padding:0 20px}
header.top .wrap{display:flex;align-items:center;justify-content:space-between;height:60px}
.brand{font-weight:800;letter-spacing:-.02em;text-decoration:none;color:var(--ink);font-size:18px}
nav a{margin-left:18px;font-size:14px;color:var(--muted);text-decoration:none}
nav a:hover{color:var(--ink)}
.hero{padding:64px 0 40px}
h1{font-size:40px;line-height:1.15;letter-spacing:-.03em;margin:0 0 16px}
h2{font-size:24px;letter-spacing:-.02em;margin:40px 0 12px}
.lede{font-size:19px;color:#334155;max-width:640px}
.btn{display:inline-block;background:var(--brand);color:#fff;padding:12px 20px;border-radius:9px;text-decoration:none;font-weight:600;border:0;cursor:pointer;font-size:16px}
.btn.secondary{background:#fff;color:var(--ink);border:1px solid var(--line)}
form.inline{display:flex;gap:8px;flex-wrap:wrap;margin:24px 0}
input,select,textarea{padding:11px 13px;border:1px solid var(--line);border-radius:9px;font-size:15px;font-family:inherit;background:#fff}
input[type=email]{min-width:280px}
.grid{display:grid;gap:16px;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));margin:24px 0}
.card{border:1px solid var(--line);border-radius:12px;padding:18px;background:#fff}
.card h3{margin:0 0 6px;font-size:16px}
.card p{margin:0;color:var(--muted);font-size:14px}
.stat{font-size:28px;font-weight:700;letter-spacing:-.02em}
.tender{border-bottom:1px solid var(--line);padding:18px 0}
.tender .meta{font-size:12.5px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em}
.tender h3{margin:4px 0 6px;font-size:17px}
.tender h3 a{color:var(--ink);text-decoration:none}
.tender h3 a:hover{color:var(--brand)}
.tender p{margin:0;color:#334155;font-size:14.5px}
.tag{display:inline-block;font-size:12px;background:var(--bg);border:1px solid var(--line);border-radius:999px;padding:2px 9px;margin:6px 6px 0 0;color:#475569}
table.kv{border-collapse:collapse;width:100%;margin:16px 0}
table.kv td{border-bottom:1px solid var(--line);padding:9px 0;font-size:14.5px;vertical-align:top}
table.kv td:first-child{color:var(--muted);width:190px}
.notice{background:#f1f5ff;border:1px solid #dbe4ff;border-radius:10px;padding:14px;font-size:14.5px;margin:20px 0}
.error{background:#fef2f2;border-color:#fecaca;color:#991b1b}
.ok{background:#f0fdf4;border-color:#bbf7d0;color:#166534}
footer{margin-top:64px;border-top:1px solid var(--line);padding:28px 0 48px;color:var(--muted);font-size:13px}
.price{font-size:38px;font-weight:800;letter-spacing:-.02em}
label{display:block;font-size:13px;color:var(--muted);margin:14px 0 5px}
.row{display:grid;grid-template-columns:1fr 1fr;gap:14px}
@media(max-width:640px){h1{font-size:31px}.row{grid-template-columns:1fr}}
`;

export function layout(opts: {
  title: string;
  description?: string;
  body: string;
  canonical?: string;
  jsonLd?: unknown;
}): string {
  const desc = opts.description ?? config.brand.tagline;
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${h(opts.title)}</title>
<meta name="description" content="${h(desc)}">
${opts.canonical ? `<link rel="canonical" href="${h(opts.canonical)}">` : ''}
<meta property="og:title" content="${h(opts.title)}"><meta property="og:description" content="${h(desc)}">
<meta property="og:type" content="website"><meta name="robots" content="index,follow">
<link rel="alternate" type="application/rss+xml" title="${h(config.brand.name)} tenders" href="/feed.xml">
<style>${CSS}</style>
${opts.jsonLd ? `<script type="application/ld+json">${JSON.stringify(opts.jsonLd)}</script>` : ''}
</head><body>
<header class="top"><div class="wrap">
  <a class="brand" href="/">${h(config.brand.name)}</a>
  <nav>
    <a href="/tenders">Live tenders</a>
    <a href="/pricing">Pricing</a>
    <a href="/account">Account</a>
  </nav>
</div></header>
<main class="wrap">${opts.body}</main>
<footer class="wrap">
  <p>Data source: <a href="https://ted.europa.eu">Tenders Electronic Daily (TED)</a>, © European Union, reused under the
  <a href="https://eur-lex.europa.eu/eli/dec/2011/833/oj">Commission Decision 2011/833/EU</a> reuse policy.
  ${h(config.brand.name)} is an independent service and is not affiliated with or endorsed by the European Union.</p>
  <p>${h(config.brand.legalName)} · ${h(config.brand.legalAddress)} · <a href="/legal">Legal &amp; privacy</a></p>
</footer></body></html>`;
}

export const money = (n: number | null, cur: string | null): string =>
  n == null ? '—' : `${Math.round(n).toLocaleString('en-GB')} ${cur ?? 'EUR'}`;

export function tenderCard(n: NoticeRow): string {
  return `<div class="tender">
    <div class="meta">${h(n.buyer_country ?? '??')} · ${h(n.publication_date ?? '')} ${
      n.deadline_date ? `· closes ${h(n.deadline_date)}` : ''
    }</div>
    <h3><a href="/tender/${encodeURIComponent(n.id)}">${h(n.title)}</a></h3>
    <p>${h((n.summary ?? '').slice(0, 240))}</p>
    <div>${(n.cpv ?? '').split(',').filter(Boolean).slice(0, 4).map((c) => `<span class="tag">CPV ${h(c)}</span>`).join('')}
    ${n.value_amount ? `<span class="tag">${h(money(n.value_amount, n.value_currency))}</span>` : ''}</div>
  </div>`;
}

export const CPV_SECTORS: Array<{ code: string; label: string }> = [
  { code: '72', label: 'IT services & consultancy' },
  { code: '48', label: 'Software packages' },
  { code: '30', label: 'Computer hardware' },
  { code: '79', label: 'Business & professional services' },
  { code: '71', label: 'Engineering & architecture' },
  { code: '32', label: 'Telecoms equipment' },
  { code: '73', label: 'R&D services' },
  { code: '80', label: 'Education & training' },
];
