// PROVIDER LAYER (OpenRouter). OpenRouter's answer, or n8n's { error } item when the call failed or timed out -> the Anthropic-shaped
// answer W13 – Plan reads (aiFromOpenRouter -> aiParseResponse). Nothing is decided here: W13 – Plan validates the JSON decision
// and runs every safety check exactly as with Claude; any failure becomes a hand-off to a person.
return [{ json: aiFromOpenRouter($json) }];
