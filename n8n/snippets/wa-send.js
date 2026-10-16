// n8n Code node helpers for W12 (WhatsApp send via Meta Cloud API): template map, request builder,
// Meta reply classifier and the Grist Inbox row. Pure functions. The shared helpers normalizeIndianPhone
// (normalize-phone.js) and inQuietHours (send-guard.js) are passed in as `h`, so the same code runs pasted
// into n8n and in Node tests. Paste from WA_TEMPLATES down to (not including) the module.exports line.
//
// Template variables are POSITIONAL ({{1}}, {{2}}, ...) in the order listed here. The approved template in
// WhatsApp Manager must have exactly these variables in this order (see n8n/whatsapp-templates.md).
// A string entry is required; { key, fallback } uses the fallback when the value is empty, because Meta
// rejects empty variables.

const WA_TEMPLATES = {
  hello_world: { language: 'en_US', params: [] },          // Meta's sample template on the test number
  booking_confirmation: { params: ['name', 'service', 'clinic_name', 'date', 'time'] },
  reminder_24h: { params: ['name', 'service', 'clinic_name', 'date', 'time'] },
  reminder_2h: { params: ['name', 'service', 'clinic_name', 'time'] },
  noshow_rebook: { params: ['name', 'service', 'clinic_name', 'date', 'booking_link'] },
  followup_day2: { params: ['name', 'clinic_name', 'booking_link'] },
  new_lead_staff_alert: { params: ['clinic_name', 'lead_name', 'lead_phone', { key: 'enquiry', fallback: '(no message)' }] },
  lead_escalation: { params: ['clinic_name', 'lead_name', 'lead_phone', 'waiting_minutes'] },
  human_handoff_alert: { params: ['clinic_name', 'lead_name', 'lead_phone', { key: 'reason', fallback: '(see the Grist inbox)' }] },
  outcome_check: { params: ['name', 'clinic_name', { key: 'service', fallback: 'visit' }] },                    // W7
  review_request: { params: ['name', 'clinic_name', 'review_link'] },                                          // W8
  weekly_owner_report: { params: ['clinic_name', 'week', 'summary', { key: 'action', fallback: 'see the full report in Grist' }] },   // W9
};

// Free-text replies (message_type 'text', from W13) are only allowed inside WhatsApp's 24-hour customer-service
// window, i.e. within 24 h of the patient's last message (last_inbound_at). A 5-minute margin keeps clock drift safe.
const WA_TEXT_WINDOW_MS = 24 * 3600 * 1000 - 5 * 60 * 1000;

// Short hints for the Meta error codes we are most likely to meet (shown in send_error).
const WA_HINTS = {
  190: 'access token invalid or expired - put a permanent System User token in the "WhatsApp Cloud API" credential',
  10: 'token lacks permission - give the System User whatsapp_business_messaging',
  200: 'token lacks permission - give the System User whatsapp_business_messaging',
  100: 'invalid parameter - check wa_phone_number_id and the template',
  131030: "recipient is not in the test number's allowed list - add it in Meta > WhatsApp > API Setup",
  131026: 'message undeliverable (number not on WhatsApp?)',
  131047: 'outside the 24h window - only templates can be sent',
  131056: 'too many messages to this number - try later',
  130429: 'rate limit hit - try later',
  132000: 'number of template variables does not match the approved template',
  132001: 'template not found in this language - check the name and language code',
  132005: 'template text too long after filling the variables',
  132007: 'template content policy violation',
  132012: 'template variable format does not match',
  133010: 'phone number not registered with the Cloud API',
  131031: 'WhatsApp account locked',
  368: 'temporarily blocked for policy violations',
};

// Meta: a variable may not contain new-lines, tabs or runs of spaces.
function waCleanParam(v) {
  return String(v === null || v === undefined ? '' : v).replace(/\s+/g, ' ').trim().slice(0, 250);
}

