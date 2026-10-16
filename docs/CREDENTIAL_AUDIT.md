# CREDENTIAL AUDIT

Generated from the selected workflow with `node n8n/final/tools/audit-credentials.js n8n/final/workflows/FlowHQ_Clinic_Automation_production_candidatefinal.json`.
The tool classifies every node **by what it calls** (Grist `/api/docs/…`, the AI provider, the website webhook, Meta, SMTP, Telegram), not by the credential's name. It never sees a credential value, and **nothing in the workflow was changed because of this audit**.

## What each credential is used for

| Credential (name, id, type) | Role of the node (what it calls) | Nodes | Which |
|---|---|---|---|
| `OpenRouter API` (`As1GpZb3W665Na7C`, httpHeaderAuth) | webhook-auth (website enquiries / Cal.com) | 1 | W1 – Webhook |
| `OpenRouter API` (`As1GpZb3W665Na7C`, httpHeaderAuth) | grist | 9 | W1 – Clinic lookup, W1 – Find lead by phone, W1 – Update lead, W1 – Recent leads, W1 – Create lead, W1 – Write Run_Log, W4 – Clinic lookup, W5 – Set sent flag, W1 – Alert settings |
| `OpenRouter API` (`As1GpZb3W665Na7C`, httpHeaderAuth) | ai-provider | 1 | W13 – Ask Model |
| `Header Auth account 2` (`9J6XxrIQoFDcQZ0Y`, httpHeaderAuth) | grist | 105 | (105 nodes) |
| `Header Auth account 2` (`9J6XxrIQoFDcQZ0Y`, httpHeaderAuth) | ai-provider | 1 | W9 – Ask Model |
| `Telegram account` (`NzFVBwmYZTH1K6L8`, telegramApi) | telegram | 1 | W11 – Telegram alert |
| `WhatsApp Cloud API` (`k01hgCFOtdH5hdiq`, httpHeaderAuth) | whatsapp-meta | 1 | W12 – Meta send |
| `SMTP account` (`bmyXSugpkTIob1iP`, smtp) | smtp | 1 | W1 – Send email |

## The finding

| | |
|---|---|
| Credential `OpenRouter API` (id `As1GpZb3W665Na7C`) | is the **authentication of the website webhook** (`W1 – Webhook`), the credential of **nine Grist nodes** (W1 ×7, `W4 – Clinic lookup`, `W5 – Set sent flag`) **and** the credential of the **W13 AI call** |
| Credential `Header Auth account 2` (id `9J6XxrIQoFDcQZ0Y`) | is the credential of 105 Grist nodes **and** of **`W9 – Ask Model`**, an AI call |

An n8n *Header Auth* credential is one header name plus one secret value. Every node that references it sends that value. Depending on what the two credentials actually contain (their values were never seen) this means one of the following:

* If `OpenRouter API` holds the **OpenRouter key**: the website webhook would have to be called with the OpenRouter key as its secret, and nine Grist nodes would send the OpenRouter key to Grist (which would refuse it). The website integration **must not** be configured that way: **never put an AI key in `N8N_WEBHOOK_SECRET`**.
* If `Header Auth account 2` holds the **Grist key**: `W9 – Ask Model` sends the Grist key to the AI provider's host whenever W9's external AI is enabled. That is a credential leak to a third party.
* If instead the names are merely stale and the values are correct for the roles (for example `OpenRouter API` really holds a Grist or webhook secret), the workflow can work, but then W13's AI call is calling OpenRouter with a non-OpenRouter secret and fails.

The most likely cause is import-time credential mapping (n8n lets you choose one existing credential per credential slot when you import a workflow that references unknown credentials), not a deliberate design.

## Intended mapping (the roles; apply in n8n, not by renaming)

| Role | Nodes | Credential type and content |
|---|---|---|
| Grist API | every node whose URL is `…/api/docs/…` (114 nodes) | Header Auth, header `Authorization`, value `Bearer <Grist API key of a service user that can edit the clinic documents>` |
| Website webhook secret | `W1 – Webhook` | Header Auth, header `X-Lead-Secret` (or any name you choose and also set in `N8N_WEBHOOK_AUTH_HEADER`), value = a long random secret **used only for this webhook** |
| AI provider | `W13 – Ask Model`, `W9 – Ask Model` | Header Auth, header `Authorization`, value `Bearer <OpenRouter key>` |
| WhatsApp Cloud API | `W12 – Meta send` | Header Auth, header `Authorization`, value `Bearer <permanent system-user token>` |
| SMTP / Telegram | `W1 – Send email` / `W11 – Telegram alert` | SMTP / Telegram credentials |

## What has to be decided by you, in n8n, before activation
1. Open credential `OpenRouter API` and read its **header name** (never its value; do not paste it anywhere). Do the same for `Header Auth account 2`.
2. For the nodes that call Grist but use `OpenRouter API` (9), the webhook (1) and `W9 – Ask Model` (1), choose the credential of the right role. Create a separate *website webhook secret* credential if none exists. n8n offers the credential dropdown inside each node; ids of existing nodes and the workflow structure do not change.
3. Then set `N8N_WEBHOOK_AUTH_HEADER` / `N8N_WEBHOOK_SECRET` in Vercel to that webhook credential's header name and value.
4. Re-run `node n8n/final/tools/audit-credentials.js <export>`: no credential should be listed as used for more than one role.

Why the repository does not "fix" this itself: the credential ids and values live only in your n8n instance. Replacing references by name (for example every `OpenRouter API` by a Grist credential) would silently break the W13 AI call, and creating new credentials here would invent ids that do not exist in your instance.
