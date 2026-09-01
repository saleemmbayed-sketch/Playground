/**
 * Transactional emails: confirmation (double opt-in), welcome, and the settings link.
 *
 * German/EU direct-marketing law (UWG §7 / GDPR Art. 6) makes confirmed opt-in the safe
 * default for an email product, so nobody enters the sending audience until they click
 * the confirmation link. This also protects sender reputation, which is the single
 * biggest operational risk for an email business.
 */
import { config } from '../config.js';
import { sendMail } from './mailer.js';
import { accountUrl, confirmUrl, unsubscribeUrl } from './tokens.js';
import { escapeHtml } from './templates.js';

const h = escapeHtml;

function shell(bodyHtml: string, footerLinks: string): string {
  return `<!doctype html><html><body style="margin:0;background:#f6f7f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
  <div style="max-width:560px;margin:0 auto;padding:28px 22px;background:#fff">
    <div style="font-size:18px;font-weight:800;color:#0f172a;margin-bottom:18px">${h(config.brand.name)}</div>
    ${bodyHtml}
    <div style="margin-top:30px;font-size:12px;color:#9ca3af;line-height:1.6">
      ${footerLinks}<br>
      Source: Tenders Electronic Daily (TED), © European Union. ${h(config.brand.name)} is not affiliated with the EU.<br>
      ${h(config.brand.legalName)} · ${h(config.brand.legalAddress)}
    </div>
  </div></body></html>`;
}

const button = (url: string, label: string): string =>
  `<div style="margin:22px 0"><a href="${h(url)}" style="background:#1d4ed8;color:#fff;padding:12px 20px;border-radius:9px;text-decoration:none;font-weight:600;display:inline-block">${h(label)}</a></div>`;

/** Step 1 of double opt-in. Sent immediately on signup; no alerts until confirmed. */
export async function sendConfirmationEmail(subscriberId: number, email: string): Promise<void> {
  const url = confirmUrl(subscriberId);
  await sendMail({
    to: email,
    subject: `Confirm your ${config.brand.name} alerts`,
    html: shell(
      `<p style="font-size:16px;color:#111827;line-height:1.6">One click and your tender alerts start.</p>
       <p style="font-size:15px;color:#374151;line-height:1.6">We watch every new EU public IT and software tender
       published on TED and email you the ones matching your sectors, regions and keywords.</p>
       ${button(url, 'Confirm my subscription')}
       <p style="font-size:13px;color:#6b7280">If you did not request this, ignore this email — nothing will be sent.</p>
       <p style="font-size:12px;color:#9ca3af;word-break:break-all">Or paste this link: ${h(url)}</p>`,
      `You are receiving this because ${h(email)} was entered on ${h(config.baseUrl)}.`,
    ),
    text: [
      `Confirm your ${config.brand.name} alerts`,
      '',
      'One click and your tender alerts start:',
      url,
      '',
      'If you did not request this, ignore this email — nothing will be sent.',
    ].join('\n'),
  });
}

/** Step 2: sent right after confirmation, and after a successful Stripe checkout. */
export async function sendWelcomeEmail(
  subscriberId: number,
  email: string,
  opts: { pro?: boolean } = {},
): Promise<void> {
  const acct = accountUrl(subscriberId);
  const cadence = opts.pro
    ? 'Every morning we will email you every new tender that matches.'
    : 'Every Monday we will email you the week&rsquo;s top matches.';
  await sendMail({
    to: email,
    subject: opts.pro ? `Your ${config.brand.name} Pro alerts are live` : `You're subscribed to ${config.brand.name}`,
    html: shell(
      `<p style="font-size:16px;color:#111827;line-height:1.6">You're all set.</p>
       <p style="font-size:15px;color:#374151;line-height:1.6">${cadence}
       Spend two minutes tuning your filters now — it is the difference between a useful inbox and noise.</p>
       ${button(acct, 'Set my filters')}
       <p style="font-size:14px;color:#374151;line-height:1.7">
         <strong>Tips:</strong><br>
         · CPV prefixes are the strongest filter — <code>72</code> is IT services, <code>48</code> software.<br>
         · Add exclusion terms for work you never bid on; they are a hard filter.<br>
         · Raise the minimum match score if you get too much.
       </p>
       ${opts.pro ? '' : `<p style="font-size:14px;color:#374151">Want every match the morning it publishes? <a href="${h(`${config.baseUrl}/pricing`)}">Pro is ${h(config.billing.priceLabel)}</a>.</p>`}`,
      `<a href="${h(acct)}" style="color:#6b7280">Adjust filters</a> · <a href="${h(unsubscribeUrl(subscriberId))}" style="color:#6b7280">Unsubscribe</a>`,
    ),
    text: [
      `You're subscribed to ${config.brand.name}.`,
      '',
      'Set your filters here:',
      acct,
      '',
      `Unsubscribe: ${unsubscribeUrl(subscriberId)}`,
    ].join('\n'),
    unsubscribeUrl: unsubscribeUrl(subscriberId),
  });
}

/** Passwordless "email me my settings link" flow. */
export async function sendSettingsLinkEmail(subscriberId: number, email: string): Promise<void> {
  const acct = accountUrl(subscriberId);
  await sendMail({
    to: email,
    subject: `Your ${config.brand.name} settings link`,
    html: shell(
      `<p style="font-size:15px;color:#374151;line-height:1.6">Here is your private link to change filters,
       cadence or billing. It works for 30 days.</p>
       ${button(acct, 'Open my settings')}`,
      `<a href="${h(unsubscribeUrl(subscriberId))}" style="color:#6b7280">Unsubscribe</a>`,
    ),
    text: `Your ${config.brand.name} settings link:\n${acct}\n`,
    unsubscribeUrl: unsubscribeUrl(subscriberId),
  });
}
