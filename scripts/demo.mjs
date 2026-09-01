#!/usr/bin/env node
/**
 * One-command local demo: fixtures -> seed -> subscriber -> digest.
 * Everything runs offline; no API keys, no network, no email actually sent.
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';

const run = (cmd) => {
  console.log(`\n$ ${cmd}`);
  execSync(cmd, { stdio: 'inherit', env: { ...process.env, NODE_NO_WARNINGS: '1' } });
};

if (!fs.existsSync('.env')) {
  fs.writeFileSync('.env', [
    'NODE_ENV=development',
    'BASE_URL=http://localhost:3000',
    'TED_OFFLINE=true',
    'MAIL_TRANSPORT=outbox',
    'APP_SECRET=dev-demo-secret-not-for-production',
    'BRAND_NAME=TenderPing',
    'LEGAL_NAME=Demo Owner (Einzelunternehmer)',
    'LEGAL_ADDRESS=Musterstr. 1, 89073 Ulm, Germany',
    'FROM_EMAIL=alerts@example.com',
    'REPLY_TO=hello@example.com',
    'SCHEDULER_ENABLED=false',
    '',
  ].join('\n'));
  console.log('created .env for local development');
}

run('node scripts/make-fixtures.mjs 36');
run('npx tsx src/cli.ts seed');
run('npx tsx src/cli.ts add-subscriber demo@example.com --cpv 72,48 --countries DEU,AUT --keywords cloud,portal --pro');
run('npx tsx src/cli.ts preview demo@example.com');
run('npx tsx src/cli.ts digest-daily');
run('npx tsx src/cli.ts doctor');

const outbox = fs.existsSync('data/outbox') ? fs.readdirSync('data/outbox') : [];
console.log(`\nGenerated ${outbox.length} email(s) in data/outbox/ — open one to see what a subscriber gets.`);
console.log('Now run:  npm run dev     then open http://localhost:3000');
console.log('Admin:    http://localhost:3000/admin?key=dev-demo-secret-not-for-production\n');
