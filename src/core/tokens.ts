import crypto from 'node:crypto';
import { config } from '../config.js';

/**
 * Stateless signed tokens (HMAC) for unsubscribe + preference links.
 * No login, no passwords, no session store — the whole point is zero support load.
 */
export function signToken(payload: Record<string, unknown>, ttlDays = 400): string {
  const body = { ...payload, exp: Date.now() + ttlDays * 86_400_000 };
  const data = Buffer.from(JSON.stringify(body)).toString('base64url');
  const sig = crypto.createHmac('sha256', config.security.secret).update(data).digest('base64url');
  return `${data}.${sig}`;
}

export function verifyToken<T = Record<string, unknown>>(token: string): T | null {
  const [data, sig] = (token ?? '').split('.');
  if (!data || !sig) return null;
  const expected = crypto.createHmac('sha256', config.security.secret).update(data).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
    if (typeof parsed.exp === 'number' && parsed.exp < Date.now()) return null;
    return parsed as T;
  } catch {
    return null;
  }
}

export const accountUrl = (subscriberId: number): string =>
  `${config.baseUrl}/account?t=${signToken({ sub: subscriberId, scope: 'account' }, 30)}`;

export const unsubscribeUrl = (subscriberId: number): string =>
  `${config.baseUrl}/unsubscribe?t=${signToken({ sub: subscriberId, scope: 'unsub' })}`;

/** Double opt-in confirmation link. Short-lived on purpose. */
export const confirmUrl = (subscriberId: number): string =>
  `${config.baseUrl}/confirm?t=${signToken({ sub: subscriberId, scope: 'confirm' }, 14)}`;
