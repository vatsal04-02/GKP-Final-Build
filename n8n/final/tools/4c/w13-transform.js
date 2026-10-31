// The edits Slice 4C makes to n8n/snippets/ai-receptionist.js, as anchored replacements. Used twice by patch-4c-w13-booking.js:
//   * on each pasted copy of the snippet inside the W13 nodes of the candidate (every anchor must be found exactly once in each copy), and
//   * on the repo snippet itself, to write the readable standalone copy n8n/snippets/ai-receptionist-central.js that the unit tests run.
// n8n/snippets/ai-receptionist.js is NOT edited: the older lineages (n8n/integrated, n8n/merged, n8n/workflows) validate that exact text.
'use strict';
const fs = require('fs');
const path = require('path');

const read = (f) => fs.readFileSync(path.join(__dirname, f), 'utf8').replace(/\r\n/g, '\n');

function once(code, from, what) {
  const first = code.indexOf(from);
  if (first < 0 || code.indexOf(from, first + 1) >= 0) throw new Error(`${what}: the expected code was not found exactly once (the workflow was edited): nothing written`);
  return first;
}
const replaceOnce = (code, from, to, what) => { const i = once(code, from, what); return code.slice(0, i) + to + code.slice(i + from.length); };
// replace the one line that starts with `start` (the whole line, without its newline)
function replaceLine(code, start, line, what) {
  const i = once(code, `\n${start}`, what) + 1;
  const end = code.indexOf('\n', i);
  return code.slice(0, i) + line + code.slice(end < 0 ? code.length : end);
}
// replace from `startMarker` up to (not including) `endMarker`
function replaceBetween(code, startMarker, endMarker, replacement, what) {
  const i = once(code, startMarker, `${what} (start)`);
  const j = code.indexOf(endMarker, i);
  if (j < 0 || code.indexOf(endMarker, j + 1) >= 0 && code.indexOf(endMarker, i) !== j) throw new Error(`${what}: end marker not found`);
  return code.slice(0, i) + replacement + code.slice(j);
}

// The anchors that exist in every copy of the snippet.
function transformSnippet(code) {
  let c = code;
  c = replaceLine(c, "    booking_mode: String(s.booking_mode || '').trim().toLowerCase() === 'direct' ? 'direct' : 'link',",
    "    booking_mode: 'central',   // Slice 4C: W13 books, cancels and moves appointments only through the FLOW HQ booking API; Settings > booking_mode = direct is ignored (direct_requested says so)\n    direct_requested: String(s.booking_mode || '').trim().toLowerCase() === 'direct',", 'aiProfile booking_mode');
  c = replaceLine(c, "    booking_link: /^https:\\/\\/\\S+$/.test(aiLine(s.booking_link, 300)) ? aiLine(s.booking_link, 300) : '',",
    "    booking_link: aiSafeLink(s.booking_link),   // https only, and never a Cal.com link", 'aiProfile booking_link');

  c = replaceLine(c, '  if (!apptRecs) notes.push(', "  if (!apptRecs) notes.push(`appointments not read (${aiErrText(raw.appointments)}): the patient's own appointments cannot be listed`);", 'aiContext appointments note');
  c = replaceLine(c, '  const slots = apptRecs ? aiFreeSlots(',
    "  const slots = aiCentralSlots(raw.central, profile, nowMs, days);   // Slice 4C: the free times are the booking system's, not W13's own arithmetic\n" +
    "  if (!slots.known && slots.reason) notes.push(`booking system: ${slots.reason}: no free times offered`);\n" +
    "  if (profile.direct_requested) notes.push('Settings > booking_mode = direct is ignored: W13 books only through the booking system');", 'aiContext slots');

  c = replaceLine(c, "  if (!x.slots.known) lines.push(x.slots.unreadable ?", "  if (!x.slots.known) lines.push('- not known right now. Do not offer any time.');", 'aiFacts availability');
  c = replaceLine(c, "    const how = a.origin === 'calcom' ?", "    const how = 'the system can cancel or move it after the patient confirms with YES';", 'aiFacts appointment note');

  c = replaceLine(c, "  '- \"book_slot\": ONLY when", "  '- \"book_slot\": when the patient asks for one exact day AND time listed in AVAILABILITY, or answers YES to your question asking them to confirm one exact day and time (then copy that day and time from RECENT CONVERSATION). Copy booking.date and booking.time (HH:MM, 24-hour) exactly from AVAILABILITY. Your reply text is replaced: the system asks the patient to confirm, books only after they confirm, and tells them when the booking system has saved it. Never say a booking is made or confirmed.',", 'AI_RULES book_slot');
  c = replaceLine(c, "  '- \"cancel_appointment\" / \"reschedule_appointment\": only for", "  '- \"cancel_appointment\" / \"reschedule_appointment\": only for an appointment listed under APPOINTMENTS; put its ref (A1, A2...) in appointment_ref. The system changes it after the patient confirms with YES; never say it is already cancelled or moved. For a reschedule, also put the new time in booking if the patient gave one that is listed in AVAILABILITY. No appointment, or unclear which one: ask (action \"reply\") or hand off.',", 'AI_RULES cancel');
  c = replaceLine(c, "  'Links: never type a URL.", "  'Links: never type a URL. Write {{BOOKING_LINK}} where a booking link belongs, only if CLINIC says one exists; the system fills it in. There are no cancel or reschedule links.',", 'AI_RULES links');

  c = replaceBetween(c, "  lines.push(x.profile.booking_mode === 'direct'", "  lines.push('', 'KNOWLEDGE BASE');",
    "  lines.push('- booking: the system books, cancels and moves appointments in the clinic booking system, but only after the patient confirms one exact day and time; you never confirm a booking yourself');\n", 'aiClinicFacts booking line');

  // for these three actions the SYSTEM writes the whole reply (the question, then the result of the booking system), so an empty reply from the model is fine; every other action still needs the model's text
  c = replaceLine(c, "  if (!aiClean(d.reply, 10)) return handoff('the AI gave no reply text');", "  if (!aiClean(d.reply, 10) && !['book_slot', 'cancel_appointment', 'reschedule_appointment'].includes(d.action)) return handoff('the AI gave no reply text');   // Slice 4C: the system writes the reply for these actions", 'aiPlan empty reply');
  c = replaceOnce(c, ' booked: null, cancelled: null, notes: [] };', ' booked: null, cancelled: null, central: null, notes: [] };', 'aiEmptyPlan');
  c = replaceOnce(c, '  plan.booked = null;\n  plan.cancelled = null;\n  delete plan.lead_patch.Status;', '  plan.booked = null;\n  plan.cancelled = null;\n  plan.central = null;\n  delete plan.lead_patch.Status;', 'aiToHandoff');
  c = replaceOnce(c, "if (plan.route !== 'handoff' && plan.action_writes.length && d.confidence < tWrite)", "if (plan.route !== 'handoff' && (plan.action_writes.length || plan.central) && d.confidence < tWrite)", 'aiPlan write confidence');

  c = replaceBetween(c, "  if (d.action === 'offer_slots' || d.action === 'book_slot') {\n    if (!x.slots.known) {", "  if (d.action === 'schedule_follow_up') {", read('w13-route.body.js'), 'aiRoute');
  c = replaceOnce(c, '// ---------------------------------------------------------------- links\n', `${read('w13-central.functions.js')}// ---------------------------------------------------------------- links\n`, 'central functions');
  return c;
}

