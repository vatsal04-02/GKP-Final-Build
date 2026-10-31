// ---- shared helpers (identical in W13 – M1 Validate and W13 – Output Adapter; keep in step) ----
const pShort = (v, max) => String(v === null || v === undefined ? '' : v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
const pNum = (v) => { if (typeof v === 'number') return Number.isFinite(v) ? v : null; if (typeof v === 'string' && /^\s*-?\d+(\.\d+)?\s*$/.test(v)) return Number(v); return null; };
const pBool = (v) => (v === true || v === 'true' ? true : v === false || v === 'false' ? false : null);
const pEnum = (v, list) => { const s = String(v === null || v === undefined ? '' : v).trim().toLowerCase().replace(/[\s-]+/g, '_'); return list.includes(s) ? s : null; };

// What went wrong with an OpenRouter call (the HTTP node's error item, an error body with HTTP 200, or a choice error) -> a class.
function failureClass(resp) {
  const parts = [];
  const add = (v) => { if (v !== undefined && v !== null && v !== '') parts.push(typeof v === 'string' ? v : JSON.stringify(v)); };
  const e = resp && resp.error;
  if (e && typeof e === 'object' && typeof e.class === 'string' && e.class) return { cls: e.class, message: pShort(e.message, 200) };   // already classified by the retry check
  if (typeof e === 'string') add(e);
  else if (e && typeof e === 'object') { add(e.httpCode); add(e.code); add(e.status); add(e.statusCode); add(e.message); add(e.description); add(e.name); add(e.cause && e.cause.code); add(e.metadata); }
  const ch = resp && Array.isArray(resp.choices) ? resp.choices[0] : null;
  if (ch && ch.error) add(ch.error);
  const s = parts.join(' ');
  let cls = 'other';
  if (/\b429\b|rate.?limit|too many requests|free-models-per-day/i.test(s)) cls = 'rate_limited';
  else if (/\b402\b|payment required|insufficient (credit|fund)|requires more credits|credit limit/i.test(s)) cls = 'payment_required';
  else if (/\b(401|403)\b|unauthori[sz]ed|forbidden|invalid api key|no auth|authentication/i.test(s)) cls = 'auth_error';
  else if (/\b404\b|no endpoints found|not a valid model|model.{0,30}(unavailable|not found|deprecated|disabled|removed)|no allowed providers/i.test(s)) cls = 'model_unavailable';
  else if (/\b(500|502|503|504|520|524|529)\b|bad gateway|service unavailable|overloaded|internal server error|upstream/i.test(s)) cls = 'upstream_5xx';
  else if (/timeout|timed out|etimedout|esockettimedout|econnaborted/i.test(s)) cls = 'timeout';
  else if (/econnreset|econnrefused|enotfound|socket hang up|network/i.test(s)) cls = 'network';
  return { cls, message: pShort(s || 'unknown error', 200) };
}

// The first JSON object in a model's text: tolerates <think> blocks, code fences and text around it.
function extractJson(raw) {
  let s = String(raw || '').replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '').replace(/<thought>[\s\S]*?<\/thought>/gi, '');
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence && fence[1].includes('{')) s = fence[1];
  let from = s.indexOf('{');
  for (let tries = 0; from >= 0 && tries < 20; tries++) {
    let depth = 0, inStr = false, esc = false;
    for (let i = from; i < s.length; i++) {
      const ch = s[i];
      if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
      if (ch === '"') inStr = true;
      else if (ch === '{') depth++;
      else if (ch === '}' && --depth === 0) { try { const o = JSON.parse(s.slice(from, i + 1)); if (o && typeof o === 'object' && !Array.isArray(o)) return o; } catch (err) { /* try the next brace */ } break; }
    }
    from = s.indexOf('{', from + 1);
  }
  return null;
}

