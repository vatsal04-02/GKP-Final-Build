// The item for W12 (free text inside the 24 h window, else the approved template) + the claim: the sent flag is written BEFORE the
// send (next node). If that write fails, nothing is sent and W11 alerts; a message is never sent twice.
const now = Math.floor(Date.now() / 1000);
const message = cmPatientMessage($json, $json.clinic_name, now);
const flag = $json.kind === 'outcome' ? 'Outcome_Sent' : 'Review_Sent';
return {
  json: {
    ...$json,
    ...message,
    audience: 'patient',
    source_workflow: '%WF%',
    lead_phone: $json.patient_phone,
    claim: { records: [{ id: $json.appt_row_id, fields: { [flag]: now } }] },
  },
};
