// One Run_Log row per attempt (the weekly report counts them). Not sent = failed, with W12's reason; the flag stays set (one attempt
// per visit: a broken template or number can never make this section message the patient again and again).
const ok = $json.sent === true;
const d = $json.decision || {};
return {
  json: {
    ...$json,
    log: {
      Workflow: '%WF%',
      Record: `${$json.booking_uid} ${$json.lead_id}${d.test_mode ? ' (TEST_MODE)' : ''}`.slice(0, 200),
      Outcome: ok ? 'ok' : 'failed',
      Error: ok ? '' : String($json.send_error || $json.send_status || 'not sent').slice(0, 500),
      At: Math.floor(Date.now() / 1000),
    },
  },
};
