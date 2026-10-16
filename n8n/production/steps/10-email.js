// STEP 10 - e-mail gateway (SMTP) for W1.
//  * the clinic gets an e-mail for every new / repeated website enquiry in addition to the WhatsApp alert (FLOWHQ_ALERT_EMAIL_TO; empty = no e-mail)
//  * optional acknowledgement to the person (FLOWHQ_EMAIL_PATIENT_ACK=true, default off): only a NEW lead with an address and Consent_Email, never in TEST_MODE,
//    never in quiet hours (21:00-08:00 IST), never when Email_Opted_Out; it quotes nothing the person wrote.
//  * SMTP is a credential ("FlowHQ SMTP", created by scripts/create-credentials.js from FLOWHQ_SMTP_*); locally Mailpit catches everything (docker-compose.staging.yml).
//  * a failed e-mail never loses the lead; it is written to Run_Log (and makes the run "failed" only when no alert reached the clinic at all)
const SMTP = { smtp: { id: 'FhqCredSmtp00001', name: 'FlowHQ SMTP' } };

module.exports = {
  id: '10-email',
  title: 'E-mail gateway: staff alert e-mail, optional patient acknowledgement',
  run(ctx) {
    ctx.setValue('W1 – Config', 'alert_email_to', "={{ $env.FLOWHQ_ALERT_EMAIL_TO || '' }}");
    ctx.setValue('W1 – Config', 'email_from', "={{ $env.FLOWHQ_EMAIL_FROM || '' }}");
    ctx.setValue('W1 – Config', 'email_patient_ack', "={{ $env.FLOWHQ_EMAIL_PATIENT_ACK === 'true' }}", 'boolean');
    ctx.editCode('W1 – Config Guard', [{
      find: 'if (problems.length) throw new Error(',
      replace: `const mailOk = (a) => /^[^\\s@<>",;]{1,64}@[^\\s@<>",;]+\\.[A-Za-z]{2,}$/.test(a);
const toList = String(cfg.alert_email_to || '').split(/[,;]+/).map((x) => x.trim()).filter(Boolean);
if (toList.length || cfg.email_patient_ack === true) {
  if (!mailOk(String(cfg.email_from || '').trim())) problems.push('FLOWHQ_EMAIL_FROM is not set or not an e-mail address');
  for (const a of toList) if (!mailOk(a)) problems.push('FLOWHQ_ALERT_EMAIL_TO holds an invalid address');
}
if (problems.length) throw new Error(`,
    }]);

    const base = ctx.node('W1 – Alert result').position;
    const at = (i, row = 0) => [base[0] + 224 * i, base[1] + 260 + 140 * row];
    ctx.codeNode('W1 – Email plan', `// E-mail for the clinic (always when FLOWHQ_ALERT_EMAIL_TO is set) and, if switched on, an acknowledgement for the person. Plain text, no tracking.
const j = $json;
const cfg = $('W1 – Config').first().json;
const clean = (s, n) => String(s === null || s === undefined ? '' : s).replace(/[\\u0000-\\u001f\\u007f]/g, ' ').replace(/\\s+/g, ' ').trim().slice(0, n);
const clinic = clean(j.clinic_name || j.clinic_slug, 100);
const emails = [];
const to = String(cfg.alert_email_to || '').split(/[,;]+/).map((x) => x.trim()).filter(Boolean);
const first = (s) => clean(s, 60).split(' ')[0] || 'there';
if (to.length) {
  const what = j.action === 'created' ? 'New website lead' : 'Existing lead enquired again';
  emails.push({ kind: 'staff', email_to: to.join(', '), email_from: cfg.email_from, subject: \`\${what}: \${clean(j.name, 60)} (\${clinic})\`.slice(0, 200), body: [\`\${what} for \${clinic}\`, '', \`Name: \${clean(j.name, 100)}\`, \`Phone: \${clean(j.phone, 30)}\`, j.email ? \`E-mail: \${clean(j.email, 120)}\` : '', \`Lead: \${clean(j.lead_id, 40)}\`, '', 'What they wrote:', clean(j.enquiry, 1000) || '(nothing)', '', 'WhatsApp alert: ' + (j.staff_alert_sent === true ? 'sent' : 'not sent (see Run_Log)')].filter((l, i, a) => l !== '' || (a[i - 1] !== '' && i > 0)).join('\\n') });
}
const hour = new Date(Date.now() + 5.5 * 3600 * 1000).getUTCHours();
const quiet = hour >= 21 || hour < 8;
const testMode = !!(j.decision && j.decision.test_mode);
let patient_note = '';
if (cfg.email_patient_ack === true && j.action === 'created' && j.email) {
  if (j.consent_email !== true) patient_note = 'no e-mail consent';
  else if (testMode) patient_note = 'TEST_MODE: no e-mail to patients';
  else if (quiet) patient_note = 'quiet hours: no e-mail to patients now';
  else emails.push({ kind: 'patient', email_to: j.email, email_from: cfg.email_from, subject: \`We received your enquiry - \${clinic}\`.slice(0, 200), body: \`Hello \${first(j.name)},\\n\\nThank you for contacting \${clinic}. We have received your enquiry and a member of the team will get back to you.\\n\\nThis is an automatic message. If you did not make this enquiry you can ignore it.\\n\` });
}
return { json: { ...j, emails, patient_note } };
`, at(0));
    ctx.ifNode('W1 – Has emails?', '={{ $json.emails.length > 0 }}', at(1));
    ctx.codeNode('W1 – Split emails', "// one item per e-mail\nreturn $input.first().json.emails.map((e) => ({ json: e }));\n", at(2, -1));
    ctx.add({
      name: 'W1 – Send email', type: 'n8n-nodes-base.emailSend', typeVersion: 2.1, position: at(3, -1), credentials: SMTP, onError: 'continueRegularOutput',
      parameters: { fromEmail: '={{ $json.email_from }}', toEmail: '={{ $json.email_to }}', subject: '={{ $json.subject }}', emailFormat: 'text', text: '={{ $json.body }}', options: {} },
    });
    ctx.codeNode('W1 – Email result', `// Fold the e-mail outcome into the Run_Log row. A failed e-mail never loses the lead. The run only counts as "failed" when NO alert reached the clinic (WhatsApp or e-mail).
const plan = $('W1 – Email plan').first().json;
const items = $input.all();
const sent = plan.emails.length && items.length === plan.emails.length && items.every((it) => it.json && (it.json.messageId !== undefined || it.json.accepted !== undefined || it.json.error !== undefined)) ? items : null;
const notes = [];
let staffMailOk = false;
if (sent) plan.emails.forEach((e, i) => {
  const err = sent[i].json.error;
  if (e.kind === 'staff') staffMailOk = !err;
  notes.push(err ? \`\${e.kind} e-mail failed: \${String(err.message || err).replace(/\\s+/g, ' ').slice(0, 120)}\` : \`\${e.kind} e-mail sent\`);
});
if (plan.patient_note) notes.push(plan.patient_note);
const log = { ...plan.log };
if (notes.length) log.Error = [log.Error, ...notes].filter(Boolean).join(' | ').slice(0, 500);
if (plan.emails.some((e) => e.kind === 'staff') && !staffMailOk && plan.staff_alert_sent !== true) log.Outcome = 'failed';
const { emails, patient_note, ...rest } = plan;
return { json: { ...rest, log, staff_email_sent: staffMailOk } };
`, at(4));

    ctx.setOutputs('W1 – Alert result', [['W1 – Email plan']]);
    ctx.setOutputs('W1 – Alert skipped', [['W1 – Email plan']]);
    ctx.setOutputs('W1 – Email plan', [['W1 – Has emails?']]);
    ctx.setOutputs('W1 – Has emails?', [['W1 – Split emails'], ['W1 – Email result']]);
    ctx.setOutputs('W1 – Split emails', [['W1 – Send email']]);
    ctx.setOutputs('W1 – Send email', [['W1 – Email result']]);
    ctx.setOutputs('W1 – Email result', [['W1 – Write Run_Log']]);
    ctx.log('10', 'W1: e-mail gateway: Email plan -> Has emails? -> Split emails -> Send email (SMTP credential "FlowHQ SMTP") -> Email result -> Run_Log; staff e-mail via FLOWHQ_ALERT_EMAIL_TO, optional acknowledgement via FLOWHQ_EMAIL_PATIENT_ACK (new lead + Consent_Email + not TEST_MODE + not quiet hours)');
  },
};
