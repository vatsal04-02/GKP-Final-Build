// n8n Code node helpers for W15 (follow-up reminder): the day before a patient's follow-up date, one WhatsApp reminder.
// Pure functions. normalizeIndianPhone (normalize-phone.js) is passed in as `h`, so the same code runs pasted into n8n and in Node
// tests. Paste from FR_IST down to (not including) the module.exports line.
//
// Where the date comes from: Patients.Follow_Up_On (Clinic Records). FLOW HQ copies a prescription's follow-up date there when the
// prescription is saved, so this is the date the doctor wrote. The sent flag is Patients.Followup_Reminded_For (Date): the follow-up
// date already reminded. Same date = never again (CLAUDE.md rule 4); a new follow-up date = a new reminder.
//
// Who is reminded: Active patients whose follow-up is `days_before` days away, from `send_hour` IST until quiet hours begin (21:00).
// A patient is HELD (no claim, no send, counted in one Run_Log summary) when the reminder cannot lawfully or usefully go:
//   no https booking_link in Settings, no valid phone, no lead with this phone, the lead opted out, or no WhatsApp consent on the lead.
// The consent rule is W12's (LEADS.Consent_WhatsApp, a business-initiated template needs it); checking it here first means a patient
// without consent is not claimed, so the reminder still goes if consent is recorded before the day.

const FR_IST_MS = 5.5 * 3600 * 1000;
const FR_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const FR_TEXT_WINDOW_SEC = 24 * 3600 - 5 * 60;   // WhatsApp free-text window (as W12), minus a margin
const FR_QUIET_FROM = 21;                        // quiet hours 21:00-08:00 IST (send-guard.js decides; this only stops planning)

function frText(v, max) { return String(v === null || v === undefined ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max); }
function frSec(v) { return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null; }
function frHttps(v) { const s = frText(v, 500); return /^https:\/\/[^\s<>"']+$/i.test(s) ? s : ''; }
function frFirstName(v) { return frText(v, 60).split(' ')[0] || 'there'; }
// A per-clinic switch in Settings: on / true / yes / 1. Missing = OFF (switch it on once the template is approved).
function frOn(v) { return ['on', 'true', 'yes', '1'].includes(frText(v, 10).toLowerCase()); }

// A Grist Date cell (epoch seconds at UTC midnight) or a 'YYYY-MM-DD' string -> 'YYYY-MM-DD'; anything else -> ''.
function frIso(v) {
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v.trim())) return v.trim();
  const s = frSec(v);
  return s === null ? '' : new Date(s * 1000).toISOString().slice(0, 10);
}
function frIstToday(nowMs) { return new Date(nowMs + FR_IST_MS).toISOString().slice(0, 10); }
function frIstHour(nowMs) { return new Date(nowMs + FR_IST_MS).getUTCHours(); }
function frAddDays(iso, n) { const [y, m, d] = iso.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); }
function frDateSec(iso) { const [y, m, d] = iso.split('-').map(Number); return Date.UTC(y, m - 1, d) / 1000; }   // the value Grist stores for a Date
function frLabel(iso) { const [y, m, d] = iso.split('-').map(Number); return `${String(d).padStart(2, '0')} ${FR_MONTHS[m - 1]} ${y}`; }

