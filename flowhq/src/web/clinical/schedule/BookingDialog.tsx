// Book an appointment by hand (staff). It uses the same booking service as the AI: the time is re-checked on the server at the moment of saving.
// Also holds the SlotPicker the reschedule form reuses.
import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import type { PatientProfile } from '@core/clinical';
import { api, ws as wsPath } from '../../lib/api';
import { useWs } from '../../lib/workspace';
import { cn } from '../../lib/cn';
import { Button, Input, Segmented, Textarea } from '../../components/ui/primitives';
import { Modal, useToast } from '../../components/ui/feedback';
import { Field, PatientPicker, useToday } from '../common';
import { fdateLong, problem, useIdemKey, type DayView } from './shared';

export function SlotPicker({ date, onDate, value, onChange, doctorId }: { date: string; onDate: (d: string) => void; value: string; onChange: (slotId: string) => void; doctorId?: string }) {
  const { ws } = useWs(); const today = useToday();
  const day = useQuery({ queryKey: ['sched', ws.id, 'day', date, doctorId || ''], queryFn: () => api<DayView>(wsPath(ws.id, `/schedule/day?date=${date}${doctorId ? `&doctor_id=${encodeURIComponent(doctorId)}` : ''}`)), enabled: /^\d{4}-\d{2}-\d{2}$/.test(date) });
  const open = (day.data?.slots || []).filter((s) => s.state === 'open');
  const byDoctor = useMemo(() => { const m = new Map<string, typeof open>(); for (const s of open) m.set(s.doctor_name, [...(m.get(s.doctor_name) || []), s]); return [...m]; }, [open]);
  return (
    <div>
      <Field label="Date"><Input type="date" min={today} value={date} onChange={(e) => { onDate(e.target.value); onChange(''); }} className="w-[11rem]" /></Field>
      <div className="mt-3 min-h-[3rem]" aria-live="polite">
        {day.isLoading ? <div className="flex items-center gap-2 text-[13px] text-fg-2"><Loader2 className="h-4 w-4 animate-spin" />Finding free times…</div>
          : day.isError ? <p className="text-[13px] text-bad" role="alert">Could not load the times for that day.</p>
          : day.data?.closed ? <p className="rounded-lg border border-line bg-surface-2 px-3 py-2 text-[13px] text-fg-2">{day.data.closed === 'not_operating_day' ? 'The clinic is closed on this day.' : day.data.closed === 'clinic_closure' ? 'The clinic is closed on this date.' : 'No bookings can be made for this date.'}</p>
          : !byDoctor.length ? <p className="rounded-lg border border-line bg-surface-2 px-3 py-2 text-[13px] text-fg-2">No free times on {fdateLong(date)}. Try another day, or check leave and blocked time.</p>
          : byDoctor.map(([name, list]) => (
            <div key={name} className="mb-3">
              <div className="label mb-1.5">{name}</div>
              <div className="flex flex-wrap gap-1.5">{list.map((s) => (
                <button key={s.slot_id} type="button" onClick={() => onChange(s.slot_id)} aria-pressed={value === s.slot_id}
                  className={cn('h-8 rounded-lg border px-2.5 text-[13px] font-medium transition-colors', value === s.slot_id ? 'border-blue bg-blue text-white' : 'border-line-2 bg-surface hover:border-blue/50 hover:bg-sage/40')}>{s.start_time}</button>
              ))}</div>
            </div>))}
      </div>
    </div>
  );
}

