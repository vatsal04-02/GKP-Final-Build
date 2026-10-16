// Claude's answer -> checked decision -> plan (what to write, what to send). Claude never sends: W12 does, after these checks.
// Also the plan for messages the gates stopped (skip, STOP, night, media, rate limit) and for a failed claim.
const b = $('W13 – Build Context').first().json;
let plan;
let decision = null;
let ai_error = '';
let usage = null;
if ($json.claim_error) plan = aiGatePlan({ route: 'failed', reason: `could not mark the message as processing: ${$json.claim_error}` }, b.x, b.cfg);
else if (b.gate.route !== 'ai') plan = aiGatePlan(b.gate, b.x, b.cfg);
else {
  usage = $json.usage ? { ...$json.usage, model: $json.usage.model || $json.model || '' } : null;
  const parsed = aiParseResponse($json);
  const problems = parsed.ok ? aiValidateDecision(parsed.decision) : [];
  if (parsed.ok && !problems.length) decision = parsed.decision;
  else ai_error = parsed.ok ? `invalid decision: ${problems.slice(0, 3).join('; ')}` : parsed.error;
  plan = aiPlan(decision, b.x, b.cfg);
  if (ai_error) plan.reason = `${plan.reason}: ${ai_error}`.slice(0, 300);
}
return [{ json: { plan, decision, ai_error, usage, decided_at: Date.now(), dry_run: b.x.dry_run } }];
