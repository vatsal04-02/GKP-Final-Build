# FLOW HQ: the universal automation OS

FLOW HQ is the front end for the agency's automations. It is **not a clinic dashboard**. It is one product: a dashboard, inbox, contacts, bookings, automations, tasks, reports, activity, AI workspace and settings.

Each workspace gets two things from configuration:

- **Industry profile:** the words, default modules and dashboard metrics.
- **Backend adapter:** the data, plus what the backend can actually do.

The first adapter is the existing **Clinic Autopilot** backend (Grist CRM + n8n workflows W1 to W13 + WhatsApp Cloud API). It works today, unchanged. Switching a workspace from Clinic to Salon, Agency or Real Estate changes the words and the modules. The design stays the same.

```
 Browser (React)                    FLOW HQ server (Node, one process)                      Existing backend (unchanged)
 ┌──────────────────────┐  /api    ┌───────────────────────────────────────────┐  REST     ┌───────────────────────────────┐
 │ Universal UI         │ ───────▶ │ API / BFF (Hono): sessions, roles, CSRF   │ ───────▶  │ Grist: Clinics registry,      │
 │  pages, components   │  cookie  │  ├─ Industry config + terminology (core)  │  API key  │  Settings, LEADS, Appointments│
 │  terminology tokens  │          │  ├─ Domain model (core)                   │  stays    │  Conversations, Messages,     │
 │  no backend names    │          │  └─ Backend adapters                      │  here     │  Run_Log, Knowledge           │
 └──────────────────────┘          │      └─ autopilot (Grist + n8n)           │           │ n8n W1–W13 ── W12 ──▶ WhatsApp│
                                   │          uses n8n/snippets (W9/W10 code)  │           └───────────────────────────────┘
                                   └───────────────────────────────────────────┘
```

**Rules kept:**
- **W12 is still the only component that sends WhatsApp messages.** A staff reply goes Inbox → FLOW HQ → a `Messages` row with `Send=true` → W10 → W12 → WhatsApp.
- **The browser never calls OpenRouter, Grist, n8n or Meta.** It only calls its own `/api` (a test enforces this).
- **W13 stays the AI engine.** The AI page reads its decisions and does not run a model.
- **Cal.com stays the source of truth.** FLOW HQ only marks *Completed / No-show*, which is the one thing the booking system cannot know. It never offers times.
- **W9 stays the report engine.** Analytics are computed by the same `cmWeeklyMetrics` code that the n8n node runs, loaded from `n8n/snippets`.
- **No workflow, credential, webhook, Grist schema or n8n file was changed.** The n8n regression suite still passes (45/45 files).

---

## A. Frontend (`src/web`)

React 18 + React Router + TanStack Query + Tailwind (colours as CSS variables) + lucide icons. Pages are lazy-loaded. **A page exists only if its module is enabled for the workspace and the backend can power it.**

| Page | What it does |
|---|---|
| **Dashboard** | Greeting, range (Today / 7 / 30 days). Metric cards chosen by the industry profile, with sparklines and comparison with the previous period. Conversations chart (incoming, handled by AI, handed to a person). Needs attention, upcoming bookings, recent activity. |
| **Inbox** | Conversation list with filters and counts (All, Unread, Attention, AI, Paused, Mine) and search. Thread with day separators, author (contact, AI, team, automation), send status, and AI decision chips (intent, action, confidence, reason). **Composer blocked** for opted-out contacts and when the 24-hour reply window has closed. Hold reasons are shown (e.g. *waiting: quiet hours*). Take it, Pause / Resume automations, Mark handled. Context panel. |
| **Contacts** | Table with the columns the backend stores (no empty fake columns). Filters: status, stage, needs attention. Drawer with editable status, owner, next action and notes (as allowed by capabilities), plus bookings and a timeline. |
| **Bookings** | Upcoming / Needs outcome / Past / All, grouped by day. *Source of truth* banner. Mark completed / no-show (past, scheduled only). Source (booking system or booked in chat), value for admins, and the automations already done (reminders, check-in, review). |
| **Automations** | Cards named by outcome, not workflow number. Each shows status, description, trigger, last run, next run, runs today, 7-day success rate, errors, skipped, requirements and last error. **Enable / disable only where the backend has a real switch.** The others show *Always on*. The workflow reference is shown small, for support. |
| **Tasks** | Derived live (there is no task table): replies owed, failed replies, first replies, follow-ups due, booking outcomes. Outcomes can be marked inline. |
| **Reports** | *Overview*: analytics by category for last week or this week, from the weekly-report engine. *Weekly reports*: the stored W9 reports, as written. |
| **Activity** | One timeline grouped by day, filtered by group or kind, or by one contact. |
| **AI** | Mode (Off / Draft / Auto), last-7-day numbers, intents, stages, hand-offs waiting, recent decisions with the reason for each, and the knowledge base (add, edit, switch off). |
| **Settings** | Workspace (name, industry, **modules**), Branding (logo, theme), **Terminology** (rename any noun, with a live preview), Team, Channels, AI, Automations, Notifications, Business hours, Integrations. Each section shows only settings that really exist in the backend. **Keys and tokens are never shown.** |

