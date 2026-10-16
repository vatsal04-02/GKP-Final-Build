// STEP 02 - external AI is OFF by default and filtered when on.
//  * W13: the AI route is closed unless FLOWHQ_AI_EXTERNAL_ENABLED=true (the clinic approved provider, terms, retention and the data sent). Same effect as Settings ai_mode=off.
//  * W13: direct identifiers (name, phone, e-mail, long digit runs) are masked before the request leaves; the first name is put back into the reply afterwards.
//  * W9: the weekly-metrics AI call only happens when enabled; otherwise the report is written from the computed numbers alone (it already supports that).
const fs = require('fs');
const path = require('path');
const SNIP = fs.readFileSync(path.join(__dirname, '..', 'snippets', 'ai-redact.js'), 'utf8');
const BLOCK = SNIP.slice(SNIP.indexOf('const FHQ_PATIENT'), SNIP.indexOf('if (typeof module'));
const HEADER = '// ---- pasted from n8n/production/snippets/ai-redact.js - keep identical ----\n';

module.exports = {
  id: '02-ai',
  title: 'External AI gate and privacy filter',
  BLOCK,
  run(ctx) {
    // ---- W13 gate
    ctx.editCode('W13 – Build Context', [{
      find: 'const { x, gate } = aiContext(raw, cfg, t0, h);\n',
      replace: "let { x, gate } = aiContext(raw, cfg, t0, h);\n// PRODUCTION: external AI is closed until the clinic has approved the provider (FLOWHQ_AI_EXTERNAL_ENABLED=true). Closed = the same quiet 'skip' as Settings ai_mode=off.\nif (gate.route === 'ai' && $('W13 – Config').first().json.ai_external_enabled !== true) gate = { route: 'skip', reason: 'external AI is not enabled (FLOWHQ_AI_EXTERNAL_ENABLED)', quiet: true };\n",
    }]);
    ctx.log('02', 'W13 – Build Context: the AI route is closed unless FLOWHQ_AI_EXTERNAL_ENABLED=true (default off); a closed gate is the same quiet skip as ai_mode=off, nothing is sent to any provider');

    // ---- W13 redaction before the request, name restore after the answer
    ctx.editCode('W13 – Provider Request', [
      { find: '// ---- this node ----\n// PROVIDER LAYER (OpenRouter). The request W13', replace: `${HEADER}${BLOCK}\n// ---- this node ----\n// PROVIDER LAYER (OpenRouter). The request W13` },
      {
        find: "const req = $('W13 – Build Context').first().json.request;\nreturn [{ json: { body: aiToOpenRouter(req, cfg.openrouter_model) } }];",
        replace: "const bc = $('W13 – Build Context').first().json;\nconst safeReq = fhqRedactRequest(bc.request, { names: [bc.x.lead.name, bc.x.msg && bc.x.msg.sender_name], phone: bc.x.lead.phone });   // privacy filter: name, phone, e-mail, long digit runs are masked\nconst body = aiToOpenRouter(safeReq, cfg.openrouter_model);\nconst digits = String(bc.x.lead.phone || '').replace(/\\D/g, '').slice(-10);\nif (digits.length >= 8 && JSON.stringify(body).includes(digits)) throw new Error('privacy filter failed: the patient phone number is still in the AI request, nothing was sent');\nreturn [{ json: { body } }];",
      },
    ]);
    ctx.editCode('W13 – Provider Answer', [
      { find: "// ---- this node ----\n// PROVIDER LAYER (OpenRouter). OpenRouter's answer", replace: `${HEADER}${BLOCK}\n// ---- this node ----\n// PROVIDER LAYER (OpenRouter). OpenRouter's answer` },
      { find: 'return [{ json: aiFromOpenRouter($json) }];', replace: "return [{ json: fhqRestoreAnswer(aiFromOpenRouter($json), $('W13 – Build Context').first().json.x.lead.name) }];   // [PATIENT] -> first name" },
    ]);
    ctx.log('02', 'W13 – Provider Request/Answer: patient name, phone, e-mail and long digit runs are masked before the request leaves (clinic rules, knowledge base and dates are untouched); a request whose shape is unexpected, or that still holds the phone digits, is not sent');

    // ---- W9 gate
    ctx.codeNode('W9 – External AI off', "// External AI is not enabled (FLOWHQ_AI_EXTERNAL_ENABLED is not true): nothing is sent to the provider.\n// W9 – Report then writes the report from the computed numbers alone (every number comes from code anyway).\nreturn $input.all().map((_, i) => ({ json: { error: { message: 'external AI is not enabled' } }, pairedItem: { item: i } }));\n", ctx.pos('W9 – Ask Model', 0, 176));
    ctx.ifNode('W9 – External AI?', "={{ $('W9 – Config').first().json.ai_external_enabled === true }}", ctx.pos('W9 – Metrics', 112, -120));
    ctx.insertAfter('W9 – Metrics', 0, 'W9 – External AI?');
    ctx.addOutput('W9 – External AI?', 1, 'W9 – External AI off');
    ctx.addOutput('W9 – External AI off', 0, 'W9 – Report');
    ctx.log('02', 'W9: new "W9 – External AI?" gate; when external AI is not enabled the metrics are never sent to the provider and the report is written from the numbers alone');
  },
};
