// Tiny n8n executor for the node types these workflows use, plus an in-memory fake Grist.
// Purpose: run the SHIPPED workflow JSON end to end (wiring, expressions, branches, data flow).
// Not n8n: no pairedItem resolution (".item" = same index), no retries. Credentials: Meta (graph.facebook.com) must use
// "WhatsApp Cloud API" and nothing else may, so a credential mix-up fails the test. opts.meta fakes the Meta API.
// Execute Workflow: a call to the workflow itself (opts.workflowId, e.g. via {{ $workflow.id }}) or to another workflow listed in
// opts.workflows ({ id: workflow JSON }); it runs from that workflow's Execute Workflow Trigger like n8n does, one sub-run per
// item in "each" mode (result.subRuns). "Wait for sub-workflow" off: the sub-run still happens (synchronously here), its
// errors do not reach the caller, and the node passes its input items on. Unknown workflow id = error (n8n: workflow not found).
// Claude: https://api.anthropic.com/ must use the "Anthropic API" credential and nothing else may; opts.anthropic fakes it.
// OpenRouter (W13 demo): https://openrouter.ai/ must use the "OpenRouter API" credential and nothing else may; opts.openrouter fakes it.
// Also: Respond to Webhook (recorded in result.responses, items pass through), Loop Over Items (splitInBatches v3: output 0 =
// done, output 1 = loop; per-run state), and HTTP "continue (using error output)" = a second output with the error items.
const COLUMNS = {
  Leads: ['Lead_ID', 'Created_At', 'Name', 'Phone', 'Source', 'Page_URL', 'UTM_Campaign', 'Enquiry', 'AI_Summary', 'Likely_Service', 'Status', 'Owner', 'Next_Action_At', 'First_Response_At', 'Lost_Reason', 'Opted_Out', 'Escalated', 'Followup_Sent', 'Notes', 'Lead_Stage'],
  Appointments: ['Booking_UID', 'Lead', 'Service', 'Physio', 'Start', 'End', 'Status', 'Fee_INR', 'R24_Sent', 'R2_Sent', 'Rebook_Sent', 'Review_Sent', 'Outcome_Sent'],
  Run_Log: ['Workflow', 'Record', 'Outcome', 'Error', 'At'],
  Clinics: ['Clinic_Slug', 'Clinic_Name', 'Grist_Doc_ID', 'WA_Phone_Number_ID', 'Active'],
  Settings: ['Key', 'Value'],
  Conversations: ['Lead', 'Phone', 'Last_Inbound_At', 'Unread', 'Automation_Paused', 'Assigned_To', 'Needs_Human', 'Handoff_Reason', 'Last_Intent'],
  Messages: ['Conversation', 'Direction', 'Body', 'Template', 'Sent_By', 'WA_Message_ID', 'Status', 'Send', 'Created_At', 'Intent', 'AI_Action', 'AI_Confidence', 'AI_Status', 'Needs_Human', 'AI_Reply', 'AI_Reason'],
  Knowledge: ['Title', 'Category', 'Content', 'Active'],
};
const CHOICES = {
  'Leads.Source': ['Website', 'WhatsApp', 'Instagram', 'Call', 'Walk-in', 'Referral'],
  'Leads.Status': ['New', 'Contacted', 'Booked', 'Converted', 'Lost'],
  'Leads.Lost_Reason': ['No response', 'Price', 'Distance', 'Went elsewhere', 'Not a fit', 'Other'],
  'Appointments.Status': ['Booked', 'Rescheduled', 'Cancelled', 'Completed', 'No-show'],
  'Run_Log.Outcome': ['ok', 'skipped', 'failed'],
  'Messages.Direction': ['In', 'Out'],
  'Messages.Status': ['queued', 'needs_template', 'sent', 'delivered', 'read', 'failed'],
  'Messages.AI_Status': ['processing', 'replied', 'drafted', 'handed_off', 'no_reply', 'skipped', 'opted_out', 'deferred', 'failed'],
  'Leads.Lead_Stage': ['cold', 'warm', 'hot'],
  'Knowledge.Category': ['services', 'pricing', 'hours', 'location', 'policy', 'faq', 'general'],
};
const DATETIME = new Set(['Leads.Created_At', 'Leads.Next_Action_At', 'Leads.First_Response_At', 'Appointments.Start', 'Appointments.End', 'Appointments.R24_Sent', 'Appointments.R2_Sent', 'Appointments.Rebook_Sent', 'Appointments.Review_Sent', 'Appointments.Outcome_Sent', 'Run_Log.At', 'Conversations.Last_Inbound_At', 'Messages.Created_At']);
const TOGGLE = new Set(['Leads.Opted_Out', 'Leads.Escalated', 'Leads.Followup_Sent', 'Clinics.Active', 'Conversations.Automation_Paused', 'Messages.Send',
  'Conversations.Needs_Human', 'Messages.Needs_Human', 'Knowledge.Active']);

