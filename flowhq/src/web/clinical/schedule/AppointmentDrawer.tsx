// One appointment: who, when, who booked it (AI or staff), its history, and the staff actions (status, move, cancel).
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarClock, CheckCircle2, LogIn, XCircle, UserX } from 'lucide-react';
import { api, ws as wsPath } from '../../lib/api';
import { useWs } from '../../lib/workspace';
import { Button, Textarea } from '../../components/ui/primitives';
import { Drawer, Skeleton, useToast } from '../../components/ui/feedback';
import { Field, useToday } from '../common';
import { SlotPicker } from './BookingDialog';
import { ConsentPanel } from './ConsentPanel';
import { Confirm, SourceBadge, StatusBadge, fdateLong, problem, when, type Appt, type Overview, type Status } from './shared';

interface Reminder { state: 'will_send' | 'held' | 'not_applicable'; reasons: string[]; r24_sent_at: string | null; r2_sent_at: string | null }
interface Detail { appointment: Appt; history: Array<{ at: string | null; actor: string; source: string; action: string; outcome: string; reason: string }>; reminder?: Reminder }
const REMINDER_HEAD = { will_send: ['Automatic reminders will be sent', 'text-ok'], held: ['Automatic reminders will NOT be sent', 'text-bad'], not_applicable: ['No reminders for this appointment', 'text-muted'] } as const;
const ACTION_TEXT: Record<string, string> = { create: 'Booked', reschedule: 'Moved', cancel: 'Cancelled', status: 'Status changed' };

