// Reads the Meta WhatsApp Cloud API webhook body (entry[].changes[].value) and returns ONE envelope item:
//   kind 'message' = at least one inbound patient message (in events[]) | 'status' = delivery receipts only |
//   'ignored' = Meta-shaped but nothing to store | 'invalid' = not a Meta webhook body at all.
// It never throws. headers / query / params are dropped here so they do not travel through the rest of the workflow.
const raw = $json.body;
const source = $json.__w2_source === 'manual' ? 'manual' : 'webhook';   // only the manual-test node can set this (it is a top-level key, not part of the body)
const cfg = {};
for (const [k, v] of Object.entries($json)) {
  if (['headers', 'params', 'query', 'body', 'webhookUrl', 'executionMode'].includes(k) || k.startsWith('__w2')) continue;
  cfg[k] = v;                                                              // Config values (and test_case / test_expect for the manual test)
}
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const noControl = (v) => String(v === null || v === undefined ? '' : v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
const line = (v, max) => noControl(v).replace(/\s+/g, ' ').trim().slice(0, max);
const text = (v, max) => noControl(v).trim().slice(0, max);               // keeps line breaks
const nowSec = Math.floor(Date.now() / 1000);
const MAX_EVENTS = 100;

const events = [];
const rejected = [];
let statuses = 0;

const done = (kind, extra) => ({
  json: {
    ...cfg, source, kind, events, rejected, statuses_seen: statuses,
    http_status: kind === 'invalid' ? 400 : 200,
    response_body: JSON.stringify(kind === 'invalid' ? { status: 'invalid', error: extra } : { status: kind === 'message' ? 'received' : kind }),
    reject_reason: kind === 'invalid' ? extra : rejected.join('; '),
  },
});

if (!isObj(raw) || !Array.isArray(raw.entry)) return done('invalid', 'body is not a Meta webhook payload (entry[] is missing)');

for (const entry of raw.entry) {
  if (!isObj(entry) || !Array.isArray(entry.changes)) continue;
  for (const change of entry.changes) {
    const v = isObj(change) ? change.value : null;
    if (!isObj(v)) continue;
    if (Array.isArray(v.statuses)) statuses += v.statuses.length;
    if (!Array.isArray(v.messages) || !v.messages.length) continue;       // delivery receipts, template updates, ...: not patient messages
    const pid = isObj(v.metadata) ? line(v.metadata.phone_number_id, 40) : '';
    const contacts = Array.isArray(v.contacts) ? v.contacts.filter(isObj) : [];
    for (const m of v.messages) {
      if (events.length >= MAX_EVENTS) { rejected.push(`more than ${MAX_EVENTS} messages in one payload: the rest were ignored`); break; }
      if (!isObj(m)) { rejected.push('a message entry is not an object'); continue; }
      const id = line(m.id, 200);
      const from = line(m.from, 30);
      const problems = [];
      if (!pid) problems.push('missing metadata.phone_number_id');
      if (!id) problems.push('missing message id');
      if (!from) problems.push('missing sender phone');
      if (problems.length) { rejected.push(problems.join(', ')); continue; }

      const type = line(m.type, 30).toLowerCase() || 'unknown';
      const part = isObj(m[type]) ? m[type] : {};
      let label = '';                                                       // what the patient actually wrote, when there is text
      if (type === 'text') label = text(part.body, 2000);
      else if (type === 'button') label = text(part.text || part.payload, 2000);
      else if (type === 'interactive' && isObj(m.interactive)) {
        const reply = isObj(m.interactive.button_reply) ? m.interactive.button_reply : (isObj(m.interactive.list_reply) ? m.interactive.list_reply : {});
        label = text(reply.title, 2000);
      }
      const caption = type === 'text' ? '' : text(part.caption, 500);
      const body_text = label || `[WhatsApp ${type} received]${caption ? `: ${caption}` : ''}`;

      const ts = Number(m.timestamp);
      const contact = contacts.find((c) => String(c.wa_id || '') === from) || (contacts.length === 1 ? contacts[0] : null);
      events.push({
        phone_number_id: pid,
        from,
        sender_name: contact && isObj(contact.profile) ? line(contact.profile.name, 100) : '',
        wa_message_id: id,
        msg_timestamp: Number.isFinite(ts) && ts > 0 ? Math.floor(ts) : nowSec,
        msg_type: type,
        body_text,
        enquiry_text: label.slice(0, 1000),
      });
    }
  }
}

if (events.length) return done('message');
if (rejected.length) return done('ignored');
return done(statuses ? 'status' : 'ignored');
