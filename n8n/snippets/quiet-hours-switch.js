// TEMPORARY TEST SWITCH for the 21:00-08:00 IST quiet hours (CLAUDE.md rule 5), for testing at night.
//
// Where: n8n/integrated/apply-quiet-hours-switch.js pastes the block below (verbatim, the same value everywhere) into the 7 Code nodes
// that apply quiet hours in W12, W13, W7, W8, W9 and W10, right AFTER the pasted send-guard helpers and BEFORE anything uses them:
//   W12 – Prepare request · W13 – Build Context · W13 – Plan Ready · W7 – Decide send · W8 – Decide send · W9 – Owner message · W10 – Check
// The same script flips it in all 7 at once:  node n8n/integrated/apply-quiet-hours-switch.js --in <file> --out <file> --value false
//
// How: the original inQuietHours() (send-guard.js) stays in the node unchanged; this block wraps it.
//   DISABLE_QUIET_HOURS_FOR_TEST = true  -> inQuietHours() answers "not quiet hours" in that node. That is the ONLY thing that
//                                           changes: decideSend(), W12's waPrepare() and W13's aiGates() are untouched, so
//                                           TEST_MODE, STOP / opt-out, Needs_Human, emergency hand-off, duplicates, sent flags,
//                                           Automation_Paused, the W12 allowlist and the 24 h window work exactly as before.
//   DISABLE_QUIET_HOURS_FOR_TEST = false -> the original rule decides, exactly as before (every minute of the day is identical).
// W3, W4, W5 and W6 do not get this block: they keep their quiet hours either way.
//
// Not a Node module: the tests read the block between the two marker lines as text.

// ---- TEMPORARY TEST SWITCH: quiet hours (pasted from n8n/snippets/quiet-hours-switch.js - keep identical) ----
const DISABLE_QUIET_HOURS_FOR_TEST = true;   // true = skip ONLY the 21:00-08:00 IST quiet-hours check; false = the original rule
const originalInQuietHours = inQuietHours;   // the original rule from send-guard.js, unchanged
inQuietHours = (nowMs) => (DISABLE_QUIET_HOURS_FOR_TEST ? false : originalInQuietHours(nowMs));   // eslint-disable-line no-func-assign
// ---- end of the test switch ----
