# Legacy per-workflow exports (not authoritative)

`W1-website-lead.json` … `W6-followups.json` here are the early separate exports of the first workflows. The workflow that runs the clinic is the single integrated one in **`n8n/final/workflows/`** (selected, sanitized) and its proposed fixes. These files, `n8n/integrated/`, `n8n/w2/`, `n8n/w13/`, `n8n/w7-w10/`, `n8n/merged/` and `n8n/snippets/` are the source lineage (the workflow code is pasted from `n8n/snippets/`); `node n8n/tests/run-all.js` runs their 48 test files. Do not import these into the clinic's n8n.
