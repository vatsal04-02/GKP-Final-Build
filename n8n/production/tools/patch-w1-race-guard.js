#!/usr/bin/env node
// Closes the one gap the website path showed: two enquiries for the SAME phone that arrive at the same moment (two tabs, two devices) can each
// create a lead, because W1 looks for the phone first and creates afterwards. (Measured in real n8n: 7 of 60 simultaneous pairs, see TEST_PLAN.md.)
//
//   node tools/patch-w1-race-guard.js <workflow.json> <output.json>
//
// After "W1 - Create lead" the run now reads the leads with that phone again (the same idea as W2's "Recheck Lead"). If a row older than the
// one it just created exists, this run LOST the race: it deletes only its own just-created row (by the row id Grist returned for it), answers
// 200 "duplicate" and writes a Run_Log line; the older lead goes on and sends the only staff alert. If the re-read or the delete fails, nothing
// breaks: the run carries on as before and the log says which row is the extra one.
//
// Added: 6 nodes. Changed: ONLY the connection that leaves "W1 - Create lead". Every other node, id, credential and URL is copied as it is;
// the new HTTP nodes reuse the credential reference of "W1 - Find lead by phone" in the export you give it (nothing is renamed or invented).
'use strict';
const fs = require('fs');
const crypto = require('crypto');

