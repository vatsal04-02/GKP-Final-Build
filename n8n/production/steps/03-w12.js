// STEP 03 - W12, the single WhatsApp sender.
//  * an unconfirmed Meta call ("uncertain") is its own state: sent=false, uncertain=true, and it is NEVER re-sent automatically
//  * central idempotency: a send ledger (Grist table Send_Ledger, one row per idem_key) is claimed BEFORE Meta is called; the lowest row id wins a race;
//    a key that is already in the ledger (sending / accepted / uncertain / delivered ...) is answered "duplicate" and not sent
//  * biz_opaque_callback_data = "fhq:<idem_key>" is sent to Meta so the delivery-status webhook (W2) can find the ledger row even when the send result was lost
//  * Meta's sample template hello_world is refused unless FLOWHQ_WA_ALLOW_HELLO_WORLD=true (smoke tests only)
const GRIST_CRED = { httpHeaderAuth: { id: 'FhqCredGrist0001', name: 'FlowHQ Grist API' } };
const P = "$('W12 – Prepare request').first().json.input";
const LEDGER_URL = `={{ ${P}.grist_base_url }}/api/docs/{{ ${P}.doc_id }}/tables/Send_Ledger/records`;
const IDEM_FN = `
  // PRODUCTION: idempotency key of one logical message. Callers should send idem_key; the fallbacks cover the ones that identify the message by their own id.
  function waIdemKey(input) {
    const clean = (v) => String(v === null || v === undefined ? '' : v).replace(/[^A-Za-z0-9:_.\\-]/g, '').slice(0, 100);
    const explicit = clean(input.idem_key);
    if (explicit) return explicit;
    const src = clean(input.source_workflow) || 'W12';
    const tpl = input.message_type === 'text' ? 'text' : clean(input.template);
    const w13 = input.message_row_id ? \`\${clean(input.w13_kind)}\${clean(input.message_row_id)}\` : '';
    const id = [clean(input.booking_uid), clean(input.inbox_row_id), w13, clean(input.week)].filter(Boolean)[0];
    return id ? \`\${src}:\${tpl}:\${id}\`.slice(0, 200) : '';
  }
`;