// resp: what the HTTP node gave back. expectPrefix: the model family that was asked for (a different one served = fail closed, no silent substitution).
function parseCompletion(resp, expectPrefix) {
  if (!resp || typeof resp !== 'object') return { ok: false, cls: 'other', error: 'no answer' };
  const choice = Array.isArray(resp.choices) ? resp.choices[0] : null;
  if (resp.error || (choice && choice.error)) { const f = failureClass(resp); return { ok: false, cls: f.cls, error: f.message }; }
  if (!choice) return { ok: false, cls: 'invalid_output', error: 'the answer has no choices' };
  const u = resp.usage || {};
  const base = { usage: { in: Number(u.prompt_tokens) || 0, out: Number(u.completion_tokens) || 0 }, served_model: String(resp.model || ''), finish: String(choice.finish_reason || '') };
  if (base.served_model && !base.served_model.toLowerCase().startsWith(expectPrefix)) return { ok: false, cls: 'model_mismatch', error: `asked for ${expectPrefix}* but ${pShort(base.served_model, 60)} answered`, ...base };
  const msg = choice.message || {};
  if (msg.refusal) return { ok: false, cls: 'refusal', error: 'the model declined to answer', ...base };
  if (choice.finish_reason === 'length') return { ok: false, cls: 'truncated', error: 'the answer was cut off (max_tokens)', ...base };
  const text = typeof msg.content === 'string' ? msg.content : Array.isArray(msg.content) ? msg.content.filter((p) => p && (p.type === 'text' || p.type === 'output_text')).map((p) => p.text || '').join('') : '';
  if (!text.trim()) return { ok: false, cls: 'invalid_output', error: 'empty answer', ...base };
  const obj = extractJson(text);
  if (!obj) return { ok: false, cls: 'invalid_output', error: 'the answer is not a JSON object', ...base };
  return { ok: true, obj, ...base };
}
// ---- end of shared helpers ----

// AI MODEL RETRY CHECK. Reads what OpenRouter (or the network) answered and decides: success, wait-and-retry, or give up.
//   * success      -> passes the OpenRouter answer on unchanged (the next node validates it as before)
//   * HTTP 429 and temporary 5xx (500-599), plus one retry after a timeout / network error -> exponential backoff with jitter,
//     waiting at least the Retry-After the server sent. At most `retry_max_attempts` requests in total, never an endless loop.
//   * a daily quota ("free-models-per-day"), a wait longer than `retry_max_wait_seconds`, 400 / 401 / 402 / 403 / 404 -> no retry
//   * giving up -> an { error } item (class, HTTP status, attempts). It is NEVER passed on as an answer: the pipeline hands the message to a person.
// attempt = how many times this node has run in this execution (it runs once per request).
const cfg = { retry_max_attempts: Number($env.FLOWHQ_AI_RETRY_MAX_ATTEMPTS || 3), retry_base_seconds: Number($env.FLOWHQ_AI_RETRY_BASE_SECONDS || 2), retry_max_wait_seconds: Number($env.FLOWHQ_AI_RETRY_MAX_WAIT_SECONDS || 20) };   // clamped below
const req = $('W13 – Provider Request').first().json;
const res = $json;
const attempt = $runIndex + 1;
const maxAttempts = Math.min(5, Math.max(1, Number(cfg.retry_max_attempts) || 3));
const baseS = Math.min(10, Math.max(0.5, Number(cfg.retry_base_seconds) || 2));
const capS = Math.min(60, Math.max(1, Number(cfg.retry_max_wait_seconds) || 20));   // stays under n8n's 65 s in-memory Wait limit
const short = (v, n) => String(v === null || v === undefined ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
const lower = (o) => Object.fromEntries(Object.entries(o && typeof o === 'object' ? o : {}).map(([k, v]) => [String(k).toLowerCase(), v]));
const CLASS_OF_STATUS = (s) => (s === 429 ? 'rate_limited' : s === 402 ? 'payment_required' : (s === 401 || s === 403) ? 'auth_error' : s === 404 ? 'model_unavailable' : s === 408 ? 'timeout' : s >= 500 ? 'upstream_5xx' : s >= 400 ? 'bad_request' : 'other');

// 1. what came back
let status = null; let cls = ''; let msg = ''; let headers = {}; let meta = {}; let daily = false;
if (res && typeof res.statusCode === 'number') {
  headers = lower(res.headers);
  let body = res.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = { error: { code: res.statusCode, message: body } }; } }
  body = body && typeof body === 'object' ? body : {};
  const e = (body.error && typeof body.error === 'object') ? body.error : (body.choices && body.choices[0] && body.choices[0].error) || (typeof body.error === 'string' ? { message: body.error } : null);
  status = res.statusCode;
  if (status >= 200 && status < 300 && e) status = Number(e.code) >= 400 ? Number(e.code) : 502;   // OpenRouter can answer 200 with an error body (upstream failure)
  if (status < 400) {
    const out = body;
    return [{ json: { ...out, __attempts: attempt } }];
  }
  msg = short((e && (e.message || e.error)) || `HTTP ${status}`, 200);
  cls = CLASS_OF_STATUS(status);
  meta = lower(e && e.metadata && e.metadata.headers);
  daily = cls === 'rate_limited' && /free-models-per-day|per.?day|daily/i.test(`${msg} ${JSON.stringify(e && e.metadata ? e.metadata : '')}`);
} else {
  const f = failureClass(res);   // the request never completed: n8n's { error } item (timeout, connection reset, DNS ...)
  cls = f.cls; msg = f.message;
}

