// Schedule: appointment booking control for staff. Top: the Booking Control panel (the WhatsApp AI switch for admins, shifts, today's numbers, who is working).
// Below: the day calendar, the appointments table, doctors and hours, settings and the history. Every change goes through the one booking service on the server.
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CalendarPlus, Power, ShieldAlert } from 'lucide-react';
import { api, ws as wsPath } from '../lib/api';
import { useWs } from '../lib/workspace';
import { cn } from '../lib/cn';
import { Page } from '../components/layout/Shell';
import { Badge, Button, Card, Segmented, StatusDot, Switch } from '../components/ui/primitives';
import { ErrorState, Skeleton, useToast } from '../components/ui/feedback';
import { AppointmentDrawer } from './schedule/AppointmentDrawer';
import { AppointmentsList } from './schedule/AppointmentsList';
import { BookingDialog } from './schedule/BookingDialog';
import { DayCalendar } from './schedule/DayCalendar';
import { DoctorsTab } from './schedule/DoctorsTab';
import { WeekCalendar } from './schedule/WeekCalendar';
import { AuditTab, SettingsTab } from './schedule/SettingsTab';
import { PaymentsTab } from './schedule/PaymentsTab';
import { Confirm, problem, when, type Overview } from './schedule/shared';

type Tab = 'calendar' | 'week' | 'list' | 'doctors' | 'settings' | 'audit' | 'payments';
interface Pending { title: string; body: string; label: string; danger?: boolean; values: Record<string, string> }
const WORKING: Record<string, { text: string; tone: 'green' | 'amber' | 'neutral' | 'red' }> = { working: { text: 'Working today', tone: 'green' }, on_leave: { text: 'On leave today', tone: 'amber' }, inactive: { text: 'Not taking bookings', tone: 'neutral' }, not_scheduled: { text: 'No hours today', tone: 'neutral' } };

function Stat({ label, value, tone }: { label: string; value: number; tone?: string }) {
  // One cell of a ruled row, not a card of its own: figure first, plain label under it.
  return <div className="bg-surface px-5 py-3.5"><div className={cn('num-display text-[28px] leading-none', tone)}>{value}</div><div className="label mt-1.5">{label}</div></div>;
}

