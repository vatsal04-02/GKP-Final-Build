// Helpers for the production hardening steps. Every edit is ANCHORED: a step states what it expects to find ("this text exactly once"),
// and if the workflow does not match (a node edited in n8n, a step applied twice, a different export), it stops and writes nothing.
const crypto = require('crypto');

class Ctx {
  constructor(wf) {
    this.wf = wf;
    this.changes = [];
  }

  // ------------------------------------------------------------------ lookup
  get nodes() { return this.wf.nodes; }
  has(name) { return this.wf.nodes.some((n) => n.name === name); }
  node(name) {
    const n = this.wf.nodes.find((x) => x.name === name);
    if (!n) throw new Error(`node "${name}" is missing (is this the expected export?)`);
    return n;
  }
  like(type) { const n = this.wf.nodes.find((x) => x.type === type); if (!n) throw new Error(`no node of type ${type} to copy the typeVersion from`); return n; }
  uuid(seed) {
    const h = crypto.createHash('sha1').update(`production:${seed}`).digest('hex');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
  }
  log(step, msg) { this.changes.push({ step, change: msg }); }

  // ------------------------------------------------------------------ nodes
  add(spec) {
    if (this.has(spec.name)) throw new Error(`a node called "${spec.name}" already exists (step applied twice?)`);
    const node = { parameters: spec.parameters || {}, name: spec.name, type: spec.type, typeVersion: spec.typeVersion, position: spec.position, id: this.uuid(spec.name) };
    for (const k of ['credentials', 'onError', 'retryOnFail', 'maxTries', 'waitBetweenTries', 'alwaysOutputData', 'executeOnce', 'notes', 'disabled', 'webhookId']) if (spec[k] !== undefined) node[k] = spec[k];
    this.wf.nodes.push(node);
    return node;
  }
  codeNode(name, jsCode, position, extra = {}) {
    return this.add({ name, type: 'n8n-nodes-base.code', typeVersion: this.like('n8n-nodes-base.code').typeVersion, position, parameters: { jsCode }, ...extra });
  }
  // strict boolean IF on one expression (same shape as the existing IF nodes)
  ifNode(name, expression, position) {
    const ref = this.like('n8n-nodes-base.if');
    return this.add({
      name, type: ref.type, typeVersion: ref.typeVersion, position,
      parameters: { conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: ref.parameters.conditions && ref.parameters.conditions.options ? ref.parameters.conditions.options.version : 2 }, conditions: [{ id: this.uuid(`cond:${name}`), leftValue: expression, rightValue: '', operator: { type: 'boolean', operation: 'true', singleValue: true } }], combinator: 'and' }, options: {} },
    });
  }
  setNode(name, assignments, position, includeOtherFields = false) {
    const ref = this.like('n8n-nodes-base.set');
    return this.add({
      name, type: ref.type, typeVersion: ref.typeVersion, position,
      parameters: { assignments: { assignments: assignments.map(([k, v, t]) => ({ id: this.uuid(`${name}:${k}`), name: k, value: v, type: t || 'string' })) }, includeOtherFields, options: {} },
    });
  }
  // Grist HTTP call with the production credential; continues with an { error } item instead of failing the run
  httpGrist(name, method, url, position, extra = {}, { continueOnError = true } = {}) {
    const ref = this.like('n8n-nodes-base.httpRequest');
    return this.add({
      name, type: ref.type, typeVersion: ref.typeVersion, position, ...(continueOnError ? { onError: 'continueRegularOutput' } : {}),
      credentials: { httpHeaderAuth: { id: 'FhqCredGrist0001', name: 'FlowHQ Grist API' } },
      parameters: { ...(method === 'GET' ? {} : { method }), url, authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth', ...extra, options: {} },
    });
  }
  removeNode(name) {
    this.node(name);
    this.wf.nodes = this.wf.nodes.filter((n) => n.name !== name);
    delete this.wf.connections[name];
    for (const v of Object.values(this.wf.connections)) v.main = (v.main || []).map((out) => (out || []).filter((t) => t.node !== name));
  }
  pos(refName, dx, dy) { const [x, y] = this.node(refName).position; return [x + dx, y + dy]; }

  // ------------------------------------------------------------------ Set-node values
  assignment(nodeName, key) {
    const a = (((this.node(nodeName).parameters || {}).assignments || {}).assignments || []).find((x) => x.name === key);
    return a;
  }
  setValue(nodeName, key, value, type) {
    const n = this.node(nodeName);
    const list = n.parameters.assignments.assignments;
    const a = list.find((x) => x.name === key);
    if (a) { a.value = value; if (type) a.type = type; } else list.push({ id: this.uuid(`${nodeName}:${key}`), name: key, value, type: type || 'string' });
  }

  // ------------------------------------------------------------------ connections
  outputs(from) { return ((this.wf.connections[from] || {}).main || []).map((o) => (o || []).map((t) => t.node)); }
  setOutputs(from, outs) {
    this.node(from);
    this.wf.connections[from] = { main: outs.map((l) => (l || []).map((to) => { this.node(to); return { node: to, type: 'main', index: 0 }; })) };
  }
  addOutput(from, index, to) {
    this.node(from); this.node(to);
    const c = this.wf.connections[from] || (this.wf.connections[from] = { main: [] });
    while (c.main.length <= index) c.main.push([]);
    c.main[index] = c.main[index] || [];
    if (!c.main[index].some((t) => t.node === to)) c.main[index].push({ node: to, type: 'main', index: 0 });
  }
  // from[index] used to go to X; now from[index] -> inserted -> X (every target X)
  insertAfter(from, index, inserted, insertedOutIndex = 0) {
    const outs = this.outputs(from);
    const targets = outs[index];
    if (!targets || !targets.length) throw new Error(`"${from}" output ${index} has no connection to insert after`);
    const c = this.wf.connections[from];
    c.main[index] = [{ node: inserted, type: 'main', index: 0 }];
    const ic = this.wf.connections[inserted] || (this.wf.connections[inserted] = { main: [] });
    while (ic.main.length <= insertedOutIndex) ic.main.push([]);
    ic.main[insertedOutIndex] = targets.map((t) => ({ node: t, type: 'main', index: 0 }));
  }

  // ------------------------------------------------------------------ anchored code edits
  // edits: [{ find: string, replace: string, times?: number }] ; every `find` must occur exactly `times` (default 1) in the node's jsCode.
  editCode(name, edits) {
    const n = this.node(name);
    let code = n.parameters.jsCode;
    if (typeof code !== 'string') throw new Error(`"${name}" is not a Code node`);
    for (const e of edits) {
      const times = e.times === undefined ? 1 : e.times;
      const count = code.split(e.find).length - 1;
      if (count !== times) throw new Error(`"${name}": expected ${times} occurrence(s) of the anchor but found ${count}: ${JSON.stringify(e.find.slice(0, 90))}`);
      code = code.split(e.find).join(e.replace);
    }
    n.parameters.jsCode = code;
  }
}

module.exports = { Ctx };
