  if (d.action === 'offer_slots' || d.action === 'book_slot') {
    if (!x.slots.known) {
      if (!x.profile.booking_link) return handoff(`the patient wants an appointment but the booking system cannot offer times right now (${x.slots.reason || 'availability unknown'})`);
      if (aiTimesIn(plan.reply).length) plan.reply = 'Please choose a free time here: {{BOOKING_LINK}}';
      if (!plan.reply.includes('{{BOOKING_LINK}}')) plan.reply += '\n{{BOOKING_LINK}}';
      plan.route = 'offer_slots';
      return null;
    }
    if (d.booking.date && !x.calendar.some((c) => c.date === d.booking.date)) return handoff(`the requested date ${d.booking.date} is outside the next ${x.calendar.length} days`);
  }
  if (d.action === 'offer_slots') {
    // every time in the reply must be free on the day asked about (or on any day if no day was given)
    const okTimes = new Set(d.booking.date ? freeOn(d.booking.date) : x.slots.days.flatMap((s) => s.times));
    if (aiTimesIn(plan.reply).some((readings) => !readings.some((m) => okTimes.has(m) || m === x.slots.open || m === x.slots.close))) {
      const fallback = offerText(d.booking.date, 'Here are the free times.');
      if (!fallback) return handoff('no free times to offer');
      plan.reply = fallback;
      plan.notes.push('the AI offered a time that is not free; replaced by the real free times');
    }
    plan.route = 'offer_slots';
    plan.booking_date = d.booking.date;
    return null;
  }

  // Slice 4C: nothing below writes to Grist. A booking, a cancellation or a move is a request to the FLOW HQ booking API (plan.central), made only after the
  // patient said YES to a question naming the exact day and time, and reported to the patient only after the API confirmed it (aiApplyCentral).
  if (d.action === 'book_slot') {
    const date = d.booking.date;
    const time = d.booking.time;
    if (!date || !time || !freeOn(date).includes(toMin(time))) {
      const fallback = offerText(date, 'Sorry, that time is not available.');
      if (!fallback) return handoff('the requested time is not free and there are no free times to offer');
      plan.reply = fallback;
      plan.route = 'offer_slots';
      plan.booking_date = date;
      plan.notes.push(`requested ${date || '?'} ${time || '?'} is not a free slot`);
      return null;
    }
    const m = toMin(time);
    const slot = x.slots.by_key[`${date}|${time}`];
    if (!slot) return handoff('the booking system gave no bookable slot for the requested time');
    if (!x.lead.phone) return handoff('the patient has no valid phone number on file, so the booking cannot be made');
    const label = `${aiDayLabel(date)} at ${ai12h(m)}`;
    const text = slot.doctor_name ? `${label} with ${slot.doctor_name}` : label;
    plan.booking_date = date;
    if (!aiConfirmed(x, 'book', text)) {
      plan.reply = aiConfirmAsk('book', text);   // the AI's own wording is not used: it must not say "booked" and it must name the exact time
      plan.route = 'offer_slots';
      plan.notes.push('asked the patient to confirm before booking');
      return null;
    }
    plan.central = { op: 'create', slot_id: slot.slot_id, label, doctor_name: slot.doctor_name, idem_key: aiIdemKey(x.msg.wa_message_id, slot.slot_id),
      patient: { name: x.lead.name || 'WhatsApp patient', phone: x.lead.phone }, service: plan.lead_patch.Likely_Service || 'Physiotherapy', reason: aiLine(x.lead.enquiry, 300) };
    plan.reply = `Booking ${text}...`;   // replaced by aiApplyCentral once the booking system has answered
    plan.route = 'book_slot';
    return null;
  }

  if (d.action === 'cancel_appointment' || d.action === 'reschedule_appointment') {
    const resched = d.action === 'reschedule_appointment';
    if (x.appointments_unknown) return handoff('the appointments could not be read');
    if (!x.appointments.length) return handoff(`${resched ? 'reschedule' : 'cancel'} requested but this patient has no upcoming appointment`);
    const a = appt();
    if (!a) {
      plan.reply = `Which appointment do you mean? ${x.appointments.map((y, i) => `${i + 1}) ${y.label}`).join(', ')}`;
      plan.route = 'reply';
      plan.notes.push('several appointments: asked which one');
      return null;
    }
    if (!x.lead.phone) return handoff('the patient has no valid phone number on file, so the appointment cannot be changed');
    if (!resched) {
      if (!aiConfirmed(x, 'cancel', a.label)) {
        plan.reply = aiConfirmAsk('cancel', a.label);
        plan.route = 'reply';
        plan.notes.push('asked the patient to confirm before cancelling');
        return null;
      }
      plan.central = { op: 'cancel', reference: a.uid, label: a.label, patient_phone: x.lead.phone };
      plan.reply = `Cancelling your appointment on ${a.label}...`;
      plan.route = 'cancelled';
      return null;
    }
    const date = d.booking.date;
    const time = d.booking.time;
    if (!date || !time || !freeOn(date).includes(toMin(time))) {
      const fallback = offerText(date, date && time ? 'Sorry, that time is not available.' : 'Sure.');
      if (!fallback) return handoff('reschedule requested but there are no free times to offer');
      if (!date || !time) { if (aiTimesIn(plan.reply).length) plan.reply = fallback; plan.route = 'offer_slots'; return null; }
      plan.reply = fallback;
      plan.route = 'offer_slots';
      return null;
    }
    const m = toMin(time);
    const slot = x.slots.by_key[`${date}|${time}`];
    if (!slot) return handoff('the booking system gave no bookable slot for the requested time');
    const label = `${aiDayLabel(date)} at ${ai12h(m)}`;
    const text = `from ${a.label} to ${slot.doctor_name ? `${label} with ${slot.doctor_name}` : label}`;
    if (!aiConfirmed(x, 'reschedule', text)) {
      plan.reply = aiConfirmAsk('reschedule', text);
      plan.route = 'offer_slots';
      plan.notes.push('asked the patient to confirm before moving the appointment');
      return null;
    }
    plan.central = { op: 'reschedule', reference: a.uid, slot_id: slot.slot_id, label, from_label: a.label, doctor_name: slot.doctor_name, patient_phone: x.lead.phone };
    plan.reply = `Moving your appointment to ${label}...`;
    plan.route = 'rescheduled';
    return null;
  }

