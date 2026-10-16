// STEP 12 - provider endpoints are configuration (staging, mock servers for tests, a regional / proxy endpoint) instead of literals.
//  * W12: Meta Graph base URL (FLOWHQ_WA_GRAPH_BASE_URL, default https://graph.facebook.com)
//  * W13 / W9: AI provider base URL (FLOWHQ_AI_BASE_URL, default https://openrouter.ai/api/v1)
//  * a base URL must be https://, except http://127.0.0.1 or http://localhost (local mock servers); the config guards refuse anything else.
const HTTPS_OR_LOCAL = "/^(https:\\/\\/[^\\s/]+|http:\\/\\/(127\\.0\\.0\\.1|localhost)(:\\d+)?)(\\/[^\\s]*)?$/";

module.exports = {
  id: '12-endpoints',
  title: 'Meta and AI provider base URLs are configuration',
  run(ctx) {
    ctx.setValue('W12 – Config', 'w12_graph_base_url', "={{ $env.FLOWHQ_WA_GRAPH_BASE_URL || 'https://graph.facebook.com' }}");
    ctx.editCode('W12 – Prepare request', [
      { find: '    allow_hello_world: $json.w12_allow_hello_world === true,\n', replace: "    allow_hello_world: $json.w12_allow_hello_world === true,\n    graph_base_url: String($json.w12_graph_base_url || 'https://graph.facebook.com').replace(/\\/+$/, ''),\n" },
      { find: 'meta_url: `https://graph.facebook.com/${version}/${phoneId}/messages`,', replace: 'meta_url: `${cfg.graph_base_url}/${version}/${phoneId}/messages`,', times: 2 },
    ]);
    ctx.editCode('W12 – Config Guard', [{ find: "if (cfg.w12_uncertain_counts_as_sent !== false)", replace: `if (!${HTTPS_OR_LOCAL}.test(String(cfg.w12_graph_base_url || ''))) problems.push('FLOWHQ_WA_GRAPH_BASE_URL must be https:// (or http://127.0.0.1 / localhost for a local mock)');\nif (cfg.w12_uncertain_counts_as_sent !== false)` }]);
    for (const s of ['W13', 'W9']) {
      ctx.setValue(`${s} – Config`, 'ai_base_url', "={{ $env.FLOWHQ_AI_BASE_URL || 'https://openrouter.ai/api/v1' }}");
      const node = ctx.node(`${s} – Ask Model`);
      if (node.parameters.url !== 'https://openrouter.ai/api/v1/chat/completions') throw new Error(`"${s} – Ask Model" has an unexpected URL`);
      node.parameters.url = `={{ String($('${s} – Config').first().json.ai_base_url).replace(/\\/+$/, '') }}/chat/completions`;
      ctx.editCode(`${s} – Config Guard`, [{ find: 'if (problems.length) throw new Error(', replace: `if (!${HTTPS_OR_LOCAL}.test(String(cfg.ai_base_url || ''))) problems.push('FLOWHQ_AI_BASE_URL must be https:// (or http://127.0.0.1 / localhost for a local mock)');\nif (problems.length) throw new Error(` }]);
    }
    ctx.log('12', 'W12 Meta base URL = FLOWHQ_WA_GRAPH_BASE_URL, W13/W9 AI base URL = FLOWHQ_AI_BASE_URL (defaults unchanged; https required except localhost mocks; refused by the config guards otherwise)');
  },
};