function ControlPanel({ ov, admin }: { ov: Overview; admin: boolean }) {
  const { ws } = useWs(); const qc = useQueryClient(); const toast = useToast();
  const [pending, setPending] = useState<Pending | null>(null);
  const save = useMutation({
    mutationFn: (values: Record<string, string>) => api(wsPath(ws.id, '/schedule/settings'), { method: 'PUT', body: { values } }),
    onSuccess: () => { setPending(null); void qc.invalidateQueries({ queryKey: ['sched', ws.id] }); toast('ok', 'Saved. It applies to the very next booking request.'); },
    onError: (e) => { setPending(null); toast('bad', problem(e)); },
  });
  const ai = ov.ai_booking; const on = ai.setting; const stopped = on && !ai.available;
  const flip = () => setPending(on
    ? { title: 'Turn AI booking OFF?', label: 'Turn OFF', danger: true, values: { booking_enabled: 'off' }, body: 'The WhatsApp assistant will stop being offered times and cannot create new bookings. Existing appointments stay as they are, and staff can still book, move and cancel.' }
    : { title: 'Turn AI booking ON?', label: 'Turn ON', values: { booking_enabled: 'on' }, body: 'The WhatsApp assistant will be able to offer free times and book them for patients, right away. Check the doctors, hours and settings first. Every booking is still checked on the server.' });
  const shift = (k: 'morning' | 'evening', v: boolean) => setPending({ title: `${v ? 'Switch on' : 'Switch off'} the ${k} shift?`, label: v ? 'Switch on' : 'Switch off', danger: !v, values: { [`shift_${k}_enabled`]: v ? 'on' : 'off' }, body: v ? `The ${k} shift will be offered for booking again.` : `No new bookings (AI or staff) can be made in the ${k} shift while it is off. Existing appointments stay.` });
  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3 px-5 py-4">
        <div className="min-w-0 flex-1 basis-80">
          <div className="flex flex-wrap items-center gap-2.5"><h2 className="text-base font-semibold">WhatsApp AI booking</h2><Badge tone={stopped ? 'red' : on ? 'green' : 'amber'} icon={stopped ? <ShieldAlert className="h-3 w-3" /> : <Power className="h-3 w-3" />}>{stopped ? 'ON, but stopped for safety' : on ? 'ON' : 'OFF'}</Badge></div>
          <p className="mt-1 max-w-[62ch] text-[13.5px] text-fg-2">
            {stopped ? 'The booking settings have a problem, so the assistant cannot book. Staff can still book.' : on ? 'The assistant can offer free times and book them after the patient confirms. Staff can also book, move and cancel.' : 'New AI bookings are disabled. Existing appointments are untouched, and staff can still book, move and cancel.'}
          </p>
          {stopped && ai.problems.length > 0 && <ul className="mt-1.5 list-disc pl-5 text-[12.5px] text-bad">{ai.problems.slice(0, 4).map((p) => <li key={p}>{p}</li>)}</ul>}
        </div>
        {admin ? <div className="flex items-center gap-3"><span className="text-[13px] font-medium text-fg-2">{on ? 'On' : 'Off'}</span><Switch checked={on} label="WhatsApp AI booking" onChange={flip} /></div> : <span className="text-[12.5px] text-muted">Only an admin can change this</span>}
      </div>
      {ov.audit_health && (ov.audit_health.level !== 'ok' || (!ov.audit_health.durable && !ws.demo)) && (
        <div role="alert" className={cn('border-t px-5 py-3 text-[13px]', ov.audit_health.level === 'red' || !ov.audit_health.durable ? 'border-bad/30 bg-bad/10 text-bad' : 'border-warn/30 bg-warn/10 text-warn')}>
          <div className="flex items-center gap-2 font-semibold"><AlertTriangle className="h-4 w-4" />{ov.audit_health.level === 'red' || !ov.audit_health.durable ? 'The change log is not safe: bookings may be paused' : 'The change log is catching up'}</div>
          <ul className="mt-1 list-disc pl-5">{(ov.audit_health.reasons.length ? ov.audit_health.reasons : ['The change log is not stored durably (this is a test setup).']).slice(0, 5).map((r) => <li key={r}>{r}</li>)}</ul>
          <p className="mt-1 text-[12px] opacity-90">{ov.audit_health.waiting_to_flush + ov.audit_health.open_intents} entr{ov.audit_health.waiting_to_flush + ov.audit_health.open_intents === 1 ? 'y' : 'ies'} waiting. Bookings already saved are safe; the log is kept on disk and retried. If bookings are being refused, the disk or volume needs fixing: see the operations guide.</p>
        </div>
      )}
      <div className="grid grid-cols-2 gap-px overflow-hidden border-t border-line bg-line sm:grid-cols-3 lg:grid-cols-5">
        <Stat label="Appointments today" value={ov.today_counts.appointments} /><Stat label="Free slots" value={ov.today_counts.available_slots} tone="text-ok" /><Stat label="Booked slots" value={ov.today_counts.occupied_slots} />
        <Stat label="Cancelled today" value={ov.today_counts.cancelled} tone={ov.today_counts.cancelled ? 'text-warn' : undefined} /><Stat label="Upcoming (7 days)" value={ov.upcoming} />
      </div>
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3 border-t border-line px-5 py-3">
        <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5">{ov.doctors.map((d) => <span key={d.doctor_id} className="inline-flex items-center gap-2 text-[13px]"><StatusDot tone={WORKING[d.today]!.tone} /><span className="font-semibold">{d.name}</span><span className="text-fg-2">{WORKING[d.today]!.text}</span></span>)}</div>
        <div className="ml-auto flex flex-wrap items-center gap-5 text-[13px]">
          {(['morning', 'evening'] as const).map((k) => <span key={k} className="inline-flex items-center gap-2 capitalize text-fg-2">{k} shift{admin ? <Switch checked={ov.shifts[k]} label={`${k} shift`} onChange={(v) => shift(k, v)} /> : <Badge tone={ov.shifts[k] ? 'green' : 'neutral'}>{ov.shifts[k] ? 'On' : 'Off'}</Badge>}</span>)}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-line bg-surface-2 px-5 py-2 text-[12.5px] text-fg-2">
        <span>{ov.last_config_update ? `Settings last changed ${when(ov.last_config_update.at)} by ${ov.last_config_update.by || 'unknown'}` : 'Settings not changed yet'}</span><span>Clinic time zone: {ov.timezone}</span>
        {ov.audit_health && ov.audit_health.level !== 'ok' && <span className="inline-flex items-center gap-1 font-medium text-bad"><AlertTriangle className="h-3.5 w-3.5" />Change log needs attention (see above)</span>}
      </div>
      <Confirm open={!!pending} title={pending?.title || ''} body={pending?.body} confirmLabel={pending?.label || 'Confirm'} danger={pending?.danger} busy={save.isPending} onClose={() => setPending(null)} onConfirm={() => pending && save.mutate(pending.values)} />
    </Card>
  );
}