// Decide whether to call Meta, and build the request. Never throws.
// input: the caller's item (decision, template, template_params, wa_phone_number_id, ...); cfg: W12 Config.
function waPrepare(input, cfg, nowMs, h) {
  const stop = (send_status, send_error) => ({ call_meta: false, send_status, send_error });
  const d = input && input.decision;
  if (!d || d.send !== true) return stop('not_requested', d && d.reason ? `guard said no: ${d.reason}` : 'no send decision from the caller');

  const mode = String(cfg.send_mode || '').trim().toLowerCase();
  if (mode !== 'allowlist' && mode !== 'live') return stop('blocked', `W12 send_mode is "${cfg.send_mode}" - only "allowlist" or "live" send`);

  // 1. Is the message itself sendable? (reported even while testing in allowlist mode or at night)
  const to = h.normalizeIndianPhone(d.to).phone;
  if (!to) return stop('invalid', 'decision.to is not a valid Indian mobile number');
  const version = String(cfg.graph_api_version || '').trim();
  if (!/^v\d+\.\d+$/.test(version)) return stop('invalid', 'graph_api_version is not set in the W12 Config node (e.g. v23.0 - copy it from Meta API Setup)');
  const phoneId = String(input.wa_phone_number_id || '').trim();
  if (!/^\d{5,25}$/.test(phoneId)) return stop('invalid', 'wa_phone_number_id is missing or not a number (Agency Registry > Clinics > WA_Phone_Number_ID)');
  const isText = input.message_type === 'text';
  let tpl = null;
  let textBody = '';
  const params = [];
  if (isText) {
    textBody = String(input.text_body === null || input.text_body === undefined ? '' : input.text_body).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, 4096);
    if (!textBody) return stop('invalid', 'text message: text_body is empty');
    const last = Number(input.last_inbound_at);
    if (!Number.isFinite(last) || last <= 0) return stop('invalid', 'text message: last_inbound_at (the patient\'s last message, epoch seconds) is missing');
    if (nowMs - last * 1000 > WA_TEXT_WINDOW_MS) return stop('blocked', 'outside the 24-hour WhatsApp window: only an approved template may be sent');
  } else {
    tpl = WA_TEMPLATES[input.template];
    if (!tpl) return stop('invalid', `unknown template "${input.template}" - add it to WA_TEMPLATES in W12`);
    const values = input.template_params || {};
    for (const spec of tpl.params) {
      const key = typeof spec === 'string' ? spec : spec.key;
      let v = waCleanParam(values[key]);
      if (!v && typeof spec === 'object') v = spec.fallback;
      if (!v) return stop('invalid', `template ${input.template}: variable "${key}" is empty`);
      params.push(v);
    }
  }

  // 2. May it go out now, to this number?
  if (mode === 'allowlist') {
    const allowed = String(cfg.allowlist || '').split(/[,;]+/).map((x) => h.normalizeIndianPhone(x).phone).filter(Boolean);
    if (!allowed.includes(to)) return stop('blocked', `${to} is not in the W12 allowlist (send_mode = allowlist)`);
  }
  if (h.inQuietHours(nowMs)) return stop('blocked', 'quiet hours (21:00-08:00 IST)');

  if (isText) {
    return {
      call_meta: true,
      send_status: 'pending',
      send_error: '',
      to,
      meta_url: `https://graph.facebook.com/${version}/${phoneId}/messages`,
      meta_request: { messaging_product: 'whatsapp', recipient_type: 'individual', to: to.slice(1), type: 'text', text: { preview_url: /https?:\/\//i.test(textBody), body: textBody } },
    };
  }
  const template = { name: input.template, language: { code: String(input.template_language || tpl.language || cfg.default_language || 'en') } };
  if (params.length) template.components = [{ type: 'body', parameters: params.map((text) => ({ type: 'text', text })) }];
  return {
    call_meta: true,
    send_status: 'pending',
    send_error: '',
    to,
    meta_url: `https://graph.facebook.com/${version}/${phoneId}/messages`,
    meta_request: { messaging_product: 'whatsapp', recipient_type: 'individual', to: to.slice(1), type: 'template', template },
  };
}

// Turn the HTTP node output (fullResponse + neverError, or a "continue on error" item) into a result.
//   accepted  Meta returned a message id                  -> sent: true
//   rejected  Meta refused, or the request never left     -> sent: false (safe to try again later)
//   uncertain the request left but no clear answer came   -> sent: cfg.uncertain_counts_as_sent (default true:
//             rather miss one message than send it twice, CLAUDE.md rule 4)
function waClassify(resp, cfg) {
  const uncertainSent = cfg.uncertain_counts_as_sent !== false;
  const result = (send_status, extra) => Object.assign({
    send_status,
    sent: send_status === 'accepted' || (send_status === 'uncertain' && uncertainSent),
    wa_message_id: '',
    send_error: '',
    send_error_code: null,
    send_http_status: null,
  }, extra);

  if (resp && typeof resp.statusCode === 'number') {
    let body = resp.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
    body = body || {};
    const id = body.messages && body.messages[0] && body.messages[0].id;
    if (resp.statusCode >= 200 && resp.statusCode < 300) {
      return id
        ? result('accepted', { wa_message_id: String(id), send_http_status: resp.statusCode })
        : result('uncertain', { send_error: 'Meta answered without a message id', send_http_status: resp.statusCode });
    }
    const e = body.error || {};
    const code = e.code !== undefined && e.code !== null ? Number(e.code) : null;
    const detail = (e.error_data && e.error_data.details) || e.message || `HTTP ${resp.statusCode}`;
    const hint = code !== null && WA_HINTS[code] ? ` (${WA_HINTS[code]})` : '';
    return result('rejected', { send_error_code: code, send_http_status: resp.statusCode, send_error: `${code !== null ? code + ': ' : ''}${detail}${hint}`.slice(0, 500) });
  }

  // n8n's "continue on error" item: { error: '...' } or { error: { message, description, code, ... } }. n8n also
  // rewrites network errors into friendly text, so match both the raw codes and n8n's wording.
  const err = resp && resp.error;
  const msg = String((err && (err.message || err.description)) || (typeof err === 'string' ? err : '') || 'no reply from Meta');
  const haystack = typeof err === 'string' ? err : JSON.stringify(err || {});
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|certificate|self[- ]signed|refused the connection|DNS server returned an error/i.test(haystack)) {
    return result('rejected', { send_error: `not sent - could not reach Meta: ${msg}`.slice(0, 500) });
  }
  return result('uncertain', { send_error: `no clear answer from Meta (it may or may not have been sent): ${msg}`.slice(0, 500) });
}

