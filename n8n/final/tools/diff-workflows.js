#!/usr/bin/env node
// Compares two n8n workflow exports node by node (for example the SANITIZED export of what is deployed against a repo candidate). Read-only: it only reads the two files.
//
//   node n8n/final/tools/diff-workflows.js <deployed.sanitized.json> <candidate.json> [--json] [--code]
//
// Reports, by node name: nodes only in one file, nodes whose parameters / credentials / type / version differ (and how: code, URL, other), connections that
// differ, and the credential NAMES each file uses. It never prints a credential value (exports carry none) and, unless --code is given, never prints code: only
// how many lines differ. Exit code 0 = compared (differences are not an error), 2 = bad input. Nothing here activates, imports or edits a workflow (decision D5).
// Both files must already be sanitized (n8n/final/tools/sanitize-export.js): the tool REFUSES a file that still contains a token-like value or an active flag.
'use strict';
const fs = require('fs');

const SECRET_LIKE = [/\bEAA[A-Za-z0-9]{20,}\b/, /\bsk-[A-Za-z0-9_-]{20,}\b/, /\bBearer\s+[A-Za-z0-9._-]{20,}/, /xox[bap]-[A-Za-z0-9-]{10,}/, /"apiKey"\s*:\s*"[^"]{8,}"/i, /"password"\s*:\s*"[^"]{4,}"/i, /"accessToken"\s*:\s*"[^"]{8,}"/i];
const sha = (s) => require('crypto').createHash('sha1').update(s).digest('hex').slice(0, 10);
const norm = (s) => String(s).replace(/\r\n/g, '\n');

function load(file) {
  const raw = fs.readFileSync(file, 'utf8');
  for (const re of SECRET_LIKE) if (re.test(raw)) throw new Error(`${file}: contains a value that looks like a secret (${re}); sanitize the export first (n8n/final/tools/sanitize-export.js)`);
  const wf = JSON.parse(raw);
  if (wf.active === true) throw new Error(`${file}: active is true; an export is sanitized with active=false (n8n/final/tools/sanitize-export.js)`);
  if (!Array.isArray(wf.nodes) || !wf.connections) throw new Error(`${file}: not an n8n workflow export`);
  return wf;
}

function nodeKey(n) { const p = { ...(n.parameters || {}) }; delete p.jsCode; return JSON.stringify({ type: n.type, v: n.typeVersion, p, c: n.credentials ? Object.fromEntries(Object.entries(n.credentials).map(([k, v]) => [k, v && v.name])) : null, onError: n.onError || null, disabled: n.disabled === true }); }
const codeOf = (n) => (n.parameters && typeof n.parameters.jsCode === 'string' ? norm(n.parameters.jsCode) : null);

function lineDiff(a, b) {
  const A = a.split('\n'); const B = b.split('\n');
  const setA = new Map(); for (const l of A) setA.set(l, (setA.get(l) || 0) + 1);
  let common = 0; for (const l of B) { const c = setA.get(l) || 0; if (c > 0) { common++; setA.set(l, c - 1); } }
  return { removed: A.length - common, added: B.length - common };
}

function compare(a, b, o = {}) {
  const A = new Map(a.nodes.map((n) => [n.name, n])); const B = new Map(b.nodes.map((n) => [n.name, n]));
  const onlyA = [...A.keys()].filter((k) => !B.has(k)).sort();
  const onlyB = [...B.keys()].filter((k) => !A.has(k)).sort();
  const changed = [];
  for (const [name, na] of A) {
    const nb = B.get(name); if (!nb) continue;
    const why = [];
    const ca = codeOf(na); const cb = codeOf(nb);
    let code = null;
    if (ca !== cb) { why.push('code'); const d = lineDiff(ca || '', cb || ''); code = { ...d, hashA: sha(ca || ''), hashB: sha(cb || '') }; if (o.code) code.a = ca, code.b = cb; }
    if (nodeKey(na) !== nodeKey(nb)) {
      const pa = JSON.parse(nodeKey(na)); const pb = JSON.parse(nodeKey(nb));
      for (const k of ['type', 'v', 'c', 'onError', 'disabled']) if (JSON.stringify(pa[k]) !== JSON.stringify(pb[k])) why.push(k === 'c' ? 'credentials' : k === 'v' ? 'typeVersion' : k);
      if (JSON.stringify(pa.p) !== JSON.stringify(pb.p)) why.push('parameters');
    }
    if (why.length) changed.push({ name, why, code });
  }
  const edges = (wf) => { const e = new Set(); for (const [from, v] of Object.entries(wf.connections)) (v.main || []).forEach((outs, i) => (outs || []).forEach((c) => e.add(`${from}#${i} -> ${c.node}`))); return e; };
  const EA = edges(a); const EB = edges(b);
  const creds = (wf) => [...new Set(wf.nodes.flatMap((n) => Object.values(n.credentials || {}).map((c) => c && c.name).filter(Boolean)))].sort();
  return {
    nodes: { deployed: a.nodes.length, candidate: b.nodes.length },
    onlyInDeployed: onlyA, onlyInCandidate: onlyB, changed,
    connectionsOnlyInDeployed: [...EA].filter((e) => !EB.has(e)).sort(), connectionsOnlyInCandidate: [...EB].filter((e) => !EA.has(e)).sort(),
    credentialNames: { deployed: creds(a), candidate: creds(b) },
    identical: !onlyA.length && !onlyB.length && !changed.length && [...EA].every((e) => EB.has(e)) && [...EB].every((e) => EA.has(e)),
  };
}

module.exports = { load, compare };

if (require.main === module) {
  const args = process.argv.slice(2);
  const files = args.filter((x) => !x.startsWith('--'));
  if (files.length !== 2) { console.error('usage: node n8n/final/tools/diff-workflows.js <deployed.sanitized.json> <candidate.json> [--json] [--code]'); process.exit(2); }
  let r;
  try { r = compare(load(files[0]), load(files[1]), { code: args.includes('--code') }); } catch (e) { console.error(`REFUSED: ${e.message}`); process.exit(2); }
  if (args.includes('--json')) { console.log(JSON.stringify(r, null, 2)); process.exit(0); }
  console.log(`nodes: deployed ${r.nodes.deployed}, candidate ${r.nodes.candidate} -> ${r.identical ? 'IDENTICAL' : 'DIFFERENT'}`);
  console.log(`only in deployed (${r.onlyInDeployed.length}): ${r.onlyInDeployed.join(' | ') || '-'}`);
  console.log(`only in candidate (${r.onlyInCandidate.length}): ${r.onlyInCandidate.join(' | ') || '-'}`);
  console.log(`changed (${r.changed.length}):`);
  for (const c of r.changed) console.log(`  ${c.name}: ${c.why.join(', ')}${c.code ? ` (code: -${c.code.removed} +${c.code.added} lines)` : ''}`);
  console.log(`connections only in deployed (${r.connectionsOnlyInDeployed.length}), only in candidate (${r.connectionsOnlyInCandidate.length})`);
  console.log(`credential names: deployed [${r.credentialNames.deployed.join(', ')}] / candidate [${r.credentialNames.candidate.join(', ')}]`);
}