const N = {
  create: 'W1 – Create lead', build: 'W1 – Build new lead', find: 'W1 – Find lead by phone', respondCreated: 'W1 – Respond Created', respondDup: 'W1 – Respond Duplicate',
  exists: 'W1 – Lead exists?', logSkipped: 'W1 – Log skipped',
  recheck: 'W1 – Recheck lead', guard: 'W1 – Race guard', race: 'W1 – Race?', respondRace: 'W1 – Respond Duplicate (race)', remove: 'W1 – Remove duplicate row', raceLog: 'W1 – Race log',
};
const uuid = (seed) => { const h = crypto.createHash('sha1').update(`website-integration:${seed}`).digest('hex'); return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`; };
const clone = (o) => JSON.parse(JSON.stringify(o));

const GUARD = `// Race guard (website integration). Two enquiries for the same phone can arrive at the same moment (two executions) and both create a lead.
// After creating, read the leads with this phone again: the LOWEST row id is the lead. If our row is not it, another run got there first.
const ctx = $('${N.build}').first().json;
const made = $('${N.create}').first().json;
const madeId = made && Array.isArray(made.records) && made.records[0] ? Number(made.records[0].id) : 0;
const rows = (Array.isArray($json.records) ? $json.records : []).filter((r) => r && Number.isInteger(r.id) && r.fields).sort((a, b) => a.id - b.id);
const canon = rows[0] || null;                                   // null when the re-read failed: carry on exactly as before
const race = !!canon && madeId > 0 && canon.id !== madeId;
return [{ json: { ...ctx, race, made_row_id: madeId, kept_row_id: canon ? canon.id : madeId, skip_reason: race ? 'parallel submission: lead row ' + canon.id + ' was created first and is kept' : '' } }];
`;
const RACE_LOG = `// What the race branch tells staff: which row was kept and whether the extra row could be removed.
const g = $('${N.guard}').first().json;
const removed = !($json && $json.error);   // Grist answers a delete with null: only an error item means it failed
return [{ json: { ...g, skip_reason: g.skip_reason + (removed ? '; the duplicate row ' + g.made_row_id + ' was removed' : '; the duplicate row ' + g.made_row_id + ' could NOT be removed automatically: please delete it in Grist') } }];
`;

function patch(wf) {
  const out = clone(wf);
  const by = (n) => out.nodes.find((x) => x.name === n);
  for (const n of [N.create, N.build, N.find, N.respondCreated, N.respondDup, N.exists, N.logSkipped]) if (!by(n)) throw new Error(`node "${n}" not found: is this the integrated FlowHQ workflow?`);
  for (const n of [N.recheck, N.guard, N.race, N.respondRace, N.remove, N.raceLog]) if (by(n)) throw new Error(`"${n}" already exists: the patch was applied before (nothing written)`);
  const conn = out.connections;
  const now = JSON.stringify((conn[N.create] || {}).main);
  if (now !== JSON.stringify([[{ node: N.respondCreated, type: 'main', index: 0 }]])) throw new Error(`"${N.create}" is not connected only to "${N.respondCreated}": ${now} (the workflow was edited): nothing written`);

  const find = by(N.find); const create = by(N.create); const exists = by(N.exists); const respondDup = by(N.respondDup); const build = by(N.build);
  const [x, y] = create.position;
  const buildRef = `$('${N.build}').first().json`;
  const mk = (tpl, name, position, params, extra = {}) => ({ ...clone(tpl), parameters: params, name, id: uuid(name), position, ...extra });

  // 1) re-read the leads with this phone (same node type and credential reference as "W1 - Find lead by phone")
  const recheck = mk(find, N.recheck, [x + 336, y], {
    url: `={{ ${buildRef}.grist_base_url }}/api/docs/{{ ${buildRef}.doc_id }}/tables/LEADS/records`,
    authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth', sendQuery: true,
    queryParameters: { parameters: [{ name: 'filter', value: `={{ JSON.stringify({ Phone: [${buildRef}.phone] }) }}` }, { name: 'limit', value: '5' }] }, options: {},
  }, { onError: 'continueRegularOutput' });
  // 2) decide
  const guard = { parameters: { jsCode: GUARD }, name: N.guard, type: build.type, typeVersion: build.typeVersion, position: [x + 560, y], id: uuid(N.guard) };
  // 3) race? (same IF node shape as "W1 - Lead exists?")
  const cond = clone(exists.parameters);
  if (!cond.conditions || !cond.conditions.conditions || cond.conditions.conditions.length !== 1) throw new Error('unexpected shape of "W1 – Lead exists?"');
  cond.conditions.conditions[0].leftValue = '={{ $json.race === true }}';
  cond.conditions.conditions[0].id = uuid(`${N.race}-cond`);
  const raceIf = { parameters: cond, name: N.race, type: exists.type, typeVersion: exists.typeVersion, position: [x + 784, y], id: uuid(N.race) };
  // 4) race branch: answer "duplicate", remove our own row, say so in the log (a copy of the existing respond node, so the log branch of the old one is untouched)
  const respondRace = mk(respondDup, N.respondRace, [x + 1008, y + 120], clone(respondDup.parameters));
  const remove = mk(find, N.remove, [x + 1232, y + 120], {
    method: 'POST',
    url: `={{ ${buildRef}.grist_base_url }}/api/docs/{{ ${buildRef}.doc_id }}/tables/LEADS/data/delete`,
    authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth', sendBody: true, specifyBody: 'json',
    jsonBody: `={{ JSON.stringify([$('${N.guard}').first().json.made_row_id]) }}`, options: {},
  }, { onError: 'continueRegularOutput' });
  const raceLog = { parameters: { jsCode: RACE_LOG }, name: N.raceLog, type: build.type, typeVersion: build.typeVersion, position: [x + 1456, y + 120], id: uuid(N.raceLog) };

  out.nodes.push(recheck, guard, raceIf, respondRace, remove, raceLog);
  const link = (from, to, idx = 0) => { const c = conn[from] || (conn[from] = { main: [] }); while (c.main.length <= idx) c.main.push([]); c.main[idx].push({ node: to, type: 'main', index: 0 }); };
  conn[N.create] = { main: [[{ node: N.recheck, type: 'main', index: 0 }]] };
  link(N.recheck, N.guard); link(N.guard, N.race);
  link(N.race, N.respondRace, 0);        // true: we lost the race
  link(N.race, N.respondCreated, 1);     // false: carry on exactly as before
  link(N.respondRace, N.remove); link(N.remove, N.raceLog); link(N.raceLog, N.logSkipped);

  // proof that nothing else moved
  const added = new Set([N.recheck, N.guard, N.race, N.respondRace, N.remove, N.raceLog]);
  const changed = out.nodes.filter((n) => !added.has(n.name)).filter((n) => JSON.stringify(n) !== JSON.stringify(wf.nodes.find((o) => o.name === n.name))).map((n) => n.name);
  if (changed.length) throw new Error(`existing nodes changed: ${changed.join(', ')}`);
  const connChanged = Object.keys(conn).filter((k) => JSON.stringify(conn[k]) !== JSON.stringify(wf.connections[k]));
  const expect = [N.create, N.recheck, N.guard, N.race, N.respondRace, N.remove, N.raceLog].sort();
  if (JSON.stringify(connChanged.sort()) !== JSON.stringify(expect)) throw new Error(`unexpected connection changes: ${connChanged}`);
  for (const k of Object.keys(wf)) if (k !== 'nodes' && k !== 'connections' && JSON.stringify(out[k]) !== JSON.stringify(wf[k])) throw new Error(`workflow field "${k}" changed`);
  return out;
}

// the export before the patch (used by the tests to show what the guard changes)
function unpatch(wf) {
  const out = clone(wf);
  const names = new Set([N.recheck, N.guard, N.race, N.respondRace, N.remove, N.raceLog]);
  out.nodes = out.nodes.filter((n) => !names.has(n.name));
  for (const k of names) delete out.connections[k];
  out.connections[N.create] = { main: [[{ node: N.respondCreated, type: 'main', index: 0 }]] };
  return out;
}

module.exports = { patch, unpatch, N, __unpatched: unpatch };

if (require.main === module) {
  const [inFile, outFile] = process.argv.slice(2);
  if (!inFile || !outFile) { console.error('usage: node tools/patch-w1-race-guard.js <workflow.json> <output.json>'); process.exit(2); }
  if (require('path').resolve(inFile) === require('path').resolve(outFile)) { console.error('refusing to overwrite the input file'); process.exit(2); }
  const wf = JSON.parse(fs.readFileSync(inFile, 'utf8'));
  const out = patch(wf);
  fs.writeFileSync(outFile, `${JSON.stringify(out, null, 2)}\n`, { mode: 0o600 });
  console.log(`written ${outFile}: 6 nodes added (${wf.nodes.length} -> ${out.nodes.length}), 0 existing nodes changed, credentials unchanged`);
}