class FakeGrist {
  constructor(docs = {}) { this.docs = docs; this.nextId = {}; this.calls = []; }
  table(doc, t) {
    if (!this.docs[doc]) throw new Error(`Grist 404: no such doc ${doc}`);
    this.docs[doc][t] = this.docs[doc][t] || [];
    return this.docs[doc][t];
  }
  validate(t, fields) {
    for (const [k, v] of Object.entries(fields || {})) {
      if (!COLUMNS[t].includes(k)) throw new Error(`Grist 400: invalid column ${t}.${k}`);
      const key = `${t}.${k}`;
      if (CHOICES[key] && v !== '' && !CHOICES[key].includes(v)) throw new Error(`Grist 400: invalid choice "${v}" for ${key}`);
      if (DATETIME.has(key) && !(typeof v === 'number' || v === null)) throw new Error(`Grist 400: ${key} must be epoch seconds, got ${typeof v}`);
      if (TOGGLE.has(key) && typeof v !== 'boolean') throw new Error(`Grist 400: ${key} must be boolean`);
    }
  }
  handle(method, url, query, body) {
    const m = String(url).match(/\/api\/docs\/([^/]+)\/tables\/([^/]+)\/records$/);
    if (!m) throw new Error(`Grist 404: bad url ${url}`);
    const [, doc, t] = m;
    if (!COLUMNS[t]) throw new Error(`Grist 404: no such table ${t}`);
    const rows = this.table(doc, t);
    this.calls.push({ method, doc, table: t, query, body });
    if (method === 'GET') {
      let out = rows.slice();
      if (query.filter) {
        const f = JSON.parse(query.filter);
        for (const [col, vals] of Object.entries(f)) {
          if (!COLUMNS[t].includes(col) && col !== 'id') throw new Error(`Grist 400: filter on unknown column ${col}`);
          out = out.filter((r) => vals.includes(col === 'id' ? r.id : r.fields[col] === undefined ? null : r.fields[col]));
        }
      }
      if (query.sort) {
        const desc = query.sort.startsWith('-');
        const col = query.sort.replace(/^-/, '');
        out.sort((a, b) => ((a.fields[col] || 0) - (b.fields[col] || 0)) * (desc ? -1 : 1));
      }
      if (query.limit) out = out.slice(0, Number(query.limit));
      return { records: JSON.parse(JSON.stringify(out)) };
    }
    if (method === 'POST') {
      const ids = [];
      for (const rec of body.records) {
        this.validate(t, rec.fields);
        const key = `${doc}.${t}`;
        this.nextId[key] = (this.nextId[key] || Math.max(0, ...rows.map((r) => r.id))) + 1;
        rows.push({ id: this.nextId[key], fields: { ...rec.fields } });
        ids.push({ id: this.nextId[key] });
      }
      return { records: ids };
    }
    if (method === 'PATCH') {
      for (const rec of body.records) {
        this.validate(t, rec.fields);
        const row = rows.find((r) => r.id === rec.id);
        if (!row) throw new Error(`Grist 400: no row ${rec.id} in ${t}`);
        Object.assign(row.fields, rec.fields);
      }
      return null;
    }
    throw new Error(`Grist 405: ${method}`);
  }
}