**UX details:**
- Command palette (`Ctrl/⌘ K`): pages, contacts, conversations, workspaces, theme.
- Shortcuts: `g d / g i / g c / g b / g a / g t / g r / g y / g x / g s`.
- Skeletons on every load, empty and error states on every list, toasts.
- Dark mode (the signature look) and light mode.
- Reduced-motion support, ARIA roles on tabs, switches, dialogs and listboxes.
- Works at phone width with no sideways scroll.

**Theme:** black + blue, from the palette in `src/web/styles.css`.
- Backgrounds `#05070B / #080B12`; surfaces `#0D111A / #111722`; elevated `#151C28`; borders `#1D2735`.
- Primary blue `#1677FF → #3B8DFF` gradient; soft blue `#7DB2FF`.
- AI elements are blue (sparkle, blue dot, confidence bar, blue-tinted cards). Hand-offs are amber, urgent is red. Green and red appear only for comparisons and status.
- Motion is 150 to 250 ms.

Main files:
- `src/web/App.tsx`: routes from modules.
- `lib/workspace.tsx`: `useWs()` gives `t`, `tt`, `automation()`, `metric()`, `has()`.
- `lib/api.ts`: the only network code.
- `components/layout`: shell, sidebar, palette.
- `components/ui`: primitives and feedback.
- `components/data`: charts and widgets.
- `pages/*`.

## B. API / BFF (`src/server`)

One Node process (Hono) serves `/api` and the built web app. All responses are JSON `{error:{code,message}}` on failure, `Cache-Control: no-store`.

| Route | Who | Notes |
|---|---|---|
| `GET /api/health` | anyone | backend reachable, demo flag |
| `POST /api/auth/login`, `POST /api/auth/logout` | anyone | scrypt passwords, HMAC-signed `fhq_session` cookie (HttpOnly, Secure, SameSite=Lax, 12 h), 10 failures / 15 min limit |
| `GET /api/me` | signed in | user, the workspaces they may open, industries |
| `GET /api/w/:ws/workspace` | member | resolved profile: terminology, modules, automations, metrics, capabilities |
| `PATCH /api/w/:ws/profile` | admin | industry, display name, logo (https), terminology overrides, modules |
| `GET /api/w/:ws/dashboard?days=` | member | metrics + previous period, series, attention, upcoming, recent |
| `GET /api/w/:ws/contacts`, `GET/PATCH …/contacts/:id` | member | status, owner, notes, next action |
| `GET /api/w/:ws/conversations?filter=&q=`, `GET …/:id` | member | thread + contact |
| `POST /api/w/:ws/conversations/:id/reply` | member | writes the W10 Send row; 409 `opted_out` / `window_closed` |
| `PATCH /api/w/:ws/conversations/:id` | member | assignedTo, automationPaused, resolveAttention, markRead |
| `GET /api/w/:ws/bookings?view=`, `PATCH …/:id` | member | only `completed` / `no_show`, only past scheduled bookings |
| `GET /api/w/:ws/automations`, `PATCH …/:key` | member / admin | switch only where the backend has one |
| `GET /api/w/:ws/tasks`, `activity`, `reports`, `analytics?week=`, `ai` | member | |
| `GET/POST /api/w/:ws/knowledge`, `PATCH …/:id` | member / admin | |
| `GET/PATCH /api/w/:ws/settings` | member / admin | validated (phones `+91…`, https links, HH:MM, on/off) |

