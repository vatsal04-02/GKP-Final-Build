#!/usr/bin/env node
// Makes an n8n workflow export safe to keep in git. It changes ONLY what is listed below and prints each change; everything else is copied byte-for-byte
// (node ids, credential references, URLs, parameters, connections are untouched).
//
//   node n8n/final/tools/sanitize-export.js <export.json> <out.json> [--deny <file>]
//
//   * "active" is set to false      (an export that says active=true must never switch a workflow on by itself)
//   * meta.instanceId is removed    (identifies the n8n installation; n8n creates its own on import)
//   * manual-test fixtures: a real WhatsApp phone_number_id and a real recipient number written in a Code node ("W12 – Test input") are replaced by
//     the fictional values used by the tests (123456789012345 / +919800000019). Edit them again (locally, never in git) before running that manual test.
//   * --deny <file>: one private value per line (phone numbers, ids, secrets). The run FAILS if any of them is still in the output.
'use strict';
const fs = require('fs');
const crypto = require('crypto');

const FICTIONAL_PNID = '123456789012345';
const FICTIONAL_TO = '+919800000019';

function sanitize(raw) {
  const wf = JSON.parse(raw);
  const log = [];
  if (wf.active !== false) { log.push(`active: ${wf.active} -> false`); wf.active = false; }
  if (wf.meta && wf.meta.instanceId) { delete wf.meta.instanceId; log.push('meta.instanceId removed'); }
  for (const n of wf.nodes) {
    const code = n.parameters && n.parameters.jsCode;
    if (typeof code !== 'string') continue;
    let out = code.replace(/(wa_phone_number_id:\s*')(\d{10,20})(')/g, (m, a, v, c) => (v === FICTIONAL_PNID ? m : (log.push(`${n.name}: wa_phone_number_id replaced`), `${a}${FICTIONAL_PNID}${c}`)));
    out = out.replace(/(\bto:\s*')(\+?\d{10,15})(')/g, (m, a, v, c) => (v === FICTIONAL_TO.slice(1) || v === FICTIONAL_TO ? m : (log.push(`${n.name}: recipient number replaced`), `${a}${FICTIONAL_TO}${c}`)));
    n.parameters.jsCode = out;
  }
  return { text: `${JSON.stringify(wf, null, 2)}\n`, log };
}

module.exports = { sanitize, FICTIONAL_PNID, FICTIONAL_TO };

if (require.main === module) {
  const args = process.argv.slice(2);
  const [inFile, outFile] = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--deny');
  const deny = args.includes('--deny') ? fs.readFileSync(args[args.indexOf('--deny') + 1], 'utf8').replace(/\r/g, '').split('\n').map((s) => s.trim()).filter((s) => s.length >= 6) : [];
  if (!inFile || !outFile) { console.error('usage: node sanitize-export.js <export.json> <out.json> [--deny <file>]'); process.exit(2); }
  if (require('path').resolve(inFile) === require('path').resolve(outFile)) { console.error('refusing to overwrite the input'); process.exit(2); }
  const raw = fs.readFileSync(inFile, 'utf8');
  const { text, log } = sanitize(raw);
  const leaked = deny.filter((v) => text.includes(v) || text.includes(v.replace(/^\+?91/, '')));
  if (leaked.length) { console.error(`REFUSED: ${leaked.length} private value(s) from the deny list are still in the output (not printed)`); process.exit(1); }
  fs.writeFileSync(outFile, text);
  console.log(`source sha256 ${crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16)}...`);
  console.log(log.length ? log.map((l) => `  - ${l}`).join('\n') : '  (nothing to change)');
  console.log(`written ${outFile}`);
}
