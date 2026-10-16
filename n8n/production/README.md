# FlowHQ Clinic Automation — production package

**Final export: `n8n/production/clinic-autopilot-production.json`** (inactive, id `FhqClinicProd001`, no secrets). It is the uploaded "ai updated workflow clinic final v3" with the fixes of `FIXES_APPLIED.md`, built reproducibly by `apply-production-hardening.js`.

Read in this order: `PRODUCTION_AUDIT.md` (what was wrong) → `FIXES_APPLIED.md` (what changed) → `ARCHITECTURE.md` → `TEST_REPORT.md` (what was and was not tested) → `DEPLOYMENT.md` → `OPERATIONS.md` → `PRIVACY.md` → `CHECKLIST.md` (ready / needs credentials / disabled / residual risks) → `MISSED_CALL.md`.

```
node n8n/production/tools/run-all-tests.js [--real] [--mutation] [--baseline]   run every test, write audit/test-results.json
node n8n/production/tools/audit.js --in n8n/production/clinic-autopilot-production.json --compose n8n/production/ops/docker-compose.production.yml --caddy n8n/production/ops/Caddyfile.production
node n8n/production/tools/report.js                                              regenerate PRODUCTION_AUDIT.md, FIXES_APPLIED.md, TEST_REPORT.md
node n8n/production/apply-production-hardening.js --in <upload> --out <file>     rebuild the export
```

This package does **not** make the system "production ready" by itself: no real Meta / Grist / Cal.com / server was available. It makes the workflow safe to **rehearse** (allowlist mode, TEST_MODE, Mailpit) and lists what has to be verified before real patients are messaged.
