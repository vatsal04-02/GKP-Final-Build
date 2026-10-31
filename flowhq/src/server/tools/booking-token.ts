// Makes a service token for the n8n booking API. Prints the token ONCE (give it to n8n as a credential) and the entry for config/booking-tokens.json (only the hash is in it).
//   npm run booking-token -- <token-id> <clinic-slug> [--days 90] [--scopes availability:read,appointments:create,...] [--write]
//   npm run booking-token -- revoke <token-id>
// Without --write nothing is written anywhere (copy the printed entry into the file yourself). With --write the entry is appended to the tokens file
// (FLOWHQ_BOOKING_TOKENS_FILE, default config/booking-tokens.json): atomically, owner-only (mode 600), and never over an existing id. `revoke` sets "revoked": true.
// Tokens are read at start-up: restart FLOW HQ afterwards. In the production image: docker compose exec flowhq node dist/tools/booking-token.mjs ...
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { SCOPES, newToken, type Scope, type TokenRecord } from '../booking/tokens';

const file = process.env.FLOWHQ_BOOKING_TOKENS_FILE || path.resolve('config/booking-tokens.json');
const load = (): TokenRecord[] => { if (!existsSync(file)) return []; const v = JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, '')); if (!Array.isArray(v)) throw new Error(`${file} must be a JSON array`); return v as TokenRecord[]; };
const save = (list: TokenRecord[]) => { const tmp = `${file}.${process.pid}.tmp`; writeFileSync(tmp, `${JSON.stringify(list, null, 2)}\n`, { mode: 0o600 }); try { chmodSync(tmp, 0o600); } catch { /* not supported on this filesystem */ } renameSync(tmp, file); };

const args = process.argv.slice(2);
if (args[0] === 'revoke') {
  const id = args[1];
  if (!id) { console.error('Usage: npm run booking-token -- revoke <token-id>'); process.exit(2); }
  const list = load(); const hit = list.find((t) => t.id === id);
  if (!hit) { console.error(`No token "${id}" in ${file}`); process.exit(1); }
  if (hit.revoked) { console.log(`Token "${id}" was already revoked. Nothing changed.`); process.exit(0); }
  hit.revoked = true; save(list);
  console.log(`Token "${id}" is revoked in ${file}. Restart FLOW HQ for it to take effect (a revoked token gets 401 from then on).`);
  process.exit(0);
}

const [id, workspace, ...rest] = args.filter((a) => a !== '--write');
const write = args.includes('--write');
if (!id || !workspace) { console.error('Usage: npm run booking-token -- <token-id> <clinic-slug> [--days N] [--scopes a,b,c] [--write]\n       npm run booking-token -- revoke <token-id>'); process.exit(2); }
const flag = (n: string) => { const i = rest.indexOf(n); return i >= 0 ? rest[i + 1] : undefined; };
const days = flag('--days') ? Number(flag('--days')) : undefined;
const scopes = flag('--scopes') ? flag('--scopes')!.split(',').map((s) => s.trim()) : undefined;
if (days !== undefined && !(Number.isInteger(days) && days > 0 && days <= 3650)) { console.error('--days must be a whole number from 1 to 3650'); process.exit(2); }
const bad = scopes?.filter((s) => !(SCOPES as readonly string[]).includes(s));
if (bad?.length) { console.error(`Unknown scope(s): ${bad.join(', ')}. Valid: ${SCOPES.join(', ')}`); process.exit(2); }
if (days === undefined) console.error('Note: no --days given, so this token NEVER expires. Production tokens should have an expiry (for example --days 90) and be rotated.');

const { token, record } = newToken(id, workspace, { ...(scopes ? { scopes: scopes as Scope[] } : {}), ...(days ? { days } : {}) });
if (write) {
  const list = load();
  if (list.some((t) => t.id === id)) { console.error(`A token "${id}" already exists in ${file}. Nothing was written (choose another id, or revoke the old one first).`); process.exit(1); }
  save([...list, record]);
}
console.log('Token (shown once, give it to n8n; it is NOT stored anywhere):\n');
console.log(`  ${token}\n`);
if (write) console.log(`The entry (hash only) was added to ${file}. Restart FLOW HQ so it loads it.`);
else { console.log('Add this entry to config/booking-tokens.json (a JSON array), then restart FLOW HQ:\n'); console.log(JSON.stringify(record, null, 2)); }