export function AppointmentDrawer({ reference, onClose }: { reference: string | null; onClose: () => void }) {
  const { ws, me } = useWs(); const toast = useToast(); const qc = useQueryClient(); const today = useToday();
  const [moving, setMoving] = useState(false); const [date, setDate] = useState(today); const [slot, setSlot] = useState(''); const [cancelling, setCancelling] = useState(false); const [reason, setReason] = useState('');
  const q = useQuery({ queryKey: ['sched', ws.id, 'appt', reference], queryFn: () => api<Detail>(wsPath(ws.id, `/schedule/appointments/${encodeURIComponent(reference!)}`)), enabled: !!reference });
  const done = (msg: string) => { toast('ok', msg); void qc.invalidateQueries({ queryKey: ['sched', ws.id] }); };
  const status = useMutation({ mutationFn: (s: Status) => api(wsPath(ws.id, `/schedule/appointments/${encodeURIComponent(reference!)}/status`), { method: 'POST', body: { status: s } }), onSuccess: (_r, s) => done(`Marked ${s.toLowerCase()}`), onError: (e) => toast('bad', problem(e)) });
  const move = useMutation({ mutationFn: () => api(wsPath(ws.id, `/schedule/appointments/${encodeURIComponent(reference!)}`), { method: 'PATCH', body: { slot_id: slot } }), onSuccess: () => { setMoving(false); setSlot(''); done('Appointment moved'); }, onError: (e) => { toast('bad', problem(e)); void qc.invalidateQueries({ queryKey: ['sched', ws.id, 'day'] }); setSlot(''); } });
  const cancel = useMutation({ mutationFn: () => api(wsPath(ws.id, `/schedule/appointments/${encodeURIComponent(reference!)}/cancel`), { method: 'POST', body: { reason } }), onSuccess: () => { setCancelling(false); setReason(''); done('Appointment cancelled'); }, onError: (e) => toast('bad', problem(e)) });
  const ov = useQuery({ queryKey: ['sched', ws.id, 'overview'], queryFn: () => api<Overview>(wsPath(ws.id, '/schedule/overview')), enabled: !!reference });
  const a = q.data?.appointment; const final = a ? a.status === 'Cancelled' : false; const closed = a ? ['Cancelled', 'Completed', 'No-show'].includes(a.status) : true;
  // A doctor's login may act only on its own doctor's appointments: compared by the stable Doctor_ID the server resolved for this login. The server still decides every write.
  const own = ov.data?.me; const canAct = me.user.role === 'admin' || !own?.is_doctor_login || (!!own.doctor_id && a?.doctor_id === own.doctor_id);
  return (
    <Drawer open={!!reference} onClose={() => { setMoving(false); setCancelling(false); onClose(); }} title={a ? a.patient.name || 'Appointment' : 'Appointment'} subtitle={a ? `${fdateLong(a.date)} · ${a.start_time}–${a.end_time}` : undefined} width={520}>
      {q.isLoading || !a ? <div className="space-y-3 p-5"><Skeleton className="h-5 w-2/3" /><Skeleton className="h-4 w-1/2" /><Skeleton className="h-24 w-full" /></div> : (
        <div className="space-y-5 p-5">
          <div className="flex flex-wrap items-center gap-2"><StatusBadge status={a.status} /><SourceBadge source={a.source} />{a.ai_created && <span className="text-[12px] text-muted">Made by the WhatsApp assistant</span>}</div>
          <dl className="grid gap-x-6 gap-y-3.5 sm:grid-cols-2 text-[13.5px]">
            {([['Reference', a.booking_reference], ['Doctor', a.doctor_name || '—'], ['Mobile', a.patient.phone || '—'], ['Register ID', a.patient.patient_id || 'Not linked'], ['Reason', a.reason || '—'], ['Service', a.service || '—'], ['Booked', when(a.created_at)], ['Last change', when(a.updated_at)]] as const).map(([k, v]) => (
              <div key={k}><dt className="text-[12.5px] text-fg-2">{k}</dt><dd className="mt-0.5 break-words font-medium text-fg">{v}</dd></div>))}
          </dl>

          {q.data?.reminder && (
            <section aria-label="Reminders" className="border-t border-line pt-4">
              <h4 className="section-title">WhatsApp reminders</h4>
              <p className={`mt-1.5 text-[13.5px] font-medium ${REMINDER_HEAD[q.data.reminder.state][1]}`}>{REMINDER_HEAD[q.data.reminder.state][0]}</p>
              {q.data.reminder.reasons.length > 0 && <ul className="mt-1.5 list-disc space-y-1 pl-5 text-[13px] text-fg-2">{q.data.reminder.reasons.map((r) => <li key={r}>{r}</li>)}</ul>}
              {(q.data.reminder.r24_sent_at || q.data.reminder.r2_sent_at) && <p className="mt-2 text-[12px] text-muted">{[q.data.reminder.r24_sent_at && `24-hour reminder sent ${when(q.data.reminder.r24_sent_at)}`, q.data.reminder.r2_sent_at && `2-hour reminder sent ${when(q.data.reminder.r2_sent_at)}`].filter(Boolean).join(' · ')}</p>}
            </section>
          )}

          {a.patient.phone && <ConsentPanel phone={a.patient.phone} patientId={a.patient.patient_id || undefined} />}

          {canAct && !closed && (
            <section className="space-y-2.5 border-t border-line pt-4" aria-label="Actions">
              <h4 className="section-title">Update</h4>
              <div className="flex flex-wrap gap-2">
                {a.status === 'Pending confirmation' && <Button size="sm" icon={<CheckCircle2 className="h-4 w-4" />} loading={status.isPending} onClick={() => status.mutate('Confirmed')}>Confirm</Button>}
                {a.status !== 'Checked in' && <Button size="sm" icon={<LogIn className="h-4 w-4" />} loading={status.isPending} onClick={() => status.mutate('Checked in')}>Check in</Button>}
                <Button size="sm" variant="subtle" icon={<CheckCircle2 className="h-4 w-4" />} loading={status.isPending} onClick={() => status.mutate('Completed')}>Mark completed</Button>
                <Button size="sm" icon={<UserX className="h-4 w-4" />} loading={status.isPending} onClick={() => status.mutate('No-show')}>No-show</Button>
              </div>
              <div className="flex flex-wrap gap-2 pt-1">
                <Button size="sm" icon={<CalendarClock className="h-4 w-4" />} onClick={() => setMoving((m) => !m)}>{moving ? 'Close' : 'Reschedule'}</Button>
                <Button size="sm" variant="danger" icon={<XCircle className="h-4 w-4" />} onClick={() => setCancelling(true)}>Cancel appointment</Button>
              </div>
              {moving && (
                <div className="rounded-lg border border-line bg-surface-2 p-4">
                  <SlotPicker date={date} onDate={setDate} value={slot} onChange={setSlot} />
                  <div className="mt-3 flex justify-end"><Button variant="primary" size="sm" disabled={!slot} loading={move.isPending} onClick={() => move.mutate()}>Move appointment</Button></div>
                </div>
              )}
            </section>
          )}
          {canAct && closed && !final && <div className="flex gap-2"><Button size="sm" onClick={() => status.mutate('Confirmed')} loading={status.isPending}>Reopen (set to Confirmed)</Button></div>}
          {!canAct && <p className="rounded-lg border border-line bg-surface-2 px-3 py-2 text-[13px] text-fg-2">{own?.doctor_id ? 'This belongs to another doctor. You can see it but not change it.' : 'Your login is not linked to a doctor yet, so you can only view. Ask the admin to link it.'}</p>}

          <section aria-label="History" className="border-t border-line pt-4">
            <h4 className="section-title mb-2.5">History</h4>
            {q.data!.history.length ? (
              <ol className="space-y-2 border-l border-line pl-4">{q.data!.history.map((h, i) => (
                <li key={i} className="relative text-[13px]"><span className="absolute -left-[20px] top-1.5 h-1.5 w-1.5 rounded-full bg-fg-2/60" />
                  <span className="font-medium">{ACTION_TEXT[h.action] || h.action}</span>{h.outcome === 'rejected' && <span className="text-bad"> (refused: {h.reason})</span>}
                  <span className="text-fg-2"> · {h.source === 'API' ? 'WhatsApp assistant' : h.actor}</span><div className="text-[12px] text-muted">{when(h.at)}</div></li>))}</ol>
            ) : <p className="text-[13px] text-fg-2">No recorded changes yet (this booking pre-dates the history log).</p>}
          </section>
        </div>
      )}
      <Confirm open={cancelling} title="Cancel this appointment?" danger confirmLabel="Cancel appointment" busy={cancel.isPending} onClose={() => setCancelling(false)} onConfirm={() => cancel.mutate()}
        body={<><p>{a ? `${a.patient.name} · ${fdateLong(a.date)} at ${a.start_time}.` : ''} The time becomes free again. The record is kept in the history, it is not deleted. No message is sent to the patient from here.</p><div className="mt-3"><Field label="Reason (optional)"><Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} maxLength={200} /></Field></div></>} />
    </Drawer>
  );
}
