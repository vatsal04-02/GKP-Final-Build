# CREDENTIAL AUDIT (by node name and credential type)

Generated with `node n8n/final/tools/audit-credentials.js <workflow.json>` (add `--check` to fail on any credential that serves more than one role).
The tool classifies every node **by what it calls** (Grist `/api/docs/…`, the AI provider, the website webhook, Meta, SMTP, Telegram), never by the credential's name, and never sees a credential value. No secret value was read, printed, written or committed for this audit or for the changes it led to.

## 1. As supplied (`n8n/final/workflows/history/…as-supplied.sanitized.json`): two credentials served several roles

| Credential (name, id) | Role of the node | Nodes | Which |
|---|---|---|---|
| `OpenRouter API` (`As1GpZb3W665Na7C`) | webhook-auth | 1 | W1 – Webhook |
| `OpenRouter API` (`As1GpZb3W665Na7C`) | grist | 9 | (9 nodes) |
| `OpenRouter API` (`As1GpZb3W665Na7C`) | ai-provider | 1 | W13 – Ask Model |
| `Header Auth account 2` (`9J6XxrIQoFDcQZ0Y`) | grist | 105 | (105 nodes) |
| `Header Auth account 2` (`9J6XxrIQoFDcQZ0Y`) | ai-provider | 1 | W9 – Ask Model |
| `Telegram account` (`NzFVBwmYZTH1K6L8`) | telegram | 1 | W11 – Telegram alert |
| `WhatsApp Cloud API` (`k01hgCFOtdH5hdiq`) | whatsapp-meta | 1 | W12 – Meta send |
| `SMTP account` (`bmyXSugpkTIob1iP`) | smtp | 1 | W1 – Send email |

* `OpenRouter API` was the authentication of the **website webhook**, of **nine Grist nodes** (W1 ×7, `W4 – Clinic lookup`, `W5 – Set sent flag`) **and** of the W13 AI call.
* `Header Auth account 2` was the credential of 105 Grist nodes **and** of `W9 – Ask Model`, an AI call (it would have sent the Grist key to the AI provider's host).

## 2. Now (`n8n/final/workflows/FlowHQ_Clinic_Automation_production_candidatefinal.json`): one role per credential

| Credential (name, id) | Role of the node | Nodes | Which |
|---|---|---|---|
| `FlowHQ W1 Webhook Auth` (`FhqCredW1Hook001`) | webhook-auth | 1 | W1 – Webhook |
| `Header Auth account 2` (`9J6XxrIQoFDcQZ0Y`) | grist | 114 | (114 nodes) |
| `Telegram account` (`NzFVBwmYZTH1K6L8`) | telegram | 1 | W11 – Telegram alert |
| `WhatsApp Cloud API` (`k01hgCFOtdH5hdiq`) | whatsapp-meta | 1 | W12 – Meta send |
| `OpenRouter API` (`As1GpZb3W665Na7C`) | ai-provider | 2 | W13 – Ask Model, W9 – Ask Model |
| `SMTP account` (`bmyXSugpkTIob1iP`) | smtp | 1 | W1 – Send email |

What changed (16 nodes, references only; applied by `n8n/final/tools/apply-openrouter-config.js`, which proves nothing else moved):

| Role | Nodes | Credential reference now | Was |
|---|---|---|---|
| Website webhook authentication | `W1 – Webhook` | `FlowHQ W1 Webhook Auth` (`FhqCredW1Hook001`, type httpHeaderAuth) **: a credential that does not exist yet in your n8n; create it (docs/OPENROUTER.md §3)** | `OpenRouter API` |
| Grist | the 9 Grist nodes that used `OpenRouter API`: `W1 – Clinic lookup`, `W1 – Find lead by phone`, `W1 – Update lead`, `W1 – Recent leads`, `W1 – Create lead`, `W1 – Write Run_Log`, `W1 – Alert settings`, `W4 – Clinic lookup`, `W5 – Set sent flag` | `Header Auth account 2` (`9J6XxrIQoFDcQZ0Y`): the credential the other 105 Grist nodes already use | `OpenRouter API` |
| OpenRouter (AI) | `W9 – Ask Model` | `OpenRouter API` (`As1GpZb3W665Na7C`): the credential `W13 – Ask Model` already used | `Header Auth account 2` |
| OpenRouter (AI) | `W13 – Ask Model` | `OpenRouter API` (unchanged) | same |
| WhatsApp, SMTP, Telegram | `W12 – Meta send`, `W1 – Send email`, `W11 – Telegram alert` | unchanged | same |

This was decided **by role (what the node calls)**, not by name: no `replace all`. Credentials were not renamed and no credential id other than the new website-webhook one was introduced.

## 3. Assumption you must verify in n8n (values are never needed here)
The assignment treats `Header Auth account 2` as the **Grist** credential (it already serves 105 of the 114 Grist nodes, which is the only evidence available) and `OpenRouter API` as the **OpenRouter** credential (its name and `W13 – Ask Model`). Open each in n8n and confirm the header **name** (never paste the value anywhere): both should be `Authorization`, with a value of the form `Bearer <key>`: the Grist key for `Header Auth account 2`, the OpenRouter key (`sk-or-v1-…`) for `OpenRouter API`. If they are the other way round, swap the credential in the 11 listed nodes inside n8n (the tool's role table above is what to follow).

## 4. Guard rails now in place
* `node n8n/final/tools/audit-credentials.js <export> --check` exits 1 when any credential serves two roles (also run by `n8n/final/tests/final.test.js` and `n8n/production/tests/openrouter.test.js`).
* The simulator refuses an AI call that carries a Grist credential and a Grist call that carries the OpenRouter credential (tested).
* The website function refuses to start with a webhook secret that looks like an OpenRouter key (`sk-or-…`) or equals `OPENROUTER_API_KEY` (tested).
* The workflow reads no API key from the environment: `$env` names are all `FLOWHQ_*` settings; keys live only in n8n credentials.