// Should this send be written to the Grist Inbox (Conversations + Messages)? Only patient messages that
// actually reached the point of calling Meta. The conversation is the PATIENT's (lead_phone), even when
// TEST_MODE sent the message to TEST_PHONE. A message that already has its own Messages row (W10 staff reply:
// inbox_row_id) is not written again; its caller updates that row.
function waInboxPlan(input, cfg, res, h) {
  const patient_phone = h.normalizeIndianPhone(input.lead_phone || input.patient_phone).phone;
  const attempted = ['accepted', 'uncertain', 'rejected'].includes(res.send_status);
  const own = Number(input.inbox_row_id) > 0;
  const log = cfg.log_to_inbox !== false && input.audience === 'patient' && attempted && !own && !!patient_phone && !!input.grist_base_url && !!input.doc_id;
  return { log, patient_phone };
}

// The Messages row. Send stays false: W10 sends rows whose Send is ticked, and this one is already out.
function waInboxRow(input, res, nowSec) {
  const d = input.decision || {};
  const via = d.test_mode ? ` (TEST_MODE: sent to ${d.to})` : '';
  return {
    Direction: 'Out',
    Body: String(input.message_text || input.text_body || `[template ${input.template}]`).slice(0, 2000),
    Template: input.message_type === 'text' ? '' : String(input.template || ''),
    Sent_By: `${input.source_workflow || 'W12'}${via}`.slice(0, 200),
    WA_Message_ID: res.wa_message_id || '',
    Status: res.send_status === 'rejected' ? 'failed' : 'queued',
    Send: false,
    Created_At: nowSec,
  };
}

if (typeof module !== 'undefined') module.exports = { WA_TEMPLATES, WA_HINTS, WA_TEXT_WINDOW_MS, waCleanParam, waPrepare, waClassify, waInboxPlan, waInboxRow };