module.exports = {
  id: '03-w12',
  title: 'W12: uncertain state, send ledger (idempotency), callback data, template policy',
  run(ctx) {
    // ---- classification: uncertain is not sent
    const classifyEdits = [
      { find: "  const uncertainSent = cfg.uncertain_counts_as_sent !== false;\n", replace: '' },
      { find: "    sent: send_status === 'accepted' || (send_status === 'uncertain' && uncertainSent),\n", replace: "    sent: send_status === 'accepted',   // PRODUCTION: only a message id from Meta counts as sent\n    uncertain: send_status === 'uncertain',   // the call left but no clear answer came: never sent again automatically, never reported as sent\n" },
      { find: "//   uncertain the request left but no clear answer came   -> sent: cfg.uncertain_counts_as_sent (default true:\n//             rather miss one message than send it twice, CLAUDE.md rule 4)", replace: "//   uncertain the request left but no clear answer came   -> sent: false, uncertain: true (PRODUCTION: it may have been delivered, so it is\n//             never re-sent automatically and never reported as sent; the delivery-status webhook or a person settles it)" },
    ];
    ctx.editCode('W12 – Read reply', classifyEdits);
    ctx.editCode('W12 – Prepare request', [
      ...classifyEdits,
      { find: "    if (!tpl) return stop('invalid', `unknown template \"${input.template}\" - add it to WA_TEMPLATES in W12`);\n", replace: "    if (!tpl) return stop('invalid', `unknown template \"${input.template}\" - add it to WA_TEMPLATES in W12`);\n    if (input.template === 'hello_world' && cfg.allow_hello_world !== true) return stop('invalid', 'template hello_world is Meta\\'s sample (\"Hello World\"): it is not sent to people in production (FLOWHQ_WA_ALLOW_HELLO_WORLD=true allows it for a smoke test)');\n" },
      { find: '    log_to_inbox: $json.w12_log_to_inbox,\n', replace: '    log_to_inbox: $json.w12_log_to_inbox,\n    allow_hello_world: $json.w12_allow_hello_world === true,\n' },
      { find: '  const cfg = {\n    send_mode: $json.w12_send_mode,', replace: `${IDEM_FN}  const cfg = {\n    send_mode: $json.w12_send_mode,` },
      {
        find: '  return { json: { input, cfg, prep } };',
        replace: `  // PRODUCTION: every send needs an idempotency key (the send ledger refuses a second send of the same key) and a place for the ledger.
  const idem_key = waIdemKey(input);
  if (prep.call_meta) {
    if (!idem_key) { prep.call_meta = false; prep.send_status = 'invalid'; prep.send_error = 'no idempotency key: the caller must send idem_key (or booking_uid / inbox_row_id / message_row_id / week)'; }
    else if (!/^https?:\\/\\/[^\\s/]+/i.test(String(input.grist_base_url || '')) || !String(input.doc_id || '').trim()) { prep.call_meta = false; prep.send_status = 'invalid'; prep.send_error = 'no send-ledger location: grist_base_url and doc_id are required'; }
    else prep.meta_request.biz_opaque_callback_data = \`fhq:\${idem_key}\`.slice(0, 500);   // Meta echoes it in the delivery-status webhook
  }
  return { json: { input, cfg, prep: { ...prep, idem_key } } };`,
      },
    ]);
    ctx.setValue('W12 – Config', 'w12_allow_hello_world', "={{ $env.FLOWHQ_WA_ALLOW_HELLO_WORLD === 'true' }}", 'boolean');
    ctx.setValue('W12 – Config', 'w12_default_language', "={{ $env.FLOWHQ_WA_TEMPLATE_LANGUAGE || 'en' }}");
    ctx.editCode('W12 – Test input', [{ find: '      lead_row_id: null,\n', replace: "      idem_key: `manual-test-${Date.now()}`,\n      lead_row_id: null,\n" }]);
    ctx.log('03', 'W12 – Prepare request / Read reply: "uncertain" is a state of its own (sent=false, uncertain=true), no longer counted as sent and never re-sent automatically');
    ctx.log('03', 'W12 – Prepare request: idempotency key required (idem_key, or booking_uid / inbox_row_id / message_row_id / week); Meta receives biz_opaque_callback_data="fhq:<key>"; hello_world refused unless FLOWHQ_WA_ALLOW_HELLO_WORLD=true; template language from FLOWHQ_WA_TEMPLATE_LANGUAGE');

    // ---- the ledger nodes
    const base = ctx.node('W12 – Call Meta?').position;
    const at = (i, row = 0) => [base[0] + 224 * i, base[1] + 320 + 240 * row];
    const http = (name, method, url, pos, extra) => ctx.add({
      name, type: 'n8n-nodes-base.httpRequest', typeVersion: ctx.like('n8n-nodes-base.httpRequest').typeVersion, position: pos, onError: 'continueRegularOutput', credentials: GRIST_CRED,
      parameters: { ...(method === 'GET' ? {} : { method }), url, authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth', ...extra, options: {} },
    });
    const filter = { sendQuery: true, queryParameters: { parameters: [{ name: 'filter', value: '={{ JSON.stringify({ Idem_Key: [$(\'W12 – Prepare request\').first().json.prep.idem_key] }) }}' }, { name: 'limit', value: '50' }] } };
    const body = (expr) => ({ sendBody: true, specifyBody: 'json', jsonBody: `={{ JSON.stringify(${expr}) }}` });

    http('W12 – Ledger lookup', 'GET', LEDGER_URL, at(0), filter);
    ctx.codeNode('W12 – Ledger decide', `// W12 SEND LEDGER (1/3): was this message already handled? The ledger (Grist table Send_Ledger, one row per idempotency key) is the only authority:
// a key with a row in any state except rejected / duplicate is NEVER sent again: not by a retry, not by a parallel run, not after an uncertain answer.
const p = $('W12 – Prepare request').first().json;
const key = p.prep.idem_key;
const stop = (send_status, send_error, ledger_status) => ({ json: { ...p, early: { send_status, send_error, ledger_status: ledger_status || '' } } });
if (!Array.isArray($json.records)) return stop('blocked', \`could not read the send ledger (Grist): \${String(($json.error && ($json.error.message || $json.error)) || 'no answer').replace(/\\s+/g, ' ').slice(0, 200)}. Nothing was sent; the caller may try again later.\`);
const handled = $json.records.filter((r) => !['rejected', 'duplicate'].includes(String((r.fields || {}).Status || '')));
if (handled.length) { const f = handled[0].fields || {}; return stop('duplicate', \`already handled: send-ledger row \${handled[0].id} is "\${f.Status}". Not sent again.\`, String(f.Status || '')); }
const now = Math.floor(Date.now() / 1000);
return { json: { ...p, ledger_claim: { records: [{ fields: { Idem_Key: key, Status: 'sending', Source: String(p.input.source_workflow || 'W12').slice(0, 60), Audience: String(p.input.audience || '').slice(0, 20), Template: p.input.message_type === 'text' ? 'text' : String(p.input.template || '').slice(0, 60), Created_At: now, Updated_At: now } }] } } };
`, at(1));
    ctx.ifNode('W12 – Stopped by ledger?', '={{ !!$json.early }}', at(2));
    http('W12 – Ledger claim', 'POST', LEDGER_URL, at(3), body('$json.ledger_claim'));
    http('W12 – Ledger verify', 'GET', LEDGER_URL, at(4), filter);
    ctx.codeNode('W12 – Ledger winner', `// W12 SEND LEDGER (2/3): after claiming, read the ledger again: the LOWEST row id for this key wins. A loser gives its row up and does not send.
const p = $('W12 – Ledger decide').first().json;
let claim = null;
try { claim = $('W12 – Ledger claim').first().json; } catch (e) { claim = null; }
const mine = claim && Array.isArray(claim.records) && claim.records[0] ? Number(claim.records[0].id) : 0;
const now = Math.floor(Date.now() / 1000);
const stop = (send_status, send_error, drop) => ({ json: { ...p, ledger_row_id: mine, early: { send_status, send_error }, drop_patch: mine ? { records: [{ id: mine, fields: { Status: drop, Error: String(send_error).slice(0, 300), Updated_At: now } }] } : null } });
if (!mine) return stop('blocked', \`could not write to the send ledger (Grist): \${String((claim && claim.error && (claim.error.message || claim.error)) || 'no answer').replace(/\\s+/g, ' ').slice(0, 200)}. Nothing was sent.\`, 'rejected');
if (!Array.isArray($json.records)) return stop('blocked', 'could not re-read the send ledger after claiming it. Nothing was sent.', 'rejected');
const live = $json.records.filter((r) => !['rejected', 'duplicate'].includes(String((r.fields || {}).Status || ''))).map((r) => Number(r.id)).sort((a, b) => a - b);
if (live.length && live[0] !== mine) return stop('duplicate', \`another run claimed this message first (ledger row \${live[0]}). Not sent again.\`, 'duplicate');
return { json: { ...p, ledger_row_id: mine } };
`, at(5));
    ctx.ifNode('W12 – Won claim?', '={{ !$json.early }}', at(6));
    ctx.ifNode('W12 – Row to release?', '={{ !!$json.drop_patch }}', at(7, 1));
    http('W12 – Ledger release', 'PATCH', LEDGER_URL, at(8, 1), body('$json.drop_patch'));
    ctx.codeNode('W12 – Ledger result', `// W12 SEND LEDGER (3/3): record what Meta answered on the claimed row. If this write fails the row stays "sending" (still blocks a second send);
// the delivery-status webhook (callback data) or the reconcile job settles it.
const p = $('W12 – Read reply').first().json;
const row = Number($('W12 – Ledger winner').first().json.ledger_row_id) || 0;
const r = p.res;
const status = ['accepted', 'uncertain', 'rejected'].includes(r.send_status) ? r.send_status : 'rejected';
return { json: { ...p, ledger_patch: { records: [{ id: row, fields: { Status: status, WA_Message_ID: r.wa_message_id || '', Error: String(r.send_error || '').slice(0, 300), Error_Code: Number.isFinite(Number(r.send_error_code)) ? Number(r.send_error_code) : 0, Updated_At: Math.floor(Date.now() / 1000) } }] } } };
`, ctx.pos('W12 – Read reply', 0, 320));
    http('W12 – Ledger update', 'PATCH', LEDGER_URL, ctx.pos('W12 – Read reply', 224, 320), body('$json.ledger_patch'));
    ctx.codeNode('W12 – Ledger restore', `// carry on with the send result (and note if the ledger write failed)
const { ledger_patch, ...rest } = $('W12 – Ledger result').first().json;
return { json: { ...rest, ledger_update_ok: !($json && $json.error) } };
`, ctx.pos('W12 – Read reply', 448, 320));

    // ---- wiring: Call Meta?(true) -> lookup -> decide -> stopped? -> claim -> verify -> winner -> won? -> Meta send ; Read reply -> result -> update -> restore -> Log to inbox?
    ctx.setOutputs('W12 – Call Meta?', [['W12 – Ledger lookup'], ['W12 – Return result']]);
    ctx.setOutputs('W12 – Ledger lookup', [['W12 – Ledger decide']]);
    ctx.setOutputs('W12 – Ledger decide', [['W12 – Stopped by ledger?']]);
    ctx.setOutputs('W12 – Stopped by ledger?', [['W12 – Return result'], ['W12 – Ledger claim']]);
    ctx.setOutputs('W12 – Ledger claim', [['W12 – Ledger verify']]);
    ctx.setOutputs('W12 – Ledger verify', [['W12 – Ledger winner']]);
    ctx.setOutputs('W12 – Ledger winner', [['W12 – Won claim?']]);
    ctx.setOutputs('W12 – Won claim?', [['W12 – Meta send'], ['W12 – Row to release?']]);
    ctx.setOutputs('W12 – Row to release?', [['W12 – Ledger release'], ['W12 – Return result']]);
    ctx.setOutputs('W12 – Ledger release', [['W12 – Return result']]);
    ctx.setOutputs('W12 – Read reply', [['W12 – Ledger result']]);
    ctx.setOutputs('W12 – Ledger result', [['W12 – Ledger update']]);
    ctx.setOutputs('W12 – Ledger update', [['W12 – Ledger restore']]);
    ctx.setOutputs('W12 – Ledger restore', [['W12 – Log to inbox?']]);

    // ---- result: duplicate / uncertain / idem_key
    const ret = ctx.node('W12 – Return result');
    const oldRet = ret.parameters.jsCode;
    if (!oldRet.includes("const p = from('W12 – Read reply') || from('W12 – Prepare request');") || !oldRet.includes('sent: res.sent === true,')) throw new Error('"W12 – Return result" is not the expected code');
    ctx.editCode('W12 – Return result', [
      {
        find: "  const p = from('W12 – Read reply') || from('W12 – Prepare request');\n  const res = p.res || {\n    send_status: p.prep.send_status, sent: false, wa_message_id: '', send_error: p.prep.send_error, send_error_code: null, send_http_status: null,\n  };",
        replace: "  const ran = from('W12 – Read reply');   // Meta was called\n  const stopped = ran ? null : ((from('W12 – Ledger winner') || from('W12 – Ledger decide') || {}).early || null);   // the ledger said duplicate / could not be used: Meta was NOT called\n  const p = ran || from('W12 – Prepare request');\n  const res = ran ? ran.res : {\n    send_status: stopped ? stopped.send_status : p.prep.send_status, sent: false, uncertain: false, wa_message_id: '', send_error: stopped ? stopped.send_error : p.prep.send_error, send_error_code: null, send_http_status: null,\n  };",
      },
      { find: '      sent: res.sent === true,\n', replace: "      sent: res.sent === true,\n      uncertain: res.uncertain === true,\n      duplicate: res.send_status === 'duplicate',\n      idem_key: (p.prep && p.prep.idem_key) || '',\n" },
    ]);
    ctx.log('03', 'W12 send ledger: new nodes Ledger lookup/decide/Stopped by ledger?/claim/verify/winner/Won claim?/Row to release?/release/result/update/restore. Claim BEFORE calling Meta; duplicates and ledger outages return without calling Meta; Return result now carries uncertain, duplicate and idem_key');
  },
};
