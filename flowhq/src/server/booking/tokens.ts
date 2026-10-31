// Service tokens for the n8n-facing booking API. Completely separate from the browser sessions (cookie + CSRF header): this API accepts ONLY
// "Authorization: Bearer <id>.<secret>" and never reads a cookie. A token belongs to ONE workspace and carries explicit scopes.
// The file / env holds only a SHA-256 hash of the secret (the secret is 256 random bits, so a fast hash is the right tool), never the token itself.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

export const SCOPES = ['config:read', 'availability:read', 'appointments:read', 'appointments:create', 'appointments:update', 'appointments:cancel'] as const;
export type Scope = (typeof SCOPES)[number];
export type TokenSource = 'WhatsApp AI' | 'Other';
export interface TokenRecord { id: string; workspace: string; scopes: Scope[]; source: TokenSource; hash: string; expiresAt?: string; revoked?: boolean; note?: string }
export interface ServiceToken { id: string; workspace: string; scopes: ReadonlySet<Scope>; source: TokenSource }

const ID_RE = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;
export const hashSecret = (secret: string) => `sha256$${createHash('sha256').update(secret).digest('hex')}`;
/** A new token: show `token` once, store only `record.hash`. */
export function newToken(id: string, workspace: string, opts: { scopes?: Scope[]; source?: TokenSource; days?: number; now?: number } = {}): { token: string; record: TokenRecord } {
  if (!ID_RE.test(id)) throw new Error('token id: 3-40 characters, lower-case letters, digits and hyphens');
  const secret = randomBytes(32).toString('base64url');
  const record: TokenRecord = { id, workspace, scopes: opts.scopes || [...SCOPES], source: opts.source || 'WhatsApp AI', hash: hashSecret(secret), ...(opts.days ? { expiresAt: new Date((opts.now ?? Date.now()) + opts.days * 86400000).toISOString() } : {}) };
  return { token: `${id}.${secret}`, record };
}

export class TokenStore {
  private byId = new Map<string, TokenRecord>();
  constructor(records: TokenRecord[]) { for (const r of records) this.byId.set(r.id, r); }
  get size() { return this.byId.size; }
  /** The token behind an Authorization header, or null for anything wrong (missing, malformed, unknown, wrong secret, revoked, expired). Callers must not say which. */
  verify(header: string | undefined | null, now = Date.now()): ServiceToken | null {
    const m = /^Bearer\s+([A-Za-z0-9._~-]+)$/i.exec(String(header || '').trim());
    const dot = m ? m[1]!.indexOf('.') : -1;
    const id = m && dot > 0 ? m[1]!.slice(0, dot) : ''; const secret = m && dot > 0 ? m[1]!.slice(dot + 1) : '';
    const rec = this.byId.get(id);
    const want = Buffer.from((rec?.hash || hashSecret('no-such-token')).slice('sha256$'.length), 'hex');   // always hash + compare, so an unknown id costs the same as a wrong secret
    const got = Buffer.from(hashSecret(secret).slice('sha256$'.length), 'hex');
    const same = want.length === got.length && timingSafeEqual(want, got);
    if (!rec || !secret || !same || rec.revoked === true) return null;
    if (rec.expiresAt && !(Date.parse(rec.expiresAt) > now)) return null;
    return { id: rec.id, workspace: rec.workspace, scopes: new Set(rec.scopes), source: rec.source };
  }
}

export function loadTokens(file: string, json: string): TokenRecord[] {
  const raw = json || (file && existsSync(file) ? readFileSync(file, 'utf8') : '[]');
  const list = JSON.parse(raw) as unknown;
  if (!Array.isArray(list)) throw new Error('booking tokens: expected a JSON array');
  return list.map((x, i) => {
    const r = x as Partial<TokenRecord>;
    if (!r.id || !ID_RE.test(String(r.id))) throw new Error(`booking tokens: entry ${i + 1} has no valid id`);
    if (!r.workspace || !/^[a-z0-9-]{2,60}$/.test(String(r.workspace))) throw new Error(`booking tokens: "${r.id}" needs a workspace slug`);
    if (!/^sha256\$[0-9a-f]{64}$/.test(String(r.hash))) throw new Error(`booking tokens: "${r.id}" needs a sha256 hash (npm run booking-token)`);
    const scopes = (Array.isArray(r.scopes) ? r.scopes : []).filter((s): s is Scope => (SCOPES as readonly string[]).includes(String(s)));
    return { id: r.id, workspace: r.workspace, scopes, source: r.source === 'Other' ? 'Other' : 'WhatsApp AI', hash: r.hash!, ...(r.expiresAt ? { expiresAt: String(r.expiresAt) } : {}), ...(r.revoked === true ? { revoked: true } : {}), ...(r.note ? { note: String(r.note).slice(0, 120) } : {}) };
  });
}

// Failed-token attempts per address: 20 per 15 minutes, then 429 until the window ends. (Successful calls are never counted.)
const fails = new Map<string, { n: number; first: number }>();
export const tokenAllowed = (key: string, now = Date.now()) => { const a = fails.get(key); return !a || now - a.first > 15 * 60000 || a.n < 20; };
export function tokenFailed(key: string, now = Date.now()) { const a = fails.get(key); if (!a || now - a.first > 15 * 60000) fails.set(key, { n: 1, first: now }); else a.n++; }
export const resetTokenFailures = () => fails.clear();