export default function Schedule() {
  const { ws, me } = useWs(); const admin = me.user.role === 'admin';
  const [tab, setTab] = useState<Tab>('calendar'); const [open, setOpen] = useState<string | null>(null); const [booking, setBooking] = useState<{ date: string; slotId: string } | 'new' | null>(null);
  const ov = useQuery({ queryKey: ['sched', ws.id, 'overview'], queryFn: () => api<Overview>(wsPath(ws.id, '/schedule/overview')), refetchInterval: 60000 });
  const doctors = (ov.data?.doctors || []).map((d) => ({ doctor_id: d.doctor_id, name: d.name, qualification: d.qualification, default_shift: d.default_shift, active: d.active, notes: '' }));
  const tabs = [{ value: 'calendar', label: 'Day calendar' }, { value: 'week', label: 'Week' }, { value: 'list', label: 'Appointments' }, { value: 'doctors', label: 'Doctors & hours' }, { value: 'settings', label: 'Settings' }, ...(me.user.clinician && !admin ? [] : [{ value: 'payments', label: 'Payments' }]), ...(admin ? [{ value: 'audit', label: 'History' }] : [])] as Array<{ value: Tab; label: string }>;
  return (
    <Page wide title="Schedule" subtitle="Book, move and cancel appointments, manage doctors and hours, and control WhatsApp AI booking."
      actions={<Button variant="primary" icon={<CalendarPlus className="h-4 w-4" />} onClick={() => setBooking('new')}>New appointment</Button>}>
      <div className="space-y-5">
        {ov.isLoading ? <Card className="p-5"><Skeleton className="h-6 w-1/3" /><Skeleton className="mt-4 h-20 w-full" /></Card>
          : ov.isError ? <Card><ErrorState error={ov.error} retry={() => ov.refetch()} /></Card>
          : <ControlPanel ov={ov.data!} admin={admin} />}
        <Segmented variant="tabs" value={tab} onChange={setTab} options={tabs} />
        {tab === 'calendar' && <DayCalendar doctors={doctors} onOpen={setOpen} onBook={(date, slotId) => setBooking({ date, slotId })} />}
        {tab === 'week' && <WeekCalendar doctors={doctors} onOpen={setOpen} />}
        {tab === 'list' && <AppointmentsList doctors={doctors} onOpen={setOpen} />}
        {tab === 'doctors' && <DoctorsTab />}
        {tab === 'settings' && <SettingsTab />}
        {tab === 'payments' && <PaymentsTab admin={admin} />}
        {tab === 'audit' && admin && <AuditTab />}
      </div>
      <AppointmentDrawer reference={open} onClose={() => setOpen(null)} />
      <BookingDialog open={!!booking} initial={booking && booking !== 'new' ? booking : null} onClose={() => setBooking(null)} />
    </Page>
  );
}