// 2. is another request worth it?
const retryable = ['rate_limited', 'upstream_5xx', 'timeout', 'network'].includes(cls);
const limit = (cls === 'timeout' || cls === 'network') ? Math.min(maxAttempts, 2) : maxAttempts;   // a timeout may have been processed upstream: at most one repeat
const fail = (why) => [{ json: { error: { class: cls, httpCode: status, attempts: attempt, message: short(`${msg}${why ? ` (${why})` : ''}; HTTP ${status === null ? 'none' : status}, ${attempt} request${attempt > 1 ? 's' : ''}`, 220) }, __attempts: attempt } }];
if (!retryable) return fail('not retried');
if (daily) return fail('daily free quota used up; retrying cannot help');
if (attempt >= limit) return fail(`gave up after ${attempt}`);

// 3. how long to wait: Retry-After (seconds or a date) is a minimum; otherwise exponential backoff with equal jitter
let serverS = null;
const raw = String(headers['retry-after'] !== undefined ? headers['retry-after'] : (meta['retry-after'] !== undefined ? meta['retry-after'] : '')).trim();
if (raw) { serverS = /^\d+(\.\d+)?$/.test(raw) ? Number(raw) : (Number.isFinite(Date.parse(raw)) ? Math.max(0, (Date.parse(raw) - Date.now()) / 1000) : null); }
const resetRaw = String(headers['x-ratelimit-reset'] !== undefined ? headers['x-ratelimit-reset'] : (meta['x-ratelimit-reset'] !== undefined ? meta['x-ratelimit-reset'] : '')).trim();
if (serverS === null && cls === 'rate_limited' && /^\d{9,}$/.test(resetRaw)) {   // epoch milliseconds (or seconds): only used as a hint
  const t = Number(resetRaw) > 1e11 ? Number(resetRaw) : Number(resetRaw) * 1000;
  if (t > Date.now()) serverS = (t - Date.now()) / 1000;
}
if (serverS !== null && serverS > capS) return fail(`server asked to wait ${Math.round(serverS)} s, more than the ${capS} s limit`);
const backoff = Math.min(capS, baseS * 2 ** (attempt - 1));
const waitS = serverS !== null ? serverS + Math.random() : backoff / 2 + Math.random() * (backoff / 2);
return [{ json: { retry: true, body: req.body, wait_seconds: Math.min(capS, Math.max(1, Math.ceil(waitS))), attempt, class: cls, status, reason: short(msg, 120) } }];
