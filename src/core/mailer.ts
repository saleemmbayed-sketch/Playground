import fs from 'node:fs';
import path from 'node:path';
import nodemailer, { type Transporter } from 'nodemailer';
import { config } from '../config.js';
import { logEvent } from './db.js';

let transporter: Transporter | null = null;
let sentThisRun = 0;

export function resetSendCounter(): void {
  sentThisRun = 0;
}

function getTransport(): Transporter {
  if (transporter) return transporter;
  if (config.mail.transport === 'smtp') {
    if (!config.mail.smtpUrl) throw new Error('MAIL_TRANSPORT=smtp but SMTP_URL is empty');
    transporter = nodemailer.createTransport(config.mail.smtpUrl);
  } else {
    // Streams messages to data/outbox/*.eml — lets you inspect exactly what would ship.
    const dir = path.resolve(process.cwd(), 'data/outbox');
    fs.mkdirSync(dir, { recursive: true });
    transporter = nodemailer.createTransport({ streamTransport: true, newline: 'unix', buffer: true });
  }
  return transporter;
}

export interface MailInput {
  to: string;
  subject: string;
  html: string;
  text: string;
  unsubscribeUrl?: string;
}

export async function sendMail(msg: MailInput): Promise<{ ok: boolean; skipped?: string; file?: string }> {
  if (sentThisRun >= config.mail.maxPerRun) {
    return { ok: false, skipped: 'per-run send cap reached' };
  }
  sentThisRun += 1;

  const headers: Record<string, string> = {};
  if (msg.unsubscribeUrl) {
    headers['List-Unsubscribe'] = `<${msg.unsubscribeUrl}>`;
    headers['List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click';
  }

  const envelope = {
    from: `${config.brand.name} <${config.brand.fromEmail}>`,
    replyTo: config.brand.replyTo,
    to: msg.to,
    subject: msg.subject,
    text: msg.text,
    html: msg.html,
    headers,
  };

  const info: any = await getTransport().sendMail(envelope);

  if (config.mail.transport === 'outbox') {
    const dir = path.resolve(process.cwd(), 'data/outbox');
    const safe = msg.to.replace(/[^a-z0-9@._-]/gi, '_');
    const file = path.join(dir, `${Date.now()}-${safe}.eml`);
    fs.writeFileSync(file, info.message ?? Buffer.from(msg.text));
    logEvent('mail.outbox', { to: msg.to, subject: msg.subject, file });
    return { ok: true, file };
  }

  logEvent('mail.sent', { to: msg.to, subject: msg.subject, messageId: info.messageId });
  return { ok: true };
}

export async function verifyMailConfig(): Promise<{ ok: boolean; detail: string }> {
  if (config.mail.transport === 'outbox') return { ok: true, detail: 'outbox (no real sending)' };
  try {
    await getTransport().verify();
    return { ok: true, detail: 'smtp verified' };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}
