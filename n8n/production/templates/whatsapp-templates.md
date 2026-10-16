# WhatsApp templates

Nothing is sent to a patient until these exist and are **approved by Meta** in the clinic's WhatsApp Business Account, under exactly these names and in the language set by `FLOWHQ_WA_TEMPLATE_LANGUAGE` (default `en`). The machine-readable list is `whatsapp-templates.json`; a test (`tests/templates.test.js`) checks that it matches what W12 sends. Variables are filled in the order of the table; Meta does not allow line breaks, tabs or runs of spaces inside a variable (W12 cleans them).

Categories are a proposal: Meta decides and may re-classify (marketing templates cost more and need the person's opt-in). `hello_world` is Meta's sample and is **refused** by W12 unless `FLOWHQ_WA_ALLOW_HELLO_WORLD=true` (a smoke test on Meta's test number).

| Template | Category | Variables ({{1}}, {{2}}, …) | Sent by | To | Consent |
|---|---|---|---|---|---|
| `booking_confirmation` | utility | name, service, clinic_name, date, time | W4 | patient | yes |
| `reminder_24h` | utility | name, service, clinic_name, date, time | W5 | patient | yes |
| `reminder_2h` | utility | name, service, clinic_name, time | W5 | patient | yes |
| `noshow_rebook` | marketing | name, service, clinic_name, date, booking_link | W6 | patient | yes |
| `followup_day2` | marketing | name, clinic_name, booking_link | W6 | patient | yes |
| `outcome_check` | utility | name, clinic_name, service | W7 | patient | yes |
| `review_request` | marketing | name, clinic_name, review_link | W8 | patient | yes |
| `new_lead_staff_alert` | utility | clinic_name, lead_name, lead_phone, enquiry | W1, W2, W3 | staff (owner_phone) | no |
| `human_handoff_alert` | utility | clinic_name, lead_name, lead_phone, reason | W13 | staff | no |
| `weekly_owner_report` | utility | clinic_name, week, summary, action | W9 | owner | no |
| `lead_escalation` | utility | clinic_name, lead_name, lead_phone, waiting_minutes | (defined, unused today) | staff | no |

Proposed body texts are in `whatsapp-templates.json` (`body`). Review them with the clinic: wording, language, and anything that could reveal health information (the examples avoid it: a service name is the most they contain).

Free-text replies (W13 AI replies, W10 staff replies) need no template but only go out **inside 24 hours of the patient's last message**; outside that window W12 returns "blocked: outside the 24-hour window".