**Security:**
- CSRF header `x-flowhq-csrf: 1` on every state change.
- Strict CSP and `X-Frame-Options: DENY`.
- Workspace access list per user. Admin-only writes are enforced on the server.
- The backend's own error text stays in the server log; the browser gets a status only.
- Revenue (`Fee_INR`) is shown to admins only.
- Sensitive phone settings are masked for staff.

## C. Universal domain model (`src/core/domain.ts`)

These types are what every screen uses. No screen knows the backend.
- `Workspace`, `Capabilities`
- `Contact`, `Booking`, `Conversation`, `Message` (author kind, send status, AI decision block)
- `Automation`, `Activity`, `Task`, `MetricValue`, `Dashboard`, `Analytics`, `Report`
- `AiOverview`, `KnowledgeItem`, `SettingField`, `SettingsView`

`Capabilities` is how the UI avoids inventing features. It lists:
- channels and whether staff can reply, and the reply window;
- the contact fields that really exist and which ones are editable;
- the booking statuses staff may set, and the booking system that is the source of truth;
- whether the viewer may see revenue, edit settings or edit knowledge.

## D. Industry configuration (`src/core/terminology.ts`, `src/core/industries`, `src/core/registry.ts`)

- **Terminology** is the one place business words come from. Screens write templates: `tt('New {contact.plural|lower}')`, `t('booking.singular')`, `{booking.singular|a}` ("an appointment"), `{contactStage.hot}`, `{outcome.better}`.
- **14 industry profiles:** clinic, physiotherapy, salon, spa, gym, consultant, agency, real estate, coaching, education, local services, home services, professional services, custom. Each sets the nouns (contact, booking, service, staff, workspace), the AI's name, the status, stage, booking-status and outcome words, automation names, default modules and dashboard metrics.
- **Registries** hold every page, automation, metric, analytics category, activity and task kind, with label templates.
- **Resolution:** a workspace's modules = industry defaults + workspace enables − workspace disables, then **only what the backend supports**. Core modules are always on. Its automations and dashboard metrics follow its modules.
- **Workspace overrides** (industry, name, logo, renamed words, modules) are saved by Settings into `config/workspaces.json`. This is FLOW HQ presentation config, not backend data.

Example: physiotherapy says *Patients / Appointments / AI Receptionist*. Salon says *Clients / Appointments / AI Front Desk*. Agency says *Prospects / Meetings / AI Sales Assistant*. Real estate says *Leads / Site visits / AI Lead Assistant*.

## E. The current clinic adapter (`src/server/adapters/autopilot`)

- `schema.ts` covers the real backend:
  - tables and columns (`grist/schema.md` + the live export; `LEADS` is the live table name, configurable);
  - status maps;
  - the 24 h − 5 min reply window (as W10/W12 apply it);
  - which workflow writes what (`Sent_By`, `Run_Log.Workflow` names);
  - each automation's trigger and schedule;
  - the per-workspace switches that exist (`ai_mode`, `outcome_checkin`, `review_requests`, `weekly_report_whatsapp`);
  - every Settings key the workflows read.
- `mappers.ts` turns rows into the domain model:
  - Lead → Contact: `Lead_Stage` → stage, `Likely_Service` → interest, `AI_Summary`, `Next_Action_At` → next action, `Needs_Human` → attention, `Opted_Out`.
  - Appointment → Booking: a `wa-` UID means booked in chat; `R24_Sent` and similar flags become *automations done*.
  - Conversation and Message: author from `Sent_By`, send status from `Send` / `WA_Message_ID` / `Status`, AI block from the `AI_*` columns.
  - Run_Log becomes activity.
  - The W9 report text is parsed into sections.
  - Notes written for a clinic ("the patient's…") are shown in the workspace's own word.
- `index.ts` handles:
  - the registry lookup (`Clinics`: slug → doc id, never exposed);
  - caching;
  - capabilities and the dashboard;
  - write rules: reply checks, booking outcomes, switches, settings validation and phone normalisation via `normalize-phone.js`;
  - automations stats from `Run_Log`;
  - derived tasks;
  - analytics via `cmWeeklyMetrics`, the AI overview and knowledge.