// cfg: { send_hour, days_before }. settings: the clinic's Settings (Key -> Value). h: { normalizeIndianPhone }.
// -> { active, target, items }   items carry hold_reason ('' = may be sent; send-guard.js still decides).
function frPlan(patients, leadRows, convRecords, nowMs, cfg, settings, h) {
  const hour = frIstHour(nowMs);
  const sendHour = Number(cfg.send_hour);
  const before = Number(cfg.days_before);
  if (!Number.isInteger(sendHour) || !Number.isInteger(before) || before < 0) return { active: false, target: '', items: [], error: 'W15 Config: send_hour and days_before must be whole numbers' };
  const target = frAddDays(frIstToday(nowMs), before);
  if (hour < sendHour || hour >= FR_QUIET_FROM) return { active: false, target, items: [] };
  const link = frHttps(settings && settings.booking_link);

  // the lead of a phone number, exactly as W12's consent check finds it: same +91 number, the first such row
  const leadByPhone = {};
  for (const r of Array.isArray(leadRows) ? leadRows : []) {
    const p = h.normalizeIndianPhone(r && r.fields && r.fields.Phone).phone;
    if (p && !leadByPhone[p]) leadByPhone[p] = r;
  }
  // the lead's conversation: Automation_Paused (rule 5) and the patient's last message (24 h window -> free text instead of a template)
  const convByLead = {};
  for (const r of Array.isArray(convRecords) ? convRecords : []) {
    const f = (r && r.fields) || {};
    const id = String(f.Lead === null || f.Lead === undefined ? '' : f.Lead);
    if (!/^[1-9]\d*$/.test(id)) continue;
    const c = convByLead[id] || (convByLead[id] = { paused: false, last_inbound_at: null });
    if (f.Automation_Paused === true) c.paused = true;
    const at = frSec(f.Last_Inbound_At);
    if (at !== null && (c.last_inbound_at === null || at > c.last_inbound_at)) c.last_inbound_at = at;
  }

  const items = [];
  for (const r of Array.isArray(patients) ? patients : []) {
    const f = (r && r.fields) || {};
    if (f.Status !== 'Active' || frIso(f.Follow_Up_On) !== target) continue;
    if (frIso(f.Followup_Reminded_For) === target) continue;               // already reminded for this date: never again
    const phone = h.normalizeIndianPhone(f.Phone).phone;
    const lead = phone ? leadByPhone[phone] : null;
    const lf = (lead && lead.fields) || {};
    const conv = lead ? convByLead[String(lead.id)] : null;
    let hold = '';
    if (!link) hold = 'Settings > booking_link is not set (an https link)';
    else if (!phone) hold = 'no valid phone number';
    else if (!lead) hold = 'no WhatsApp consent on file (no lead with this phone)';
    else if (lf.Opted_Out === true) hold = 'opted out';
    else if (lf.Consent_WhatsApp !== true) hold = 'no WhatsApp consent on file (LEADS.Consent_WhatsApp)';
    items.push({
      kind: 'followup',
      patient_row_id: r.id,
      patient_id: frText(f.Patient_ID, 40) || `row ${r.id}`,
      patient_name: frText(f.Name, 60),
      lead_phone: phone || '',
      lead_row_id: lead ? lead.id : 0,
      opted_out: lf.Opted_Out === true,
      automation_paused: !!(conv && conv.paused),
      flag_value: null,
      follow_up_on: target,
      booking_link: link,
      last_inbound_at: conv ? conv.last_inbound_at : null,
      hold_reason: hold,
    });
  }
  return { active: true, target, items };
}

// The message for W12. Free text when the patient wrote in the last 24 h (no template needed), else the approved template.
// The text is the template's wording, so the Grist inbox (and W13 reading the history) shows what the patient got.
function frMessage(item, clinicName, nowSec) {
  const name = frFirstName(item.patient_name);
  const clinic = frText(clinicName, 80) || 'the clinic';
  const date = frLabel(item.follow_up_on);
  const text = `Hi ${name}, a reminder from ${clinic}: your follow-up visit is due on ${date}. Please book or confirm your time here: ${item.booking_link} or simply reply to this message.`;
  const inWindow = frSec(item.last_inbound_at) !== null && nowSec - item.last_inbound_at < FR_TEXT_WINDOW_SEC;
  return inWindow
    ? { message_type: 'text', text_body: text, message_text: text, template: '', template_params: {} }
    : { message_type: 'template', text_body: '', message_text: text, template: 'followup_reminder', template_params: { name, clinic_name: clinic, date, booking_link: item.booking_link } };
}

// One logical message = one key: W12's send ledger refuses a second send of the same key.
function frIdemKey(item) { return `W15:followup_reminder:${frText(item.patient_id, 40).replace(/[^A-Za-z0-9_.\-]/g, '')}:${item.follow_up_on}`; }

// The patients not sent this run, as ONE Run_Log line per clinic: "3 not sent: no WhatsApp consent 2, opted out 1".
function frHeldSummary(reasons) {
  const by = {};
  for (const r of reasons) { const k = frText(r, 120) || 'not sent'; by[k] = (by[k] || 0) + 1; }
  const total = reasons.length;
  const parts = Object.entries(by).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`);
  return { total, text: total ? `${total} follow-up reminder(s) not sent: ${parts.join('; ')}`.slice(0, 500) : '' };
}

if (typeof module !== 'undefined') module.exports = { FR_TEXT_WINDOW_SEC, frIso, frIstToday, frIstHour, frAddDays, frDateSec, frLabel, frOn, frHttps, frPlan, frMessage, frIdemKey, frHeldSummary };
