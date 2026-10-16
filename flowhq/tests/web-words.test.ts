// Guards for the universal web layer: no business words, no backend names, no direct network calls.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const WEB = path.resolve(__dirname, '../src/web');
const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => { const p = path.join(dir, f); return statSync(p).isDirectory() ? files(p) : /\.(tsx?|css)$/.test(f) ? [p] : []; });
const code = (p: string) => readFileSync(p, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');   // comments may explain; code may not say it

describe('src/web stays universal', () => {
  const all = files(WEB);
  // src/web/clinical/ holds the clinic-only screens (patients, prescriptions, invoices): they are the one place industry words are allowed.
  // Everything else stays universal, and the network rule below still applies to every file, clinical ones included.
  const universal = all.filter((p) => !path.relative(WEB, p).startsWith('clinical' + path.sep));
  it('has files to check', () => expect(universal.length).toBeGreaterThan(20));
  it.each(universal.map((p) => [path.relative(WEB, p), p]))('%s: no industry words or backend table names', (_n, p) => {
    const banned = /\b(patients?|physio\w*|doctors?|clinics?|appointments?|treatments?|leads?|medical|review request)\b|cal\.com|grist|n8n|openrouter/i;
    const workflowNumber = /\bW(1[0-3]|[1-9])\b/;   // workflow numbers (W1-W13) are backend references, never UI words
    const hit = code(p).match(banned) || code(p).match(workflowNumber);
    expect(hit ? hit[0] : null).toBeNull();
  });
  it('only lib/api.ts calls the network, and only its own /api', () => {
    for (const p of all) {
      const c = code(p);
      if (path.relative(WEB, p) === path.join('lib', 'api.ts')) { expect(c).toMatch(/fetch\(`\/api\$\{path\}`/); continue; }
      expect(c).not.toMatch(/\bfetch\(|XMLHttpRequest|WebSocket\(|EventSource\(/);
      expect(c).not.toMatch(/anthropic|openai|graph\.facebook|api\/docs\//i);
    }
  });
});