- `shared.ts` loads `n8n/snippets` (`clinic-modules.js`, `normalize-phone.js`, `send-guard.js`) as-is.
- **Demo mode** (`FLOWHQ_DEMO=true`) runs this same adapter against an in-memory Grist with three fictional businesses (physio, salon, real estate; `+91 90000…` test numbers). A simulator plays W10 using **W10's own functions** (`cmStaffReplyCheck` / `cmStaffReplyResult`), including the quiet-hours hold. Nothing is sent anywhere.

## F. Workflow-to-UI mapping

Names shown are for the physiotherapy profile; other industries rename them.

| n8n | Universal automation | Name in the UI (physio) | Where it shows up | Switch in FLOW HQ |
|---|---|---|---|---|
| W1 website lead | `contact_capture` | Website Enquiries | Contacts (Source, Enquiry, campaign), Activity *New patient* | none (always on) |
| W2 WhatsApp inbound | `inbound_messaging` | Inbound Messages | Inbox (incoming messages, unread), Activity | none |
| W3 speed-to-lead | `speed_to_lead` | Speed to Lead | Activity *Team alerted*, Tasks *Waiting for a first reply* | none |
| W4 booking sync (Cal.com) | `booking_sync` | Appointment Sync | Bookings (created / rescheduled / cancelled), Activity | none: Cal.com is the source of truth |
| W5 reminders | `booking_reminders` | Appointment Reminders | Booking chips *Day-before / Same-day reminder*, metric *Reminders* | none |
| W6 follow-ups | `follow_ups` | Follow-ups | Booking chip *New time offered*, metric *Follow-ups*, Activity | none |
| W7 outcome check-in | `outcome_checkins` | Outcome Check-ins | Booking chip *Check-in sent*, Reports > feedback | `outcome_checkin` on/off |
| W8 review request | `review_requests` | Review Requests | Booking chip *Review requested*, requirement *Review link set* | `review_requests` on/off |
| W9 weekly report | `weekly_reports` | Weekly Reports | Reports (stored text + analytics from the same code) | `weekly_report_whatsapp` (owner copy) |
| W10 staff reply | `staff_reply` | Team Replies | Inbox composer → `Messages` Send row → W10 | none |
| W11 error trigger | `error_alerts` | Error Alerts | Automations card (it writes no Run_Log rows, so no counts) | none |
| W12 messaging gateway | (the only sender) | shown as "messaging gateway" | Channels, Team Replies reference `W10 → W12` | none |
| W13 AI receptionist | `ai_assistant` | AI Receptionist | AI page, Inbox decision chips, dashboard *AI handled / handoffs* | `ai_mode` off / draft / auto |

## G. Environment variables (`flowhq/.env.example`)

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `PORT` | no | 8787 | HTTP port |
| `FLOWHQ_DEMO` | no | false | demo data, no backend |
| `GRIST_BASE_URL` | yes (not demo) | | Grist URL (`http://grist:8484` inside the stack) |
| `GRIST_API_KEY` | yes (not demo) | | Grist API key. Server only; never sent to the browser or logged |
| `GRIST_REGISTRY_DOC_ID` | yes (not demo) | | Agency Registry doc (table `Clinics`) |
| `GRIST_LEADS_TABLE` | no | LEADS | leads table name |
| `FLOWHQ_TIMEZONE` / `FLOWHQ_LOCALE` / `FLOWHQ_CURRENCY` | no | Asia/Kolkata / en-IN / INR | formatting |
| `FLOWHQ_DEFAULT_INDUSTRY` | no | clinic | industry for workspaces without a profile |
| `FLOWHQ_SESSION_SECRET` | yes (not demo) | | ≥ 32 random characters |
| `FLOWHQ_SECURE_COOKIES` | no | true (false in demo) | Secure cookie flag |
| `FLOWHQ_USERS_FILE` / `FLOWHQ_USERS` | one of them | config/users.json | users (JSON) |
| `FLOWHQ_WORKSPACES_FILE` | no | config/workspaces.json | workspace profiles |
| `FLOWHQ_STATIC_DIR` / `FLOWHQ_SNIPPETS_DIR` | no | dist/web / ../n8n/snippets | paths |

The stack's `.env` gets one more line, `FLOWHQ_DOMAIN`, used by Caddy.

## H. Setup

