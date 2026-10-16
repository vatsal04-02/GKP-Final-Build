# TEMPORARY quiet-hours test switch: `DISABLE_QUIET_HOURS_FOR_TEST`

**What it does**
- **`true`** (the test file): W12, W13 and W7–W10 do not apply the 21:00–08:00 IST quiet hours. Nothing else changes.
- **`false`**: the original rule applies again, exactly as before (proven minute by minute and end to end).

**Where it is.** One shared block, `n8n/snippets/quiet-hours-switch.js`, is pasted with the same value into the 7 Code nodes that
apply quiet hours in those sections:

| # | Node | What quiet hours did there |
|---|---|---|
| 1 | `W12 – Prepare request` | W12 blocked every send ("quiet hours (21:00-08:00 IST)") |
| 2 | `W13 – Build Context` | the night gate: the patient's message was deferred to the 08:05 run |
| 3 | `W13 – Plan Ready` | W13's send guard (decideSend) for the reply and the staff alert |
| 4 | `W7 – Decide send` | the check-in waited for the morning |
| 5 | `W8 – Decide send` | the review request waited for the morning |
| 6 | `W9 – Owner message` | the owner copy was not sent at night |
| 7 | `W10 – Check` | a staff reply waited until 08:00 |

No other node changed. Nodes added / removed: 0. Connections: 0 changed. Credentials, webhooks, Config values (secrets), Meta,
Cal.com, OpenRouter, Grist schema: 0 changed. W3, W4, W5 and W6 keep their quiet hours; they were not in the request.

**How it works.** The original `inQuietHours()` stays in every node, unchanged. So do `decideSend()`'s quiet-hours step, W12's
quiet-hours block and W13's night gate. The switch only wraps `inQuietHours()`:

    const DISABLE_QUIET_HOURS_FOR_TEST = true;
    const originalInQuietHours = inQuietHours;
    inQuietHours = (nowMs) => (DISABLE_QUIET_HOURS_FOR_TEST ? false : originalInQuietHours(nowMs));

With `true`, only the quiet-hours step answers "not quiet". These are unchanged and tested at night:
- TEST_MODE;
- STOP / opt-out;
- Needs_Human;
- the emergency hand-off;
- duplicate protection;
- sent flags;
- Automation_Paused;
- the W12 allowlist;
- the 24 h window.

**Turning it off when testing is done**
- **Either** run `node n8n/integrated/apply-quiet-hours-switch.js --in <your exported workflow> --out <file> --value false --keep-private` and import the result.
- **Or**, in n8n, change `const DISABLE_QUIET_HOURS_FOR_TEST = true;` to `false` in the 7 nodes above.

Why 7 copies and not one switch: n8n Community Edition has no workflow-wide variable. `$vars` needs an Enterprise licence, and
recent n8n blocks `$env` in Code nodes by default. Code nodes cannot share code either. The script changes all 7 at once and
refuses a file where they disagree. `validate-quiet-hours-switch.js` checks that only these blocks differ.

**Note while it is on:** an emergency alert written at night now goes out immediately instead of at 08:05. This is part of
switching quiet hours off.

## Tests (`quiet-hours-switch.test.js`, 17 / 17; identical on your private file)

| # | Case | Result |
|---|---|---|
| A | W13 at 22:00 / 03:00 / 07:59, switch TRUE | **not deferred**: the AI answers at once, the reply goes through W12 |
| B | W12 manual send at 22:00, switch TRUE | **sent** (hello_world, Meta called once); a W7 message at 23:20 also sent |
| C | W13 at 21:00 / 22:00 / 03:00 / 07:59, switch FALSE | **deferred**; CRM, sends and AI calls byte-identical to the workflow without the switch; the 08:05 run answers it |
| D | W12 at 20:59 / 21:00 / 03:00 / 07:59 / 08:00, switch FALSE | sends / blocked "quiet hours (21:00-08:00 IST)" / blocked / blocked / sends, **identical to before** |
| E.1–E.7 | STOP, Needs_Human, emergency, duplicates, TEST_MODE, allowlist + 24 h window, Automation_Paused + sent flags, at night with the switch on | all still work |
| F | W7 / W8 / W9 / W10 at night | switch TRUE: sent through W12; FALSE: identical to before |
| G | daytime | TRUE, FALSE and the workflow without the switch behave identically |
| H | W3 / W4 / W5 / W6 | untouched; a W5 reminder at 22:00 is still held |
| R.1 | every existing suite, switch FALSE | all pass, as before |
| R.2 | every existing suite, switch TRUE | only the 7 existing quiet-hours checks change, nothing else |
| U.1 | the switch itself | FALSE = the original rule for all 2,880 minutes of 2 days; one value in all 7 nodes |

The patcher is fingerprint-checked; flipping ON → OFF → ON gives a byte-identical file. `validate-quiet-hours-switch.js` passes
9 / 9 check groups on the public and private files.
