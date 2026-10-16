// FLOW HQ sign-in: users with scrypt password hashes (config file or env), HMAC-signed session cookies, a login rate limit.
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import type { Role, Viewer } from './adapters/types';

export interface UserRecord { email: string; name: string; role: Role; workspaces: string[]; passwordHash: string }
export const COOKIE = 'fhq_session';
const SESSION_HOURS = 12;

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 32, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}
export function verifyPassword(password: string, stored: string): boolean {
  const [kind, saltB64, hashB64] = String(stored || '').split('$');
  if (kind !== 'scrypt' || !saltB64 || !hashB64) return false;
  const want = Buffer.from(hashB64, 'base64');
  const got = scryptSync(password, Buffer.from(saltB64, 'base64'), want.length, { N: 16384, r: 8, p: 1 });
  return got.length === want.length && timingSafeEqual(got, want);
}

export function loadUsers(file: string, json: string): UserRecord[] {
  const raw = json || (existsSync(file) ? readFileSync(file, 'utf8') : '[]');
  const list = JSON.parse(raw) as UserRecord[];
  if (!Array.isArray(list)) throw new Error('users: expected a JSON array');
  return list.map((u) => ({ email: String(u.email).trim().toLowerCase(), name: String(u.name || u.email), role: u.role === 'admin' ? 'admin' : 'staff', workspaces: Array.isArray(u.workspaces) && u.workspaces.length ? u.workspaces.map(String) : ['*'], passwordHash: String(u.passwordHash || '') }));
}

export function signSession(email: string, secret: string, now = Date.now()): string {
  const payload = Buffer.from(JSON.stringify({ e: email, x: now + SESSION_HOURS * 3600000 })).toString('base64url');
  const sig = createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}
export function readSession(token: string | undefined, secret: string, now = Date.now()): string | null {
  if (!token || !token.includes('.')) return null;
  const [payload, sig] = token.split('.');
  const want = createHmac('sha256', secret).update(payload).digest('base64url');
  if (!sig || sig.length !== want.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return null;
  try {
    const p = JSON.parse(Buffer.from(payload, 'base64url').toString()) as { e: string; x: number };
    return p.x > now ? p.e : null;
  } catch { return null; }
}

export const viewerOf = (u: UserRecord): Viewer => ({ email: u.email, name: u.name, role: u.role });
export const canAccess = (u: UserRecord, workspaceId: string) => u.workspaces.includes('*') || u.workspaces.includes(workspaceId);

// 10 failed attempts per address per 15 minutes
const attempts = new Map<string, { n: number; first: number }>();
export function loginAllowed(key: string, now = Date.now()): boolean {
  const a = attempts.get(key);
  if (!a || now - a.first > 15 * 60000) return true;
  return a.n < 10;
}
export function loginFailed(key: string, now = Date.now()) {
  const a = attempts.get(key);
  if (!a || now - a.first > 15 * 60000) attempts.set(key, { n: 1, first: now });
  else a.n++;
}
export function loginSucceeded(key: string) { attempts.delete(key); }
