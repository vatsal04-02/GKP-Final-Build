#!/usr/bin/env node
// Which credential does each node use, and what is that node FOR? Classifies by what the node calls (not by the credential's name) and reports every
// credential that serves more than one role. It reads the export only: it never sees a credential value and changes nothing.
//
//   node n8n/final/tools/audit-credentials.js <workflow.json> [--json] [--check]
//   --check  exit code 1 when any credential serves more than one role (what the tests and the pre-import checklist use)
'use strict';
const fs = require('fs');

const roleOf = (n) => {
  const p = n.parameters || {};
  const url = String(p.url || '');
  if (n.type === 'n8n-nodes-base.webhook') return p.authentication === 'headerAuth' ? 'webhook-auth (website enquiries / Cal.com)' : null;
  if (n.type === 'n8n-nodes-base.emailSend') return 'smtp';
  if (n.type === 'n8n-nodes-base.telegram') return 'telegram';
  if (n.type !== 'n8n-nodes-base.httpRequest') return null;
  if (/\/api\/booking\//.test(url) || /^W13 [–-] Booking (availability|API)$/.test(n.name || '')) return 'booking-api';   // Slice 4C: W13 calls the FLOW HQ booking API (its URL is built in a Code node, so the node name is the reliable signal)
  if (/\/api\/docs\//.test(url)) return 'grist';
  if (/chat\/completions|ai_base_url|openrouter/i.test(url)) return 'ai-provider';
  if (/graph|WA_GRAPH|graph_api|w12_graph/i.test(url) || /\/messages$/.test(url) || /Meta send/i.test(n.name)) return 'whatsapp-meta';
  return 'other-http';
};

function audit(wf) {
  const rows = [];
  for (const n of wf.nodes) {
    const creds = n.credentials ? Object.entries(n.credentials) : [];
    if (!creds.length) continue;
    const role = roleOf(n) || 'other';
    for (const [type, c] of creds) rows.push({ node: n.name, role, credentialType: type, credentialId: c.id, credentialName: c.name });
  }
  const byCred = new Map();
  for (const r of rows) {
    const k = `${r.credentialType}|${r.credentialId}|${r.credentialName}`;
    const e = byCred.get(k) || { credentialType: r.credentialType, credentialId: r.credentialId, credentialName: r.credentialName, roles: {} };
    (e.roles[r.role] = e.roles[r.role] || []).push(r.node);
    byCred.set(k, e);
  }
  const credentials = [...byCred.values()].map((c) => ({ ...c, shared: Object.keys(c.roles).length > 1 }));
  return { nodes: rows.length, credentials, rows };
}

module.exports = { audit, roleOf };

if (require.main === module) {
  const [file] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  if (!file) { console.error('usage: node audit-credentials.js <workflow.json> [--json]'); process.exit(2); }
  const res = audit(JSON.parse(fs.readFileSync(file, 'utf8')));
  if (process.argv.includes('--json')) { console.log(JSON.stringify(res, null, 2)); process.exit(process.argv.includes('--check') && res.credentials.some((c) => c.shared) ? 1 : 0); }
  console.log(`${res.nodes} credential references\n`);
  for (const c of res.credentials) {
    console.log(`${c.credentialType} "${c.credentialName}" (id ${c.credentialId})${c.shared ? '   <-- USED FOR MORE THAN ONE ROLE' : ''}`);
    for (const [role, nodes] of Object.entries(c.roles)) console.log(`    ${role}: ${nodes.length} node(s)${nodes.length <= 12 ? ` - ${nodes.join(', ')}` : ''}`);
  }
  if (process.argv.includes('--check')) { const bad = res.credentials.filter((c) => c.shared); console.log(bad.length ? `\nFAIL: ${bad.length} credential(s) serve more than one role` : '\nOK: every credential serves exactly one role'); process.exit(bad.length ? 1 : 0); }
}