**Try it (demo data, no backend):**
```bash
cd flowhq
npm ci
npm run build
FLOWHQ_DEMO=true npm start          # http://localhost:8787  admin@flowhq.demo / demo1234 (or staff@flowhq.demo)
# development with hot reload: FLOWHQ_DEMO=true npm run dev  (web on :5173, API on :8787)
```

**Production, next to the existing stack:**

1. In Grist, create an API key for FLOW HQ. Best is a dedicated Grist user with access to the Agency Registry doc and the clinic docs only.
2. `cp flowhq/.env.example flowhq/.env` and fill in:
   - `GRIST_API_KEY`
   - `GRIST_REGISTRY_DOC_ID`
   - `FLOWHQ_SESSION_SECRET` (from `openssl rand -base64 48`)
3. Create the users:
   ```bash
   cd flowhq
   npm run hash-password -- "a long password"
   ```
   Paste the result into `flowhq/config/users.json`, using `config/users.example.json` as the shape. `role` is `admin` or `staff`. `workspaces` holds clinic slugs, or `["*"]` for all.
4. Add a DNS record for the FLOW HQ domain. Put `FLOWHQ_DOMAIN=…` in the stack's `.env`. The stack's root `Caddyfile` (n8n webhooks, the IP-restricted editor, Grist and FLOW HQ) already includes FLOW HQ, so no edit is needed; the overlay in step 5 does not mount any Caddyfile. Do not use `flowhq/deploy/Caddyfile`: it is obsolete and exposes the n8n editor. The block it adds, for reference:
   ```
   {$FLOWHQ_DOMAIN} {
   	encode gzip
   	reverse_proxy flowhq:8787
   }
   ```
5. From the repository root:
   ```bash
   docker compose -f docker-compose.yml -f flowhq/deploy/docker-compose.flowhq.yml up -d --build
   ```
6. Sign in. Each active row in the registry's `Clinics` table is a workspace. In **Settings > Workspace**, pick its industry. In **Settings > Terminology**, rename any words.

The image is `flowhq/Dockerfile`, built from the repository root so it includes `n8n/snippets`. Workspace profiles persist in the `flowhq_config` volume.

## I. Test results (this commit)

| Suite | Command | Result |
|---|---|---|
| Typecheck (strict, web + server + tests) | `npm run typecheck` | clean |
| Unit + adapter + API | `npm test` | **82 / 82 passed** (4 files) |
| End-to-end, real browser, demo data | `npm run build && npm run test:e2e` | **22 / 22 steps passed**, screenshots in `tests/e2e/screenshots` |
| Production build | `npm run build` | web + server bundle OK |
| Production layout smoke | prod deps only + snippets copy | starts; refuses to start without backend settings |
| Existing n8n suite (unchanged) | `node n8n/tests/run-all.js` | 45 / 45 files pass |

**What the tests check:**
- **core:** terminology, all 14 profiles resolving every label, module resolution.
- **web-words:** no industry words, table names or workflow numbers in `src/web`; only `lib/api.ts` touches the network, and only `/api`.
- **adapter:**
  - mapping and real column names on every write;
  - the staff reply writes exactly one `Send` row; W10 sends it once in the day, holds it in quiet hours, never sends twice;
  - opted-out and window-closed refusals;
  - booking outcome rules and admin-only revenue;
  - automation switches write the workflows' own keys;
  - settings masking and validation;
  - analytics equal `cmWeeklyMetrics` on the same rows;
  - clean backend errors.
- **API:**
  - 401 without a session, 403 without the CSRF header, the rate limit, cookie flags, forged cookies;
  - per-user workspace access;
  - staff refused on settings, automations, profile and knowledge;
  - industry, words and modules round-trip;
  - **no response anywhere contains the API key, doc ids, phone-number ids, the session secret or password hashes**.
- **e2e:**
  - login, every page, every settings section;
  - staff reply (sent, or held with the quiet-hours reason);
  - workspace switch changes the words only;
  - renaming a word and changing industry update every page;
  - palette and shortcuts, light theme;
  - staff read-only;
  - phone width.

## J. Backend fields that are genuinely missing

FLOW HQ hides features that would need these. It does not fake them.