// The two node-specific edits (not part of the snippet).
function buildContextNode(code) {
  return replaceOnce(code, "history: g('W13 – History'), appointments: g('W13 – Appointments'),", "history: g('W13 – History'), appointments: g('W13 – Appointments'), central: g('W13 – Availability collect').central,", 'W13 – Build Context');
}
function planReadyNode(code) {
  return replaceOnce(code, 'const errs = Array.isArray($json.action_errors)',
    "// Slice 4C: the booking system's answer to the one call the plan asked for. The patient is told it is done only after a 200/201.\n" +
    "const central = $('W13 – Central collect').first().json.central_results || [];\n" +
    "if (plan.central) aiApplyCentral(plan, b.x, b.cfg, central[0] || null);\n" +
    'const errs = Array.isArray($json.action_errors)', 'W13 – Plan Ready');
}

// The readable standalone copy for the unit tests: the repo snippet with the same edits, and the new functions exported.
function standalone(snippetText) {
  let c = transformSnippet(snippetText.replace(/\r\n/g, '\n'));
  c = replaceOnce(c, '    aiTimesIn, aiAmountsIn, aiAllowedFacts, aiCheckReply, aiCalOrigin, aiBookingLink, aiFillLinks, aiEmptyPlan, aiToHandoff,',
    '    aiTimesIn, aiAmountsIn, aiAllowedFacts, aiCheckReply, aiCalOrigin, aiBookingLink, aiFillLinks, aiEmptyPlan, aiToHandoff,\n    aiSafeLink, aiIdemKey, aiCentralSlots, aiConfirmAsk, aiConfirmed, aiApplyCentral, AI_CONFIRM_MARK,', 'module.exports');
  return `// GENERATED by n8n/final/tools/patch-4c-w13-booking.js from n8n/snippets/ai-receptionist.js - do not edit by hand.\n// Slice 4C: W13 books, cancels and moves appointments only through the FLOW HQ booking API (docs/booking-api.md); no Cal.com links; no direct Grist writes.\n${c}`;
}

module.exports = { transformSnippet, buildContextNode, planReadyNode, standalone, replaceOnce };
