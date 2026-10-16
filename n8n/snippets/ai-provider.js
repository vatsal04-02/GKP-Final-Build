// Model-provider adapter for W13 (AI receptionist). W13's decision layer (ai-receptionist.js) builds ONE request in the Anthropic
// Messages shape (aiBuildRequest) and reads ONE answer in that shape (aiParseResponse). To use another provider, only these two
// translations change; every check after the model answers stays the same. Pure functions, pasted into the provider Code nodes.
// Paste from AI_OPENROUTER_FINISH down to (not including) the module.exports line.
//
// OpenRouter (OpenAI-style Chat Completions, https://openrouter.ai/api/v1/chat/completions):
//   request : the same instructions and facts as ONE system message (rules + clinic facts first: the stable prefix providers cache),
//             the same patient message, the same max_tokens, the same JSON schema as response_format json_schema (strict), and
//             provider.require_parameters so OpenRouter only routes to an endpoint that enforces the schema.
//   answer  : choices[0].message.content (the JSON text) -> { type: 'message', content: [{ type: 'text', text }], stop_reason, usage }.

const AI_OPENROUTER_FINISH = { stop: 'end_turn', length: 'max_tokens', content_filter: 'refusal' };

// req: the Anthropic-shaped request from aiBuildRequest; model: the OpenRouter model id (W13 – Config > openrouter_model).
function aiToOpenRouter(req, model) {
  const id = String(model === null || model === undefined ? '' : model).trim();
  if (!/^[a-z0-9][a-z0-9._-]*\/[A-Za-z0-9._:-]+$/.test(id)) throw new Error(`openrouter_model "${id}" is not an OpenRouter model id (vendor/model, e.g. openai/gpt-4o-mini)`);
  const system = (Array.isArray(req.system) ? req.system : [{ text: String(req.system || '') }]).map((b) => String(b.text || '')).filter(Boolean).join('\n\n');
  const fmt = req.output_config && req.output_config.format;
  const body = {
    model: id,
    max_tokens: req.max_tokens,
    messages: [{ role: 'system', content: system }, ...req.messages.map((m) => ({ role: m.role, content: typeof m.content === 'string' ? m.content : (m.content || []).map((p) => p.text || '').join('\n') }))],
  };
  if (fmt && fmt.type === 'json_schema') {
    body.response_format = { type: 'json_schema', json_schema: { name: 'clinic_decision', strict: true, schema: fmt.schema } };
    body.provider = { require_parameters: true };   // never fall back to an endpoint that would ignore the schema
  }
  return body;
}

// resp: what n8n's HTTP node returned (the OpenRouter JSON, or n8n's { error } item). Returns the Anthropic-shaped answer that
// aiParseResponse reads, or { error } (-> W13 hands the conversation to a person). Never throws.
function aiFromOpenRouter(resp) {
  const fail = (message) => ({ error: { message: `OpenRouter: ${String(message).replace(/\s+/g, ' ').slice(0, 200)}` } });
  if (!resp || typeof resp !== 'object') return fail('no answer');
  if (resp.error) {
    const e = resp.error;
    return fail(typeof e === 'string' ? e : `${e.code ? `${e.code} ` : ''}${e.message || e.description || JSON.stringify(e)}`);
  }
  const choice = Array.isArray(resp.choices) ? resp.choices[0] : null;
  if (!choice) return fail('the answer has no choices');
  if (choice.error) return fail(choice.error.message || JSON.stringify(choice.error));
  const msg = choice.message || {};
  let text = typeof msg.content === 'string' ? msg.content
    : Array.isArray(msg.content) ? msg.content.filter((p) => p && (p.type === 'text' || p.type === 'output_text')).map((p) => p.text || '').join('') : '';
  text = text.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n?```$/i, '$1').trim();   // a fenced JSON block -> the JSON (still parsed and checked)
  let stop = AI_OPENROUTER_FINISH[choice.finish_reason] || (choice.finish_reason ? String(choice.finish_reason) : 'end_turn');
  if (msg.refusal) stop = 'refusal';
  const u = resp.usage || {};
  return {
    type: 'message',
    role: 'assistant',
    model: resp.model || '',
    content: text ? [{ type: 'text', text }] : [],
    stop_reason: stop,
    usage: { input_tokens: u.prompt_tokens || 0, output_tokens: u.completion_tokens || 0, provider: 'openrouter', model: resp.model || '' },
  };
}

if (typeof module !== 'undefined') module.exports = { AI_OPENROUTER_FINISH, aiToOpenRouter, aiFromOpenRouter };