1. **Contact email**: `LEADS` has no email column, so no email is shown or captured.
2. **Tags**: there is no tags column on contacts.
3. **Workspace profile in the registry**: `Clinics` has no industry, logo, display name or time zone. FLOW HQ keeps these in `config/workspaces.json`, and one server time zone applies to all workspaces.
4. **Per-workspace switches for W1–W6, W10, W11**: only `ai_mode`, `outcome_checkin`, `review_requests` and `weekly_report_whatsapp` exist. The others show *Always on* and cannot be turned off from FLOW HQ.
5. **Delivery / read receipts**: W2 skips WhatsApp status updates, so a message is *sent* (accepted by W12) and never *delivered* or *read*.
6. **n8n execution history**: FLOW HQ reads `Run_Log` only. W11 (error trigger) writes no `Run_Log` row, so Error Alerts has no counts.
7. **Conversation channel**: `Conversations` has no channel column. Every conversation is WhatsApp; website enquiries arrive as contacts.
8. **Team / users table**: there is none in Grist. Sign-in users live in FLOW HQ config. Staff names are inferred from `Owner`, `Assigned_To`, `Sent_By` and `Physio`.
9. **Sentiment**: W13 stores intent, action, confidence, status and reason, but no sentiment, so none is shown.
10. **Generic booking value**: only `Fee_INR` exists. Revenue is in INR and admin-only.
11. **Task table**: none, so tasks are derived and cannot be assigned, snoozed or completed by hand.
12. **Structured weekly report**: W9 stores text in `Run_Log.Record`. The overview recomputes the numbers with W9's own code. The stored text keeps W9's clinic wording.
13. **AI usage / cost**: no tokens or cost are stored, so none are shown.

## K. Adding a new industry (no frontend changes)

1. Add a key to `IndustryKey` in `src/core/domain.ts`. Add one entry to `INDUSTRIES` in `src/core/industries/index.ts`:
   ```ts
   veterinary: profile('veterinary', 'Veterinary', 'Vets and pet clinics', {
     workspace: { singular: 'Practice', plural: 'Practices' },
     contact: { singular: 'Pet owner', plural: 'Pet owners' },
     booking: { singular: 'Visit', plural: 'Visits' },
     service: { singular: 'Treatment', plural: 'Treatments' },
     staff: { singular: 'Vet', plural: 'Vets' },
     ai: { name: 'AI Front Desk', short: 'AI' },
   }, ['bookings', 'ai', 'tasks', 'reports', 'reminders', 'follow_ups', 'reviews'],
      ['new_contacts', 'bookings', 'completed', 'no_shows', 'ai_handled', 'pending_actions']),
   ```
2. Run `npm test`. The core test checks that every page, metric, automation, activity and task label resolves in the new profile.
3. In **Settings > Workspace**, pick the industry for a workspace. Every page, metric, automation name, empty state and the command palette now use the new words. The modules follow the profile, intersected with what the backend supports.

**A new backend** (e.g. a salon booking system or a CRM other than Grist):
- Implement `BackendAdapter` / `WorkspaceBackend` from `src/server/adapters/types.ts`, declaring its `supported` modules, automations and metrics and its `capabilities`.
- Select it in `src/server/index.ts`.

The UI shows only what the adapter declares, so nothing in `src/web` changes.

## L. Clinic records: patient register, prescriptions, invoices, attendance (Geeta Krishna Physiotherapy Centre)

Added on top of everything above; nothing above was changed in behaviour. Four pages appear for a workspace **only when its clinic doc has the Clinic Records tables**
(`grist/clinic-records-schema.md`): **Patients** (the register), **Prescriptions**, **Invoices & Payments**, **Attendance**. Leads are shown as **Enquiries** so a lead is never
mistaken for a registered patient. No n8n workflow reads or writes these tables, and no webhook or workflow changed.

**Set up one clinic**
1. Give the Grist API key edit rights on the clinic doc, then create the tables (additive: it never renames, retypes or deletes):
   ```bash
   cd flowhq
   node --env-file=.env node_modules/.bin/tsx src/server/tools/provision-records.ts <clinic-slug>            # dry run: shows what would be created
   node --env-file=.env node_modules/.bin/tsx src/server/tools/provision-records.ts <clinic-slug> --apply    # creates it
   ```
   (`npm run provision-records -- <clinic-slug> [--apply]` does the same when the variables are already in your shell.)
