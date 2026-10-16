# Booking form → clinic CRM (how it works, how to test it safely)

```
browser form ── POST /api/enquiry (JSON) ──► Vercel Function api/enquiry.mjs ── POST + header secret ──► n8n webhook /website-lead (W1) ──► Grist LEADS
   (no secrets in the browser)                 validates, de-duplicates, times out                      stores the lead, then the existing alert / consent rules
```

* The browser never sees the n8n URL or the secret. Both live in server-only Vercel environment variables (`.env.example` lists them).
* The form says "request received", never "confirmed". If sending fails the form keeps what was typed and offers "Send this request on WhatsApp instead" plus the phone link.
* The WhatsApp checkbox is optional. Unticked = the enquiry is still stored, with the consent flag `false`.

## Environment (server-only)
`N8N_WEBHOOK_URL`, `N8N_WEBHOOK_SECRET`, `N8N_WEBHOOK_AUTH_HEADER` (default `X-Lead-Secret`), `CLINIC_SLUG`, optional `ALLOWED_ORIGINS`, `N8N_TIMEOUT_MS`.
Without them `/api/enquiry` answers 503 "unavailable" and the visitor is offered WhatsApp / phone (nothing is lost silently).

## Checks that ran on this branch
`npm run build` · `npm run check` (0 errors) · `npm test` (18 API/unit tests, synthetic data, fake n8n) · `node tests/e2e/booking-browser.mjs` (11 browser checks in Chromium, optional: needs Playwright).

## Safe first live test (do NOT do this before the clinic approves the wording)
1. In n8n, keep the settings of a controlled test: `FLOWHQ_WA_SEND_MODE=off`, `FLOWHQ_ALERT_EMAIL_TO` empty, `FLOWHQ_AI_EXTERNAL_ENABLED=false`.
2. Use a **Vercel Preview** deployment, not production. Set `N8N_WEBHOOK_URL` to the n8n **test** URL (`.../webhook-test/website-lead`), click "Listen for test event" in the n8n editor, then submit one form with a made-up name and a number you own.
3. Check: one new row in Grist LEADS (consent flag as ticked), one `W1-website-lead` row in Run_Log, no WhatsApp/e-mail sent.
4. Only then, with the clinic's approval, move to the production webhook URL and the production deployment.
