// PROVIDER LAYER (OpenRouter). The request W13 – Build Context made (Anthropic Messages shape: rules, clinic facts, this message's
// facts, the patient's message, the decision schema) -> the SAME request for OpenRouter's Chat Completions API (aiToOpenRouter).
// Only this node, W13 – Ask Model and W13 – Provider Answer know the provider. The model id comes from W13 – Config > openrouter_model.
// A wrong model_provider / model id stops the run here with an error (W11 alerts), before anything is sent anywhere.
const cfg = $('W13 – Config').first().json;
const provider = String(cfg.model_provider || '').trim().toLowerCase();
if (provider !== 'openrouter') throw new Error(`W13 – Config > model_provider is "${cfg.model_provider}": this demo workflow only talks to OpenRouter (for Anthropic use "W13 - AI receptionist")`);
const req = $('W13 – Build Context').first().json.request;
return [{ json: { body: aiToOpenRouter(req, cfg.openrouter_model) } }];