2. In Grist, make the new tables read-only for the front desk, so staff change them through FLOW HQ (see the end of `grist/clinic-records-schema.md`).
3. Edit `config/clinic.json`: name, address, clinicians with registration numbers, timings. `"tax": null` means **no tax is ever added**; set `{ "label": "GST", "ratePercent": 5 }` only with the clinic's real rate. In Docker the file is mounted read-only (`deploy/docker-compose.flowhq.yml`); other setups use `FLOWHQ_CLINIC_FILE`.
4. The pages appear within a minute of the tables existing. Nothing else is configured.

**Staff attendance (optional fifth page).** The clinic's own people (not patients): **Staff attendance** in the Care menu. The same `provision-records` command creates one extra table, `Staff_Attendance`
(additive; a clinic that has not created it keeps all four pages above, and only this page stays hidden). It then appears within a minute, with no restart.
- Who is listed: every FLOW HQ login that can open the workspace, plus each doctor in `config/clinic.json` who has no login of their own. A person's key is their login email (or `doctor:<name>`), so renaming a person in `config/clinic.json` that has no login starts a new row; the old marks stay in Grist and show as "No longer on the team list" for the weeks they cover.
- Each day: Present, Absent, Half day or Leave, with optional check-in / check-out (`HH:MM`, clinic time) and a note. **Check in now / Check out now** stamp the real clinic time for today; pressing check-in twice changes nothing. A day cannot be marked in the future, check-out must be later than check-in, and times are only kept for Present / Half day.
- One row per person per day (marking again updates it); clearing a mark empties its status and never deletes the row. Every change is also written to `Audit_Log` (`staffatt.set` / `staffatt.checkin` / `staffatt.checkout`, with the date, status and times but never the free-text note). The Month summary shows days per status and hours worked (only days with both a check-in and a later check-out).
- Admin and front desk can mark anyone; a doctor's own login (one with `clinician` set) sees and marks only itself. Like the other records tables, make `Staff_Attendance` read-only for front desk in Grist so changes go through FLOW HQ.

**Rules the app enforces (on the server, not just in the screen)**
- Ids are stable text (`GK-P-000001`, `RX-000001`, `GK-2026-000001`, `PAY-000001`), generated under a lock and checked after the write. Row numbers are never ids.
- Money is integer paise. `Total = Subtotal − Discount + Tax`; `Balance = Total − payments`. Overpayment, negative or fractional quantities, and a discount above the subtotal are refused.
- A saved **invoice is final**. A mistake is corrected by **voiding** it (admin only, reason required, payments first) and issuing a new one. **Payments** are only added, or voided with a reason. Each invoice/payment form carries a one-time key, so a double click or a retry cannot create two.
- **Prescriptions** are versioned: an edit saves a new version and keeps the old one. Two people editing the same sheet get a conflict message instead of overwriting each other.
- **Nothing is ever deleted.** Photos are hidden, not deleted. Every change writes an `Audit_Log` row (ids and amounts only, never clinical text).
- **Photos** (JPEG/PNG, 5 MB, up to 6 per prescription) are checked by file signature on the server, resized in the browser (which also strips location metadata), stored as Grist attachments in the clinic's own doc, and served only through a signed-in, workspace-scoped route. There is no public image URL.
- Duplicate patients (same phone or same name) are warned about and never merged automatically.
- The app never writes a diagnosis or a treatment: every clinical field is what the clinician typed.

**Known limits**
- IDs and the "check, then write" steps are serialised **inside one FLOW HQ process**. Run a single replica (the shipped Docker setup does).
- The register loads the clinic's patient and finance rows and filters them on the server: fine for a clinic-sized register (thousands of patients).
- **Split opening hours** (9–1 and 4–8) are supported by the AI receptionist through the optional Settings key `open_hours` (see `grist/schema.md`); FlowHQ's Settings page has an "Opening hours (with a break)" field that accepts exactly what W13 can read. Two things stay outside this app: **Cal.com** decides which times a patient can pick on the booking link (set its availability to the same two windows, Sunday off), and **W3** (staff alerts for new leads) still reads only `open_time` / `close_time`, so keep those at the outer 09:00 / 20:00.
- Signatures are not collected (the printed documents have a signature line for pen).
- Not claimed: compliance with any privacy law. Have the handling of patient data reviewed before real patients are entered.

**Tests**: `npm test` (money, records service, records API, theme/words guard), `npm run test:e2e:clinical` (real browser, against a fresh `FLOWHQ_DEMO=true` server).
