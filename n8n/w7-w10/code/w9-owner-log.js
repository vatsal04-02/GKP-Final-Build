const ok = $json.sent === true;
return {
  json: {
    ...$json,
    log: { Workflow: 'W9-weekly-report', Record: `owner WhatsApp ${$json.week}`, Outcome: ok ? 'ok' : 'failed', Error: ok ? '' : String($json.send_error || $json.send_status || 'not sent').slice(0, 500), At: Math.floor(Date.now() / 1000) },
  },
};
