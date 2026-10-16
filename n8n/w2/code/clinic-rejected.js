// This message belongs to no active clinic, so nothing is written: there is no clinic CRM to write to. Only the reason is kept (no phone numbers).
return { json: { outcome: 'ignored', reason: $json.clinic_reject_reason, phone_number_id: $json.phone_number_id, wa_message_id: $json.wa_message_id, test_case: $json.test_case } };
