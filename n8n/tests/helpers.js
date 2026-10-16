const fs = require('fs');
const path = require('path');
const { FakeGrist } = require('./n8n-sim');
const REPO = process.env.REPO || path.join(__dirname, '..', '..');
const load = (f) => JSON.parse(fs.readFileSync(path.join(REPO, 'n8n/workflows', f), 'utf8'));
// set Config-node values (placeholders in the repo) for a simulated run
const withConfig = (wf, values) => {
  const c = JSON.parse(JSON.stringify(wf));
  const cfg = c.nodes.find((n) => n.name === 'Config');
  for (const a of cfg.parameters.assignments.assignments) if (a.name in values) a.value = values[a.name];
  return c;
};
const clinicRow = (id, slug, doc, active = true) => ({ id, fields: { Clinic_Slug: slug, Clinic_Name: slug.toUpperCase(), Grist_Doc_ID: doc, WA_Phone_Number_ID: '', Active: active } });
const freshGrist = (extra = {}) => new FakeGrist({
  REG: { Clinics: [clinicRow(1, 'demo-physio', 'DOCA'), clinicRow(2, 'old-clinic', 'DOCB', false)] },
  DOCA: { Leads: [], Appointments: [], Run_Log: [], Settings: [{ id: 1, fields: { Key: 'clinic_name', Value: 'Demo Physio' } }, { id: 2, fields: { Key: 'TEST_MODE', Value: 'false' } }, { id: 3, fields: { Key: 'TEST_PHONE', Value: '9000000001' } }] },
  DOCB: { Leads: [], Appointments: [], Run_Log: [], Settings: [] },
  ...extra,
});
module.exports = { load, withConfig, freshGrist, clinicRow, REPO };
