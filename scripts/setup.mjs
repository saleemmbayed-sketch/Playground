#!/usr/bin/env node
/**
 * Interactive first-run wizard: writes a complete, valid .env so the operator never has to
 * hand-assemble configuration. Safe to re-run — it shows current values as defaults.
 *
 *   npm run setup
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

const ENV_PATH = path.resolve('.env');
const rl = readline.createInterface({ input, output });

const existing = fs.existsSync(ENV_PATH)
  ? Object.fromEntries(
      fs
        .readFileSync(ENV_PATH, 'utf8')
        .split('\n')
        .filter((l) => l.trim() && !l.trim().startsWith('#') && l.includes('='))
        .map((l) => {
          const i = l.indexOf('=');
          return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
        }),
    )
  : {};

const c = {
  b: (s) => `\x1b[1m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
};

async function ask(label, key, dflt = '', hint = '') {
  const current = existing[key] || dflt;
  const shown = current ? c.dim(` [${current}]`) : '';
  if (hint) console.log(c.dim(`   ${hint}`));
  const answer = (await rl.question(`${label}${shown}: `)).trim();
  return answer || current;
}

async function askYesNo(label, dflt = true) {
  const answer = (await rl.question(`${label} ${c.dim(dflt ? '[Y/n]' : '[y/N]')}: `)).trim().toLowerCase();
  if (!answer) return dflt;
  return answer.startsWith('y');
}

console.log(`
${c.b('TenderPing setup')}
${c.dim('Writes .env. Press Enter to keep the value in brackets. Nothing is sent anywhere.')}
`);

const env = {};

console.log(c.b('\n1. Your site'));
env.BASE_URL = (await ask('Public URL', 'BASE_URL', 'https://tenderping.eu', 'No trailing slash. Must match your domain exactly — emails and Stripe redirects use it.')).replace(/\/$/, '');
env.BRAND_NAME = await ask('Brand name', 'BRAND_NAME', 'TenderPing');

console.log(c.b('\n2. Legal (required for a German Impressum)'));
env.LEGAL_NAME = await ask('Legal name', 'LEGAL_NAME', 'Your Name (Einzelunternehmer)');
env.LEGAL_ADDRESS = await ask('Legal address', 'LEGAL_ADDRESS', 'Street 1, 89073 Ulm, Germany');
env.FROM_EMAIL = await ask('From address', 'FROM_EMAIL', `alerts@${new URL(env.BASE_URL).hostname.replace(/^www\./, '')}`);
env.REPLY_TO = await ask('Reply-to address', 'REPLY_TO', `hello@${new URL(env.BASE_URL).hostname.replace(/^www\./, '')}`);

console.log(c.b('\n3. Market focus'));
env.TED_CPV_FAMILIES = await ask('CPV families to ingest', 'TED_CPV_FAMILIES', '72,48,30,79,71,32,73,80', '2-digit prefixes. 72=IT services, 48=software, 30=hardware, 79=business services.');
env.TED_COUNTRIES = await ask('Restrict to countries (ISO3, blank = all EU)', 'TED_COUNTRIES', '', 'e.g. DEU,AUT,CHE. Blank gives you the whole EU — more inventory, more languages.');

console.log(c.b('\n4. Email sending'));
console.log(c.dim('   Free tiers: Resend (3k/mo), Brevo (300/day). You must verify your domain and add SPF+DKIM+DMARC.'));
const wantsSmtp = await askYesNo('Do you have an SMTP URL ready?', Boolean(existing.SMTP_URL));
if (wantsSmtp) {
  env.SMTP_URL = await ask('SMTP URL', 'SMTP_URL', '', 'e.g. smtp://resend:re_xxxxx@smtp.resend.com:587');
  env.MAIL_TRANSPORT = env.SMTP_URL ? 'smtp' : 'outbox';
} else {
  env.MAIL_TRANSPORT = 'outbox';
  env.SMTP_URL = existing.SMTP_URL || '';
  console.log(c.yellow('   → Staying in outbox mode: emails are written to data/outbox/ instead of sent.'));
}

console.log(c.b('\n5. Payments'));
const wantsStripe = await askYesNo('Configure Stripe now?', Boolean(existing.STRIPE_SECRET_KEY));
if (wantsStripe) {
  env.STRIPE_SECRET_KEY = await ask('Stripe secret key', 'STRIPE_SECRET_KEY', '', 'sk_live_… or sk_test_… from dashboard.stripe.com/apikeys');
  env.STRIPE_PRICE_ID = await ask('Stripe price ID (blank = create it for me)', 'STRIPE_PRICE_ID', '');
  env.STRIPE_WEBHOOK_SECRET = await ask('Stripe webhook secret (blank = create it for me)', 'STRIPE_WEBHOOK_SECRET', '');
} else {
  env.STRIPE_SECRET_KEY = existing.STRIPE_SECRET_KEY || '';
  env.STRIPE_PRICE_ID = existing.STRIPE_PRICE_ID || '';
  env.STRIPE_WEBHOOK_SECRET = existing.STRIPE_WEBHOOK_SECRET || '';
}
env.PRICE_LABEL = await ask('Price label shown on the site', 'PRICE_LABEL', '€29 / month');
env.TRIAL_DAYS = await ask('Free trial days', 'TRIAL_DAYS', '14');

console.log(c.b('\n6. Optional AI summaries'));
console.log(c.dim('   Leave blank for zero cost — the service writes deterministic summaries instead.'));
env.LLM_API_KEY = await ask('LLM API key (optional)', 'LLM_API_KEY', '');
env.LLM_BASE_URL = existing.LLM_BASE_URL || 'https://api.openai.com/v1';
env.LLM_MODEL = existing.LLM_MODEL || 'gpt-4o-mini';
env.LLM_MAX_ENRICH_PER_DAY = existing.LLM_MAX_ENRICH_PER_DAY || '120';

// Non-interactive defaults
env.NODE_ENV = 'production';
env.PORT = existing.PORT || '3000';
env.HOST = '0.0.0.0';
env.APP_SECRET = existing.APP_SECRET && existing.APP_SECRET !== 'dev-insecure-secret-change-me'
  ? existing.APP_SECRET
  : crypto.randomBytes(32).toString('hex');
env.TED_OFFLINE = 'false';
env.TED_LOOKBACK_DAYS = existing.TED_LOOKBACK_DAYS || '2';
env.TED_MAX_NOTICES = existing.TED_MAX_NOTICES || '1500';
env.TED_PAGE_SIZE = existing.TED_PAGE_SIZE || '100';
env.TED_REQUEST_DELAY_MS = existing.TED_REQUEST_DELAY_MS || '400';
env.MAIL_MAX_PER_RUN = existing.MAIL_MAX_PER_RUN || '200';
env.SCHEDULER_ENABLED = 'true';
env.INGEST_HOUR_UTC = existing.INGEST_HOUR_UTC || '4';
env.DIGEST_HOUR_UTC = existing.DIGEST_HOUR_UTC || '5';
env.WEEKLY_DIGEST_DAY = existing.WEEKLY_DIGEST_DAY || '1';
env.BRAND_TAGLINE = existing.BRAND_TAGLINE || 'Every new EU public IT tender, filtered to the ones you could actually win.';

const order = [
  ['Core', ['NODE_ENV', 'PORT', 'HOST', 'BASE_URL', 'APP_SECRET']],
  ['Brand and legal', ['BRAND_NAME', 'BRAND_TAGLINE', 'FROM_EMAIL', 'REPLY_TO', 'LEGAL_NAME', 'LEGAL_ADDRESS']],
  ['TED data source', ['TED_OFFLINE', 'TED_CPV_FAMILIES', 'TED_COUNTRIES', 'TED_LOOKBACK_DAYS', 'TED_MAX_NOTICES', 'TED_PAGE_SIZE', 'TED_REQUEST_DELAY_MS']],
  ['Email', ['MAIL_TRANSPORT', 'SMTP_URL', 'MAIL_MAX_PER_RUN']],
  ['Stripe', ['STRIPE_SECRET_KEY', 'STRIPE_PRICE_ID', 'STRIPE_WEBHOOK_SECRET', 'PRICE_LABEL', 'TRIAL_DAYS']],
  ['LLM (optional)', ['LLM_API_KEY', 'LLM_BASE_URL', 'LLM_MODEL', 'LLM_MAX_ENRICH_PER_DAY']],
  ['Scheduler (UTC)', ['SCHEDULER_ENABLED', 'INGEST_HOUR_UTC', 'DIGEST_HOUR_UTC', 'WEEKLY_DIGEST_DAY']],
];

let out = `# Generated by \`npm run setup\` on ${new Date().toISOString()}\n`;
for (const [section, keys] of order) {
  out += `\n# ---- ${section} ----\n`;
  for (const k of keys) out += `${k}=${env[k] ?? ''}\n`;
}

if (fs.existsSync(ENV_PATH)) fs.copyFileSync(ENV_PATH, `${ENV_PATH}.bak`);
fs.writeFileSync(ENV_PATH, out);
rl.close();

console.log(`
${c.green('✓')} Wrote ${c.b('.env')}${fs.existsSync(`${ENV_PATH}.bak`) ? c.dim(' (previous version saved as .env.bak)') : ''}

${c.b('Next steps')}
  1. ${c.b('npm run cli -- setup-stripe')}     create the product, price, webhook and portal
  2. ${c.b('npm run cli -- ingest --days 30')} fill the archive so the site has content
  3. ${c.b('npm run doctor')}                  verify every dependency end to end
  4. ${c.b('docker compose up -d')}            go live

${c.dim('Full checklist: LAUNCH.md')}
`);