export function BookingDialog({ open, onClose, initial }: { open: boolean; onClose: () => void; initial?: { date: string; slotId: string } | null }) {
  const { ws } = useWs(); const today = useToday(); const toast = useToast(); const qc = useQueryClient();
  const [mode, setMode] = useState<'register' | 'new'>('register');
  const [picked, setPicked] = useState<{ id: string; name: string } | null>(null);
  const [name, setName] = useState(''); const [phone, setPhone] = useState('');
  const [date, setDate] = useState(initial?.date || today); const [slot, setSlot] = useState(initial?.slotId || '');
  const [reason, setReason] = useState(''); const [stage, setStage] = useState<'Confirmed' | 'Pending confirmation'>('Confirmed');
  const [err, setErr] = useState(''); const idem = useIdemKey();
  useEffect(() => { if (open) { setMode('register'); setPicked(null); setName(''); setPhone(''); setReason(''); setStage('Confirmed'); setErr(''); setDate(initial?.date || today); setSlot(initial?.slotId || ''); idem.renew(); } }, [open]);   // eslint-disable-line react-hooks/exhaustive-deps
  // choosing a register patient fills in the phone from their record (the server checks it matches)
  const prof = useQuery({ queryKey: ['patient', ws.id, picked?.id], queryFn: () => api<PatientProfile>(wsPath(ws.id, `/patients/${picked!.id}`)), enabled: !!picked });
  useEffect(() => { if (prof.data) { setName(prof.data.patient.name); setPhone(prof.data.patient.phone); } }, [prof.data]);
  const save = useMutation({
    mutationFn: () => api<{ appointment: { booking_reference: string; date: string; start_time: string } }>(wsPath(ws.id, '/schedule/appointments'), { method: 'POST', body: { slot_id: slot, idempotency_key: idem.key, patient: { name, phone, ...(mode === 'register' && picked ? { patient_id: picked.id } : {}) }, reason, stage } }),
    onSuccess: (r) => { toast('ok', `Booked ${r.appointment.date} at ${r.appointment.start_time} (${r.appointment.booking_reference})`); void qc.invalidateQueries({ queryKey: ['sched', ws.id] }); onClose(); },
    onError: (e) => { setErr(problem(e)); void qc.invalidateQueries({ queryKey: ['sched', ws.id, 'day'] }); setSlot(''); },
  });
  const ready = !!slot && name.trim().length > 0 && phone.trim().length > 0 && !(mode === 'register' && !picked);
  return (
    <Modal open={open} onClose={onClose} label="New appointment" className="max-w-2xl">
      <form onSubmit={(e) => { e.preventDefault(); setErr(''); if (ready) save.mutate(); }} className="max-h-[78vh] overflow-y-auto p-6">
        <h2 className="font-display text-xl font-semibold">New appointment</h2>
        <p className="mt-1 text-[13px] text-fg-2">Booked by staff. This works whether or not AI booking is switched on.</p>
        <div className="mt-4 space-y-4">
          <Segmented value={mode} onChange={(v) => { setMode(v); setPicked(null); setName(''); setPhone(''); }} options={[{ value: 'register', label: 'Patient in the register' }, { value: 'new', label: 'New person' }]} />
          {mode === 'register' ? (
            <Field label="Patient"><PatientPicker value={picked} onChange={setPicked} /></Field>
          ) : null}
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Name" required><Input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} disabled={mode === 'register'} /></Field>
            <Field label="Mobile number" required hint="10-digit Indian mobile, used for reminders"><Input value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" maxLength={30} disabled={mode === 'register' && !!prof.data?.patient.phone} /></Field>
          </div>
          <SlotPicker date={date} onDate={setDate} value={slot} onChange={setSlot} />
          <Field label="Reason for visit"><Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} maxLength={300} /></Field>
          <Field label="Status"><Segmented value={stage} onChange={setStage} options={[{ value: 'Confirmed', label: 'Confirmed' }, { value: 'Pending confirmation', label: 'Pending confirmation' }]} /></Field>
        </div>
        {err && <p className="mt-4 rounded-lg border border-bad/30 bg-bad/10 px-3 py-2 text-[13px] text-bad" role="alert">{err}</p>}
        <div className="mt-5 flex justify-end gap-2"><Button type="button" variant="ghost" onClick={onClose}>Cancel</Button><Button type="submit" variant="primary" loading={save.isPending} disabled={!ready}>Book appointment</Button></div>
      </form>
    </Modal>
  );
}
