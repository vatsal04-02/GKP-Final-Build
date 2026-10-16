// Appointment changes the plan needs BEFORE the reply goes out (direct booking, WhatsApp-booked cancel / reschedule).
const c = $('W13 – Resolve Clinic').first().json;
return $json.plan.action_writes.map((w) => ({ json: { ...w, grist_base_url: c.grist_base_url, doc_id: c.doc_id } }));
