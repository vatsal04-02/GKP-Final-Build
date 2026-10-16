// STEP 01 - configuration, secrets and exposure.
//  * every environment-specific value or secret in a Config node becomes a $env.FLOWHQ_* expression (nothing literal is left in the export)
//  * each section gets a "Config Guard" Code node that stops the run with a clear message when a required value is missing/placeholder (fail closed)
//  * W4's obsolete unauthenticated test webhook (cal-w4-test) is removed; allowUnauthorizedCerts is removed everywhere (TLS is always verified)
//  * credentials get stable, meaningful names and ids (create them with scripts/create-credentials.js)
//  * export identity: new id/name, inactive, timezone, execution-data retention
const ENV = (name, fallback) => `={{ $env.${name}${fallback === undefined ? " || ''" : ` || ${JSON.stringify(fallback).replace(/"/g, "'")}`} }}`;

const GRIST_SECTIONS = ['W1', 'W2', 'W3', 'W4', 'W5', 'W6', 'W7', 'W8', 'W9', 'W10', 'W13'];

const CREDENTIALS = {
  'httpHeaderAuth|Header Auth account 2': { id: 'FhqCredGrist0001', name: 'FlowHQ Grist API' },
  'httpHeaderAuth|Header Auth account': { id: 'FhqCredW1Hook001', name: 'FlowHQ W1 Webhook Auth' },
  'httpHeaderAuth|WhatsApp Cloud API': { id: 'FhqCredWhatsApp1', name: 'FlowHQ WhatsApp Cloud API' },
  'httpHeaderAuth|OpenRouter API': { id: 'FhqCredAiProv001', name: 'FlowHQ AI Provider' },
  'telegramApi|Telegram account': { id: 'FhqCredTelegram1', name: 'FlowHQ Telegram Alerts' },
};

const guardCode = (section, rules) => `// ${section} CONFIG GUARD (production hardening). Stops the run - before anything reads Grist, calls Meta or an AI provider -
// when a required setting is missing, still a placeholder, or unsafe. The message names the variable to set (never its value).
const cfg = $input.first().json || {};
const problems = [];
const blank = (v) => v === undefined || v === null || String(v).trim() === '' || /^(PASTE_|PH_|CHANGE_ME|REPLACE_ME)/i.test(String(v).trim());
const need = (key, env, min) => { const v = cfg[key]; if (blank(v)) problems.push(\`\${env} is not set\`); else if (min && String(v).trim().length < min) problems.push(\`\${env} is too short (min \${min} characters)\`); };
${rules}
if (problems.length) throw new Error(\`FlowHQ configuration incomplete in ${section}: \${problems.join('; ')}. See DEPLOYMENT.md > Environment variables.\`);
return $input.all();
`;

const GRIST_RULES = `need('grist_base_url', 'FLOWHQ_GRIST_URL');
if (!blank(cfg.grist_base_url) && !/^https?:\\/\\/[^\\s/]+/i.test(String(cfg.grist_base_url).trim())) problems.push('FLOWHQ_GRIST_URL must start with http:// or https://');
need('registry_doc_id', 'FLOWHQ_REGISTRY_DOC_ID');`;

module.exports = {
  id: '01-config',
  title: 'Configuration, secrets, guards, exposure, identity',
  run(ctx) {
    const wf = ctx.wf;

    // ---- 1. remove dead / unsafe things
    ctx.removeNode('W4 – Webhook');
    ctx.log('01', 'removed "W4 – Webhook" (POST /webhook/cal-w4-test): unauthenticated, connected to nothing, an unauthenticated public path with no purpose');
    let tls = 0;
    for (const n of wf.nodes) {
      if (n.type === 'n8n-nodes-base.httpRequest' && n.parameters && n.parameters.options && n.parameters.options.allowUnauthorizedCerts !== undefined) {
        delete n.parameters.options.allowUnauthorizedCerts; tls++;
        ctx.log('01', `"${n.name}": removed allowUnauthorizedCerts (TLS certificates are always verified)`);
      }
    }
    if (tls === 0) throw new Error('expected at least one allowUnauthorizedCerts to remove (is this the v3 export?)');

    // ---- 2. Config nodes -> environment
    let envCount = 0;
    const setEnv = (node, key, value, type) => { ctx.setValue(node, key, value, type); envCount++; };
    for (const s of GRIST_SECTIONS) {
      const cfg = `${s} – Config`;
      setEnv(cfg, 'grist_base_url', ENV('FLOWHQ_GRIST_URL', 'http://grist:8484'));
      setEnv(cfg, 'registry_doc_id', ENV('FLOWHQ_REGISTRY_DOC_ID'));
    }
    setEnv('W3 – Config', 'test_phone', ENV('FLOWHQ_TEST_PHONE'));
    setEnv('W4 – Config', 'cal_webhook_secret', ENV('FLOWHQ_CAL_WEBHOOK_SECRET'));
    setEnv('W2 – Verify Config', 'meta_verify_token', ENV('FLOWHQ_META_VERIFY_TOKEN'));
    setEnv('W11 – Config', 'telegram_chat_id', ENV('FLOWHQ_TELEGRAM_CHAT_ID'));
    setEnv('W12 – Config', 'w12_send_mode', ENV('FLOWHQ_WA_SEND_MODE', 'allowlist'));
    setEnv('W12 – Config', 'w12_allowlist', ENV('FLOWHQ_WA_ALLOWLIST'));
    setEnv('W12 – Config', 'w12_graph_api_version', ENV('FLOWHQ_WA_GRAPH_VERSION', 'v23.0'));
    ctx.setValue('W12 – Config', 'w12_uncertain_counts_as_sent', false, 'boolean');
    ctx.log('01', 'W12 – Config: w12_uncertain_counts_as_sent=false (an unconfirmed Meta call is never reported as sent)');
    for (const c of ['W13 – Config', 'W9 – Config']) {
      setEnv(c, 'openrouter_model', ENV('FLOWHQ_AI_MODEL', 'openai/gpt-4o-mini'));
      setEnv(c, 'ai_external_enabled', "={{ $env.FLOWHQ_AI_EXTERNAL_ENABLED === 'true' }}", 'boolean');
    }
    setEnv('W13 – Config', 'max_ai_replies_per_hour', "={{ Number($env.FLOWHQ_AI_MAX_REPLIES_PER_HOUR || 6) }}", 'number');
    ctx.log('01', 'Config nodes now read FLOWHQ_GRIST_URL, FLOWHQ_REGISTRY_DOC_ID, FLOWHQ_TEST_PHONE, FLOWHQ_CAL_WEBHOOK_SECRET, FLOWHQ_META_VERIFY_TOKEN, FLOWHQ_TELEGRAM_CHAT_ID, FLOWHQ_WA_SEND_MODE/ALLOWLIST/GRAPH_VERSION, FLOWHQ_AI_MODEL/EXTERNAL_ENABLED/MAX_REPLIES_PER_HOUR from the environment; no literal secret or identifier remains');
    if (ctx.has('W2 – Signature Config')) {
      setEnv('W2 – Signature Config', 'meta_app_secret', ENV('FLOWHQ_META_APP_SECRET'));
      ctx.log('01', 'W2 – Signature Config: meta_app_secret from FLOWHQ_META_APP_SECRET (signature mode stays "enforce"; there is deliberately no environment switch to turn it off)');
    }

    // ---- 3. the manual W12 test node: no real identifiers
    const ti = ctx.node('W12 – Test input');
    const before = ti.parameters.jsCode;
    let hits = 0;
    ti.parameters.jsCode = before
      .replace("1st test: hello_world (Meta's sample template, no variables) to your own phone.", () => { hits++; return '1st test: send an approved template to your own phone. hello_world is NOT allowed in production (see W12 template policy).'; })
      .replace(/wa_phone_number_id: '[^']*',/, () => { hits++; return "wa_phone_number_id: 'PASTE_PHONE_NUMBER_ID',"; })
      .replace(/doc_id: '[^']*',/, () => { hits++; return "doc_id: 'PASTE_CLINIC_DOC_ID',"; })
      .replace(/to: '[^']*', reason: 'manual test'/, () => { hits++; return "to: 'PASTE_YOUR_TEST_NUMBER', reason: 'manual test'"; });
    if (hits !== 4) throw new Error(`"W12 – Test input" is not the expected manual-test node (${hits}/4 anchors)`);
    ctx.log('01', 'W12 – Test input: removed a real Grist doc id, a WhatsApp phone-number id and a real test phone number (placeholders now)');

    // ---- 3b. quiet hours: the test switch must be OFF in production
    let qh = 0;
    for (const n of wf.nodes) {
      if (n.type === 'n8n-nodes-base.code' && /DISABLE_QUIET_HOURS_FOR_TEST = true;/.test(n.parameters.jsCode || '')) {
        ctx.editCode(n.name, [{ find: 'DISABLE_QUIET_HOURS_FOR_TEST = true;', replace: 'DISABLE_QUIET_HOURS_FOR_TEST = false;' }]); qh++;
      }
    }
    if (qh !== 7) throw new Error(`expected the quiet-hours test switch in 7 Code nodes, found ${qh}`);
    ctx.log('01', `quiet hours: DISABLE_QUIET_HOURS_FOR_TEST switched back to false in ${qh} nodes (W12 Prepare request, W13 Build Context, W13 Plan Ready, W7/W8 Decide send, W9 Owner message, W10 Check): no patient message between 21:00 and 08:00 IST`);

    // ---- 4. W11: no Telegram call without a chat id
    ctx.editCode('W11 – Format alert', [{ find: '  let send = true;\n', replace: "  let send = String($json.telegram_chat_id || '').trim() !== '' && !/^PASTE_/i.test(String($json.telegram_chat_id));   // no chat id configured = no alert (the failure is still in the execution list)\n" }]);
    ctx.log('01', 'W11 – Format alert: skips the Telegram call when FLOWHQ_TELEGRAM_CHAT_ID is not set');

    // ---- 5. config guards
    const addGuard = (cfgName, section, rules, edge) => {
      const name = `${section} – Config Guard`;
      ctx.codeNode(name, guardCode(section, rules), ctx.pos(cfgName, 112, 120));
      ctx.insertAfter(cfgName, 0, name);
      return name;
    };
    for (const s of GRIST_SECTIONS) {
      let rules = GRIST_RULES;
      if (s === 'W4') rules += "\nif (cfg.require_signature !== true) problems.push('require_signature must be true in production');\nneed('cal_webhook_secret', 'FLOWHQ_CAL_WEBHOOK_SECRET', 16);";
      if (s === 'W13') rules += "\nif (cfg.ai_external_enabled === true) need('openrouter_model', 'FLOWHQ_AI_MODEL');";
      if (s === 'W9') rules += "\nif (cfg.ai_external_enabled === true) need('openrouter_model', 'FLOWHQ_AI_MODEL');";
      addGuard(`${s} – Config`, s, rules);
    }
    addGuard('W2 – Verify Config', 'W2 verify', "need('meta_verify_token', 'FLOWHQ_META_VERIFY_TOKEN', 16);");
    if (ctx.has('W2 – Signature Config')) addGuard('W2 – Signature Config', 'W2 signature', "need('meta_app_secret', 'FLOWHQ_META_APP_SECRET', 16);\nif (cfg.w2_signature_mode !== 'enforce') problems.push('signature mode must be enforce in production');");
    addGuard('W12 – Config', 'W12', `const mode = String(cfg.w12_send_mode || '').trim().toLowerCase();
if (!['allowlist', 'live', 'off'].includes(mode)) problems.push('FLOWHQ_WA_SEND_MODE must be allowlist, live or off');
if (mode === 'allowlist' && blank(cfg.w12_allowlist)) problems.push('FLOWHQ_WA_ALLOWLIST is not set (mode allowlist needs at least one number)');
if (!/^v\\d+\\.\\d+$/.test(String(cfg.w12_graph_api_version || ''))) problems.push('FLOWHQ_WA_GRAPH_VERSION must look like v23.0');
if (cfg.w12_uncertain_counts_as_sent !== false) problems.push('w12_uncertain_counts_as_sent must be false');`);
    ctx.log('01', 'added Config Guard nodes (W1, W2, W2 verify, W2 signature, W3, W4, W5, W6, W7, W8, W9, W10, W12, W13): missing/placeholder settings stop the run with a message naming the variable');

    // ---- 6. credentials
    let creds = 0;
    for (const n of wf.nodes) {
      if (!n.credentials) continue;
      for (const [type, c] of Object.entries(n.credentials)) {
        const to = CREDENTIALS[`${type}|${c.name}`];
        if (!to) throw new Error(`unexpected credential "${c.name}" (${type}) on "${n.name}"`);
        n.credentials[type] = { id: to.id, name: to.name }; creds++;
      }
    }
    ctx.log('01', `${creds} credential references renamed to stable ids/names: ${Object.values(CREDENTIALS).map((c) => c.name).join(', ')} (scripts/create-credentials.js creates them from the environment)`);

    // ---- 7. identity and settings
    wf.id = 'FhqClinicProd001';
    wf.name = 'FlowHQ Clinic Automation (production candidate)';
    wf.active = false;
    wf.versionId = ctx.uuid('versionId');
    wf.pinData = {};
    wf.meta = { templateCredsSetupCompleted: false };
    wf.settings = { executionOrder: 'v1', binaryMode: 'separate', timezone: 'Asia/Kolkata', saveDataSuccessExecution: 'none', saveDataErrorExecution: 'all', saveManualExecutions: false, saveExecutionProgress: false, executionTimeout: 900, timeSavedMode: 'fixed' };
    ctx.log('01', 'export identity: id FhqClinicProd001 (cannot overwrite the live workflow on import), inactive, timezone Asia/Kolkata, success executions not stored (patient data), failed executions stored, 15-minute timeout');
    return { envCount };
  },
};
