// WhatsApp gives the sender as digits with the country code (919000000011). Store ONE form only: +91XXXXXXXXXX (CLAUDE.md rule 7).
const { phone, valid } = normalizeIndianPhone($json.from);
return {
  json: {
    ...$json,
    patient_phone: phone,
    phone_valid: valid,
    run_outcome: valid ? '' : 'skipped',
    run_error: valid ? '' : 'sender number is not a valid Indian mobile (+91XXXXXXXXXX); nothing was stored',
  },
};
