// The AI's answer is checked line by line (cmCheckAiReport: a line quoting a number that is not in the computed data is dropped);
// no answer / bad answer = the report is written from the numbers alone. Sections 2-6 are always written by code.
const x = $('W9 – Metrics').item.json;
const ai = cmCheckAiReport($json, cmAllowedNumbers(x.metrics));
const rep = cmRenderReport(x.metrics, ai, x.clinic_name, x.window, x.review_link_set);
const { body, ...rest } = x;
return {
  json: {
    ...rest,
    report: rep.text, headline: rep.headline, top_action: rep.top_action, ai_error: ai.error, ai_dropped: ai.dropped,
    owner_send: x.owner_on === true,
    log: { Workflow: 'W9-weekly-report', Record: rep.text, Outcome: 'ok', Error: ai.error ? `AI text not used: ${ai.error}`.slice(0, 500) : '', At: Math.floor(Date.now() / 1000) },
  },
};
