// n8n Code node ("Run Once for Each Item"): may we send this patient-facing WhatsApp message right now?
// Implements CLAUDE.md rules 4 and 5. Pure function: pass in what you already read from Grist; it never sends.
// Paste decideSend + helpers (and normalize-phone.js's normalizeIndianPhone) into the Code node placed right
// before the send node, then branch on the result.
//
// Checks, in order (first match wins):
//   1. sent flag already set                 -> skip   (rule 4: never double-message)
//   2. lead Opted_Out                        -> skip
//   3. not 'transactional' + conversation Automation_Paused -> skip
//        (confirmations and reminders still go when paused; follow-ups and marketing do not)
//   4. quiet hours 21:00-08:00 IST           -> skip   (try again on the next run)
//   5. TEST_MODE on -> recipient is TEST_PHONE, not the patient. A missing or unclear TEST_MODE counts as ON.
//
// Input:  { kind: 'transactional' | 'marketing', flag_value, opted_out, automation_paused,
//           patient_phone, test_mode, test_phone, now_ms }
//         patient_phone / test_phone must already be normalised (+91XXXXXXXXXX, or null).
//         test_mode is the raw Settings.Value text. flag_value is the R24_Sent-style DateTime (empty = not sent).
// Output: { send: boolean, to: string | null, reason: string, test_mode: boolean }

function isTestMode(value) {
  const v = String(value === null || value === undefined ? '' : value).trim().toLowerCase();
  return !['false', '0', 'no', 'off'].includes(v);   // anything else, including a missing row, means ON (fail safe)
}

function inQuietHours(nowMs) {
  if (!Number.isFinite(nowMs)) return true;           // no clock, no send
  const hourIST = new Date(nowMs + 5.5 * 3600 * 1000).getUTCHours();
  return hourIST >= 21 || hourIST < 8;
}

function decideSend(i) {
  const testMode = isTestMode(i.test_mode);
  const skip = (reason) => ({ send: false, to: null, reason, test_mode: testMode });

  if (i.flag_value) return skip('already sent');
  if (i.opted_out) return skip('opted out');
  if (i.kind !== 'transactional' && i.automation_paused) return skip('automation paused');
  if (inQuietHours(i.now_ms)) return skip('quiet hours');

  const to = testMode ? i.test_phone : i.patient_phone;
  if (!to) return skip(testMode ? 'test mode on but TEST_PHONE is missing or invalid' : 'no valid patient phone');
  return { send: true, to, reason: testMode ? 'test mode: sent to TEST_PHONE' : 'ok', test_mode: testMode };
}

// ---- n8n Code node body (uncomment inside n8n) ----
// const { phone: patient_phone } = normalizeIndianPhone($json.patient_phone);
// const { phone: test_phone } = normalizeIndianPhone($json.test_phone);
// const decision = decideSend({ kind: 'transactional', flag_value: $json.flag_value, opted_out: $json.opted_out,
//   automation_paused: false, patient_phone, test_mode: $json.test_mode, test_phone, now_ms: Date.now() });
// return { json: { ...$json, decision, send: decision.send } };

if (typeof module !== 'undefined') module.exports = { decideSend, isTestMode, inQuietHours };
