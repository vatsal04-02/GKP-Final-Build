# ARCHITECTURE

## One workflow, many sections

FlowHQ Clinic Automation is **one n8n workflow** (`FhqClinicProd001`). Every trigger starts only its own section; sections are not chained. WhatsApp leaves through exactly one place, W12.

```
                         INTERNET
 website form ──POST──┐   Meta ──POST/GET──┐   Cal.com ──POST──┐
 (Header Auth)        │   (X-Hub-Signature)│   (HMAC raw body) │
                      ▼                    ▼                   ▼
                 ┌─────────── Caddy (HTTPS): ONLY /webhook/*  is public ───────────┐
                 └──────────────────────────────┬──────────────────────────────────┘
   editor: N8N_ADMIN_DOMAIN, IP-restricted ─────┤
                                                ▼
 ┌────────────────────────────── n8n  (ONE workflow) ───────────────────────────────────────────┐
 │ W1 website lead ─┐                                                                          │
 │ W2 inbound + receipts ─┤ (W2 → W13 AI receptionist, only if external AI is enabled)          │
 │ W4 Cal.com ──────┤                                                                          │
 │ W3 speed-to-lead │      every send:   Execute Workflow ──►  W12  WhatsApp sender            │
 │ W5 reminders ────┤                                          │ send_mode / allowlist         │
 │ W6 follow-ups ───┤                                          │ template policy               │
 │ W7 W8 W9 W10 ────┘                                          │ quiet hours 21:00–08:00 IST   │
 │ W14 reconcile (every 15 min)                                │ consent gate (patient templates)
 │ W11 error alert (Error Trigger) ──► Telegram                │ SEND LEDGER claim ──► Meta ──► ledger result
 └───────────────┬───────────────────────────────────────────┴───────────────┬─────────────────┘
                 │ Grist REST (internal network)                              │ Graph API (https)
                 ▼                                                            ▼
     Grist: Agency Registry (Clinics) + one document per clinic         Meta WhatsApp Cloud API
     (LEADS, Appointments, Conversations, Messages, Settings,           (delivery receipts come back to W2)
      Knowledge, Run_Log, Send_Ledger)
```

Optional outbound: SMTP (staff e-mail from W1; Mailpit in staging), an AI provider (W13, W9 — **off** unless `FLOWHQ_AI_EXTERNAL_ENABLED=true`), Telegram (W11).

## Multi-clinic isolation

Every section starts by reading the **Agency Registry** (table `Clinics`): a clinic is found by its slug (W1, W4) or by the WhatsApp `phone_number_id` the message arrived on (W2, receipts) and is only used when `Active`. Each clinic has its **own Grist document**; every read and write — including the send ledger and the consent check — uses that clinic's `doc_id`. No clinic is hard-coded. The test `w14.test.js` proves a ledger / consent decision in clinic A never touches clinic B. Limits: one n8n and one Meta app serve all clinics; one **timezone** (IST: quiet hours and calendar logic are fixed to UTC+5:30 in the code) — a clinic in another timezone is not supported; `Lead_id` numbers are per clinic.

## The send path (W12)

1. The caller's guard decides `decision {send, to, reason, test_mode}` (Opted_Out, Automation_Paused, quiet hours, TEST_MODE → TEST_PHONE, sent flag).
2. W12 **Config Guard** (mode allowlist | live | off, allowlist, Graph version, base URL).
3. **Prepare**: template known and not `hello_world`; variables non-empty; recipient valid (E.164); `idem_key` present (or derivable); allowlist; quiet hours; 24 h window for free text.
4. **Consent gate** (patient template, not TEST_MODE): `LEADS.Consent_WhatsApp` true and not `Opted_Out`.
5. **Send ledger**: look up `idem_key` in `Send_Ledger`; any row except `rejected` / `duplicate` ⇒ answer `duplicate`, Meta is **not** called. Otherwise insert a `sending` row, read back, **lowest row id wins**; a loser marks its row `duplicate` and does not send. Grist unavailable ⇒ `blocked`, nothing sent.
6. **Meta call** (15 s, no retry, `neverError`) with `biz_opaque_callback_data = fhq:<idem_key>`.
7. **Classify**: `accepted` (message id) | `rejected` (Meta refused / unreachable: may be retried) | `uncertain` (no clear answer: **never** re-sent, **never** reported sent).
8. **Ledger result** written on the claimed row; Grist inbox log for patient messages.
9. Return: `sent`, `uncertain`, `duplicate`, `idem_key`, `send_status`, …

