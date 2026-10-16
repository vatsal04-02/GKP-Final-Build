// CLAUDE.md rules 4 and 5: sent flag, Opted_Out, Automation_Paused (this is not a transactional message), quiet hours, TEST_MODE.
// A patient without a valid phone number is never messaged, not even in TEST_MODE.
const { phone: patient_phone } = normalizeIndianPhone($json.lead_phone);
const { phone: test_phone } = normalizeIndianPhone($json.test_phone);
const decision = patient_phone
  ? decideSend({
    kind: 'marketing',
    flag_value: $json.flag_value,
    opted_out: $json.opted_out,
    automation_paused: $json.automation_paused,
    patient_phone,
    test_mode: $json.test_mode,
    test_phone,
    now_ms: Date.now(),
  })
  : { send: false, to: null, reason: 'no valid patient phone', test_mode: isTestMode($json.test_mode) };
return { json: { ...$json, patient_phone, decision, send: decision.send } };
