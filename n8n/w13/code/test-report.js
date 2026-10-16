// One line per test case: what the AI decided and what W13 would have sent (nothing was sent or written).
const cases = $('W13 – Test Messages').all();
return $input.all().map((it, i) => {
  const r = it.json || {};
  const c = (cases[i] && cases[i].json) || {};
  return { json: {
    test_case: c.test_case, message: c.text, expect: c.test_expect,
    status: r.status || (r.error ? 'error' : ''), intent: r.intent, route: r.route, needs_human: r.needs_human,
    reply: r.reply, reason: r.reason, would_send: r.would_send, ai_error: r.ai_error || (r.error ? String(r.error.message || r.error) : ''),
  } };
});