```
Send_Ledger.Status:  sending ─► accepted ─► delivered ─► read
                        │           └────────► failed        (delivery receipt, W2)
                        ├─► uncertain ─► (receipt: accepted/delivered/read/failed) | unconfirmed (24 h, W14)
                        ├─► rejected      (Meta refused: a later attempt is allowed)
                        └─► duplicate     (lost the claim race)
 W14 (15 min): sending older than 15 min ─► uncertain (a person looks, nothing is re-sent)
```

Callers set their "sent" flag when W12 **handled** the message (sent, uncertain or duplicate) — so a lost flag write or an unclear answer can never cause a second message.

## Webhook contracts

| Path | Authentication | Answers |
|---|---|---|
| POST `/webhook/website-lead` | n8n Header Auth (`X-Lead-Secret`) | 200 `{status: ok|duplicate}` · 400 `{status: invalid, error}` · 404 unknown clinic · 500 Grist failure |
| GET `/webhook/whatsapp-inbound` | `hub.verify_token` = `FLOWHQ_META_VERIFY_TOKEN` | 200 challenge · 403 |
| POST `/webhook/whatsapp-inbound` | `X-Hub-Signature-256` HMAC-SHA256 of the **raw** body with `FLOWHQ_META_APP_SECRET`, mode fixed to *enforce* | 200 (after parsing; processing continues; duplicates harmless) · 401 |
| POST `/webhook/cal?clinic=<slug>` | `X-Cal-Signature-256` HMAC-SHA256 hex of the **raw** body with `FLOWHQ_CAL_WEBHOOK_SECRET`; replay window `createdAt` ± `FLOWHQ_CAL_MAX_AGE_HOURS` | 200 ok/ignored · 401 · 422 · 404 · 500 |

W2 answers Meta 200 right after parsing (Meta needs a fast answer and retries on failure); the processing is idempotent on `WA_Message_ID`. W1 and W4 answer **after** the data is stored.

## Data stores and retention

| Where | Holds | Retention |
|---|---|---|
| Grist (per clinic) | leads, conversations, messages, appointments, consent, Send_Ledger, Run_Log | the clinic's decision; Send_Ledger holds no phone number and no text |
| n8n database (volume `data/n8n`) | workflow, encrypted credentials, **failed** executions (which contain the request that failed) | successes are **not** stored; failures 7 days / max 5000 |
| Caddy logs / container logs | access logs, n8n log | docker `json-file` max 10 MB × 5 per service |
| Backups | encrypted archive of n8n data, Grist data, key file, `.env` | `BACKUP_KEEP_DAYS` (14), copy off the server |
| AI provider (if enabled) | masked patient messages / weekly numbers | the provider's terms: see PRIVACY.md |

## Trust boundaries and secrets

* Secrets are never in the workflow file: environment variables (settings read by Config nodes) and n8n credentials (created by `scripts/create-credentials.js`, stored encrypted with the key in `secrets/n8n_encryption_key`).
* The n8n container receives only the `FLOWHQ_*` settings the workflow reads — not the Grist API key, WhatsApp token, SMTP password, AI key or backup passphrase (those are credentials, used through n8n's credential store).
* `N8N_BLOCK_ENV_ACCESS_IN_NODE=false` is **required** (the workflow reads `$env`); with n8n's default it fails closed (tested). Consequence: anyone who can edit workflows in the editor can read those variables — keep editor access to the owner(s) and on the IP-restricted host.