// ---- expressions
const evalExpr = (src, ctx) => new Function('$json', '$', '$itemIndex', '$workflow', `return (${src});`)(ctx.$json, ctx.$, ctx.$itemIndex, ctx.$workflow);
function resolve(val, ctx) {
  if (typeof val === 'string') {
    if (!val.startsWith('=')) return val;
    const s = val.slice(1);
    const whole = s.match(/^\{\{([\s\S]*)\}\}$/);
    if (whole && !/\}\}[\s\S]*\{\{/.test(s)) return evalExpr(whole[1], ctx);
    return s.replace(/\{\{([\s\S]*?)\}\}/g, (_, e) => { const v = evalExpr(e, ctx); return typeof v === 'object' ? JSON.stringify(v) : String(v); });
  }
  if (Array.isArray(val)) return val.map((v) => resolve(v, ctx));
  if (val && typeof val === 'object') return Object.fromEntries(Object.entries(val).map(([k, v]) => [k, resolve(v, ctx)]));
  return val;
}

function simulate(wf, opts) {
  const { start, items, grist, now, staticData = {}, onlyUntil } = opts;
  const realNow = Date.now;
  if (now) Date.now = () => now;
  const byName = Object.fromEntries(wf.nodes.map((n) => [n.name, n]));
  const runData = {};
  const result = { runData, error: null, telegram: [], visited: [], subRuns: [], responses: [] };
  const loops = {};          // splitInBatches state per node: { rest, done }
  let steps = 0;
  const $workflow = { id: opts.workflowId, name: wf.name };
  const queue = [{ name: start, inputs: items }];

  const accessor = (name, idx) => {
    if (!(name in runData)) throw new Error(`Node '${name}' hasn't been executed`);
    const arr = runData[name];
    return { first: () => arr[0], last: () => arr[arr.length - 1], all: () => arr, item: arr[idx] || arr[0], isExecuted: true };
  };

  try {
    while (queue.length) {
      let { name, inputs } = queue.shift();
      if (++steps > 20000) throw new Error('sim: more than 20000 node runs (endless loop?)');
      const node = byName[name];
      result.visited.push(name);
      const p = node.parameters || {};
      if (node.executeOnce) inputs = inputs.slice(0, 1);   // n8n setting "Execute Once": first item only
      let outputs; // array of item arrays, one per output index

      const ctxFor = (item, i) => ({ $json: item ? item.json : undefined, $: (n) => accessor(n, i), $itemIndex: i, $workflow });

      switch (node.type) {
        case 'n8n-nodes-base.webhook':
        case 'n8n-nodes-base.scheduleTrigger':
        case 'n8n-nodes-base.errorTrigger':
        case 'n8n-nodes-base.manualTrigger':
        case 'n8n-nodes-base.executeWorkflowTrigger':
          outputs = [inputs]; break;
        case 'n8n-nodes-base.set': {
          outputs = [inputs.map((it, i) => {
            const base = p.includeOtherFields ? { ...it.json } : {};
            for (const a of p.assignments.assignments) base[a.name] = resolve(a.value, ctxFor(it, i));
            return { json: base };
          })];
          break;
        }
        case 'n8n-nodes-base.code': {
          const staticFn = () => staticData;
          if (p.mode === 'runOnceForAllItems' || p.mode === undefined) {   // n8n's default mode is "all items"
            const $input = { all: () => inputs, first: () => inputs[0] };
            const first = inputs[0] ? inputs[0].json : undefined;           // n8n: $json = the first item here
            const r = new Function('$', '$input', '$json', '$getWorkflowStaticData', p.jsCode)((n) => accessor(n, 0), $input, first, staticFn);
            outputs = [Array.isArray(r) ? r : r ? [r] : []];
          } else {
            outputs = [inputs.map((it, i) => {
              const r = new Function('$json', '$', '$getWorkflowStaticData', p.jsCode)(it.json, (n) => accessor(n, i), staticFn);
              if (!r || !r.json) throw new Error(`Code node ${name} did not return {json}`);
              return r;
            })];
          }
          break;
        }
        case 'n8n-nodes-base.if': {
          const t = [], f = [];
          inputs.forEach((it, i) => {
            const cond = p.conditions.conditions[0];
            const v = resolve(cond.leftValue, ctxFor(it, i));
            if (typeof v !== 'boolean') throw new Error(`IF ${name}: strict boolean expected, got ${typeof v} (${JSON.stringify(v)})`);
            (v ? t : f).push(it);
          });
          outputs = [t, f];
          break;
        }
        case 'n8n-nodes-base.httpRequest': {
          if (!node.credentials || !node.credentials.httpHeaderAuth) throw new Error(`HTTP ${name}: no credential`);
          const credName = node.credentials.httpHeaderAuth.name;
          const resp = ((p.options || {}).response || {}).response || {};
          const continueOnFail = node.onError === 'continueRegularOutput';
          const errorOutput = node.onError === 'continueErrorOutput';   // second output carries the failed items
          const failed = [];
          const okItems = inputs.map((it, i) => {
            try {
              const ctx = ctxFor(it, i);
              const method = resolve(p.method, ctx) || 'GET';
              const url = resolve(p.url, ctx);
              const query = {};
              if (p.sendQuery) for (const q of p.queryParameters.parameters) query[q.name] = resolve(q.value, ctx);
              let body;
              if (p.sendBody) { body = resolve(p.jsonBody, ctx); if (typeof body === 'string') body = JSON.parse(body); }
              if (/^https:\/\/graph\.facebook\.com\//.test(String(url))) {
                if (credName !== 'WhatsApp Cloud API') throw new Error(`HTTP ${name}: Meta called with credential "${credName}"`);
                if (!opts.meta) throw new Error('sim: no fake Meta (opts.meta)');
                const r = opts.meta(method, url, body);   // { status, body } or throws (network error)
                if (r.status >= 400 && !resp.neverError) throw new Error(`Request failed with status code ${r.status}`);
                return { json: resp.fullResponse ? { statusCode: r.status, statusMessage: '', headers: {}, body: r.body } : r.body };
              }
              if (/^https:\/\/openrouter\.ai\//.test(String(url))) {
                if (credName !== 'OpenRouter API') throw new Error(`HTTP ${name}: OpenRouter called with credential "${credName}"`);
                if (!opts.openrouter) throw new Error('sim: no fake OpenRouter (opts.openrouter)');
                const headers = {};
                if (p.sendHeaders) for (const hd of p.headerParameters.parameters) headers[hd.name] = resolve(hd.value, ctx);
                const r = opts.openrouter(method, url, headers, body);   // { status, body } or throws (timeout / network)
                if (r.status >= 400 && !resp.neverError) throw new Error(`Request failed with status code ${r.status}`);
                return { json: r.body };
              }
              if (credName === 'OpenRouter API') throw new Error(`HTTP ${name}: the OpenRouter credential used for ${url}`);
              if (/^https:\/\/api\.anthropic\.com\//.test(String(url))) {
                if (credName !== 'Anthropic API') throw new Error(`HTTP ${name}: Claude called with credential "${credName}"`);
                if (!opts.anthropic) throw new Error('sim: no fake Claude (opts.anthropic)');
                const headers = {};
                if (p.sendHeaders) for (const hd of p.headerParameters.parameters) headers[hd.name] = resolve(hd.value, ctx);
                const r = opts.anthropic(method, url, headers, body);   // { status, body } or throws (timeout / network)
                if (r.status >= 400 && !resp.neverError) throw new Error(`Request failed with status code ${r.status}`);
                return { json: r.body };
              }
              if (credName === 'Anthropic API') throw new Error(`HTTP ${name}: the Anthropic credential used for ${url}`);
              if (credName === 'WhatsApp Cloud API') throw new Error(`HTTP ${name}: Grist called with the WhatsApp credential`);
              return { json: grist.handle(method, url, query, body) };
            } catch (e) {
              if (errorOutput) { failed.push({ json: { error: { message: e.message } } }); return null; }
              if (continueOnFail) return { json: { error: { message: e.message } } };
              throw e;
            }
          }).filter(Boolean);
          outputs = errorOutput ? [okItems, failed] : [okItems];
          break;
        }
        case 'n8n-nodes-base.stopAndError': {
          const ctx = ctxFor(inputs[0], 0);
          throw Object.assign(new Error(resolve(p.errorMessage, ctx)), { stopAndError: true });
        }
        case 'n8n-nodes-base.telegram': {
          outputs = [inputs.map((it, i) => {
            const ctx = ctxFor(it, i);
            result.telegram.push({ chatId: resolve(p.chatId, ctx), text: resolve(p.text, ctx), parse_mode: (p.additionalFields || {}).parse_mode });
            return { json: { ok: true } };
          })];
          break;
        }
        case 'n8n-nodes-base.stickyNote': outputs = [[]]; break;
        case 'n8n-nodes-base.respondToWebhook': {
          inputs.forEach((it, i) => {
            const ctx = ctxFor(it, i);
            const o = p.options || {};
            result.responses.push({
              node: name,
              code: Number(o.responseCode === undefined ? 200 : resolve(o.responseCode, ctx)),
              type: p.respondWith,
              body: p.responseBody === undefined ? '' : resolve(p.responseBody, ctx),
              headers: Object.fromEntries((((o.responseHeaders || {}).entries) || []).map((h) => [h.name, h.value])),
            });
          });
          outputs = [inputs];   // n8n passes the items on; the run continues after the response
          break;
        }
        case 'n8n-nodes-base.splitInBatches': {
          const size = Number(resolve(p.batchSize, ctxFor(inputs[0], 0))) || 1;
          let st = loops[name];
          if (!st) st = loops[name] = { rest: inputs.slice(), done: [] };   // first arrival: all the items
          else st.done.push(...inputs);                                      // loop-back: the finished batch
          if (st.rest.length) outputs = [[], st.rest.splice(0, size)];       // next batch -> output 1 (loop)
          else { outputs = [st.done, []]; delete loops[name]; }              // nothing left -> output 0 (done)
          break;
        }
        case 'n8n-nodes-base.executeWorkflow': {
          const wait = (p.options || {}).waitForSubWorkflow !== false;
          try {
            const id = resolve((p.workflowId || {}).value, ctxFor(inputs[0], 0));
            const target = opts.workflowId && id === opts.workflowId ? wf : (opts.workflows || {})[id];
            if (!target) throw new Error(`Workflow does not exist: "${id}"`);
            const trig = target.nodes.filter((x) => x.type === 'n8n-nodes-base.executeWorkflowTrigger');
            if (trig.length !== 1) throw new Error(`sim: expected one Execute Workflow Trigger, found ${trig.length}`);
            const batches = p.mode === 'each' ? inputs.map((it) => [it]) : [inputs];
            outputs = [[]];
            for (const batch of batches) {
              const sub = simulate(target, { ...opts, workflowId: id, start: trig[0].name, items: batch.map((it) => ({ json: JSON.parse(JSON.stringify(it.json)) })), now: Date.now() });
              sub.workflowId = id;
              sub.waited = wait;
              result.subRuns.push(sub);
              result.telegram.push(...sub.telegram);
              if (!wait) continue;                               // fire and forget: the caller never sees the sub-run
              if (sub.error) throw new Error(`sub-workflow failed at ${sub.error.node}: ${sub.error.message}`);
              const last = sub.visited[sub.visited.length - 1];   // n8n returns the last executed node's output
              outputs[0].push(...(sub.runData[last] || []));
            }
            if (!wait) outputs = [inputs];
          } catch (e) {
            if (node.onError !== 'continueRegularOutput') throw e;
            outputs = [[{ json: { error: { message: e.message } } }]];
          }
          break;
        }
        default: throw new Error(`sim: unsupported node type ${node.type} (${name})`);
      }

      // Loop Over Items: `$('Loop').item` is the batch being processed (output 1), not the (empty) done output
      runData[name] = (node.type === 'n8n-nodes-base.splitInBatches' && outputs[1] && outputs[1].length ? outputs[1] : outputs[0]) || [];
      const conns = (wf.connections[name] || { main: [] }).main;
      outputs.forEach((out, oi) => {
        if (!out || !out.length) return;
        for (const target of conns[oi] || []) queue.push({ name: target.node, inputs: out });
      });
      if (onlyUntil && name === onlyUntil) break;
    }
  } catch (e) {
    const failedAt = result.visited[result.visited.length - 1];
    result.error = { node: failedAt, message: e.message, stopAndError: !!e.stopAndError };
  } finally {
    Date.now = realNow;
  }
  return result;
}

module.exports = { simulate, FakeGrist, COLUMNS, CHOICES, DATETIME, TOGGLE };
