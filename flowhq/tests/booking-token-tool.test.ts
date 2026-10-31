// The operator tool `booking-token` (src/server/tools/booking-token.ts): printing only, --write, duplicate refusal, expiry warning, revoke. Runs the real script as a child process.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { TokenStore, loadTokens } from '../src/server/booking/tokens';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const run = (args: string[], file: string) => { const r = spawnSync(process.execPath, ['--import', 'tsx', 'src/server/tools/booking-token.ts', ...args], { env: { ...process.env, FLOWHQ_BOOKING_TOKENS_FILE: file }, encoding: 'utf8' }); return { code: r.status, out: r.stdout, err: r.stderr }; };
const tmp = () => { const d = mkdtempSync(path.join(os.tmpdir(), 'tok-')); dirs.push(d); return path.join(d, 'booking-tokens.json'); };
const secretOf = (out: string) => out.match(/\n\s+(n8n-[a-z0-9-]+\.[A-Za-z0-9_-]{30,})\n/)?.[1];

describe('booking-token', () => {
  it('without --write nothing is written; the token is printed once with its hash-only entry', () => {
    const f = tmp(); const r = run(['n8n-a', 'demo-physio', '--days', '90'], f);
    expect(r.code).toBe(0); const tok = secretOf(r.out); expect(tok).toBeTruthy();
    expect(() => readFileSync(f)).toThrow(); expect(r.out).toContain('"hash": "sha256$'); expect(r.out).not.toContain(`"${tok!.split('.')[1]}"`);
    expect(r.err).not.toMatch(/never expires/);
  }, 30000);

  it('--write appends the entry (hash only), the file is owner-only, the token works through the real loader, a duplicate id is refused', () => {
    const f = tmp(); const a = run(['n8n-a', 'demo-physio', '--days', '90', '--write'], f); expect(a.code, a.err).toBe(0);
    const tok = secretOf(a.out)!; const text = readFileSync(f, 'utf8'); expect(text).toContain('sha256$'); expect(text).not.toContain(tok.split('.')[1]!);
    if (process.platform !== 'win32') expect((statSync(f).mode & 0o777).toString(8)).toBe('600');
    const store = new TokenStore(loadTokens(f, ''));
    expect(store.verify(`Bearer ${tok}`)?.id, 'the printed token authenticates through the real loader').toBe('n8n-a');
    expect(store.verify('Bearer n8n-a.' + 'x'.repeat(43))).toBeNull();
    const b = run(['n8n-b', 'demo-physio', '--days', '30', '--write'], f); expect(b.code).toBe(0); expect(JSON.parse(readFileSync(f, 'utf8')).map((t: { id: string }) => t.id)).toEqual(['n8n-a', 'n8n-b']);
    const dup = run(['n8n-a', 'demo-physio', '--days', '90', '--write'], f); expect(dup.code).toBe(1); expect(dup.err).toMatch(/already exists/); expect(JSON.parse(readFileSync(f, 'utf8'))).toHaveLength(2);
  }, 60000);

  it('a token with no expiry is allowed but warned about; bad input is refused', () => {
    const f = tmp(); const r = run(['n8n-c', 'demo-physio', '--write'], f); expect(r.code).toBe(0); expect(r.err).toMatch(/NEVER expires/);
    expect(run(['n8n-d', 'demo-physio', '--days', '0'], f).code).toBe(2); expect(run(['n8n-d', 'demo-physio', '--scopes', 'consent:write'], f).code).toBe(2); expect(run(['Bad Id', 'demo-physio'], f).code).not.toBe(0);
  }, 60000);

  it('revoke: sets "revoked": true (idempotent), refuses an unknown id, keeps the other tokens', () => {
    const f = tmp(); run(['n8n-a', 'demo-physio', '--days', '90', '--write'], f); run(['n8n-b', 'demo-physio', '--days', '90', '--write'], f);
    const r = run(['revoke', 'n8n-a'], f); expect(r.code, r.err).toBe(0);
    const list = JSON.parse(readFileSync(f, 'utf8')); expect(list.find((t: { id: string }) => t.id === 'n8n-a').revoked).toBe(true); expect(list.find((t: { id: string }) => t.id === 'n8n-b').revoked).toBeUndefined();
    expect(run(['revoke', 'n8n-a'], f).out).toMatch(/already revoked/); expect(new TokenStore(loadTokens(f, '')).verify(`Bearer ${'n8n-a.' + 'x'.repeat(43)}`)).toBeNull(); expect(run(['revoke', 'n8n-zzz'], f).code).toBe(1);
    writeFileSync(`${f}.bak`, ''); // (a stray file next to it changes nothing)
  }, 60000);
});
