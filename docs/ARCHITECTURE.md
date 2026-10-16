# ARCHITECTURE

```
 Visitor ─► apps/clinic-website (Astro, static, Vercel)
              booking form ── POST /api/enquiry ──► api/enquiry.mjs (Vercel Function, server-side secrets)
                                                     checks Origin, JSON, size, honeypot, rate limit; validates (shared rules)
                                                     forwards { clinic_slug, name, phone, enquiry, consent_whatsapp, consent_version, … }
                                                     with header [N8N_WEBHOOK_AUTH_HEADER]: N8N_WEBHOOK_SECRET, timeout N8N_TIMEOUT_MS
                                                              │
                                                              ▼
 n8n (Docker; Caddy in front)   POST /webhook/website-lead  (W1, header auth, "respond after store")
        W1: registry lookup (Clinics, by clinic_slug) → clinic doc → find lead by PHONE → update (append, never overwrite) | create
            [proposed] re-read after create: oldest row wins, a loser deletes only its own row
            → Run_Log → staff alert via W12 (send mode off | allowlist | live) → optional staff e-mail (SMTP)
        W2  WhatsApp inbound (Meta signature, raw body, dedupe on message id)          → Messages / Conversations → W13
        W13 AI receptionist: gates (opt-out, pause, human hand-off, emergency, quiet hours, AI switch) → AI only to *propose*; W12 sends
        W3 speed-to-lead · W4 Cal.com booking sync · W5 reminders · W6 follow-ups · W7 outcome check · W8 reviews · W9 weekly report
        W10 staff replies from the Grist inbox · W11 error alert · W12 the ONLY WhatsApp sender · W14 reconcile (uncertain sends)
                                                              │
                                                              ▼
 Grist (existing CRM, system of record): Agency Registry (Clinics) + one document per clinic:
        LEADS, Conversations, Messages, Appointments, Settings, Knowledge, Run_Log, Send_Ledger
                                                              ▲
 Staff ─► flowhq/ (React + Hono BFF; the Grist API key stays on the server) ─┘
```

## Invariants (each is a tested rule, see `docs/TESTING.md`)
1. WhatsApp consent is separate from submitting an enquiry. An enquiry is stored with `Consent_WhatsApp=false` when the box is unticked; W12 sends **no template to a patient without consent**.
2. Every patient-facing message passes W12: consent, opt-out, pause, quiet hours 21:00–08:00 IST, test mode, send mode, idempotency ledger (claim before the Meta call; an uncertain call is never retried automatically).
3. The website never holds an n8n URL or secret in the browser; the success message says "received", never "confirmed".
4. External AI is OpenRouter only (W13 and W9); it never sends and never computes numbers; patient identifiers are masked before any provider call; it is off unless `FLOWHQ_AI_EXTERNAL_ENABLED=true` (one switch, `docs/OPENROUTER.md`). Credentials have one role each: OpenRouter key → the two AI calls, website-webhook secret → W1's webhook, Grist key → Grist (`docs/CREDENTIAL_AUDIT.md`).
5. Configuration comes from the environment (`$env.FLOWHQ_*`); the clinic slug and registry id are never in the workflow.
6. Grist stays the database. Nothing replaces it; no patient record is stored in git.

More detail: `n8n/production/ARCHITECTURE.md` (W12 ledger, consent, templates), `docs/FIELD_MAPPING.md`, `flowhq/README.md`.
