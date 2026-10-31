// Doctors and their hours, leave and blocked time. Admins edit doctors and hours; front-desk staff add and remove leave and blocked time.
// Nothing is deleted: leave and blocks are switched off, hours are switched off. Existing appointments are never touched (the server lists any that fall inside new leave).
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarOff, Pencil, Plus, Trash2 } from 'lucide-react';
import { api, ws as wsPath } from '../../lib/api';
import { useWs } from '../../lib/workspace';
import { Badge, Button, Card, Input, Select, Switch, Textarea } from '../../components/ui/primitives';
import { EmptyState, ErrorState, Modal, SkeletonRows, useToast } from '../../components/ui/feedback';
import { Field, fdate } from '../common';
import { Confirm, problem, type BlockItem, type Doctor, type ScheduleItem, type Shift } from './shared';

interface DoctorsData { doctors: Doctor[]; schedules: ScheduleItem[]; blocks: BlockItem[]; problems: string[] }
const WEEK = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const BLOCK_KINDS = ['Doctor leave', 'Blocked time', 'Clinic closure'];

export function DoctorsTab() {
  const { ws, me } = useWs(); const qc = useQueryClient(); const toast = useToast();
  const isAdmin = me.user.role === 'admin'; const canBlocks = isAdmin || !me.user.clinician;
  const q = useQuery({ queryKey: ['sched', ws.id, 'doctors'], queryFn: () => api<DoctorsData>(wsPath(ws.id, '/schedule/doctors')) });
  const refresh = () => qc.invalidateQueries({ queryKey: ['sched', ws.id] });
  const [editing, setEditing] = useState<{ doctor: Doctor; row: ScheduleItem | null } | null>(null);
  const [blockOpen, setBlockOpen] = useState(false); const [removing, setRemoving] = useState<BlockItem | null>(null); const [deactivating, setDeactivating] = useState<Doctor | null>(null);
  const setActive = useMutation({ mutationFn: (v: { id: string; active: boolean }) => api(wsPath(ws.id, `/schedule/doctors/${encodeURIComponent(v.id)}`), { method: 'PATCH', body: { active: v.active } }), onSuccess: () => { setDeactivating(null); void refresh(); toast('ok', 'Doctor updated'); }, onError: (e) => toast('bad', problem(e)) });
  const toggleHours = useMutation({ mutationFn: (r: ScheduleItem) => api(wsPath(ws.id, `/schedule/schedules/${encodeURIComponent(r.schedule_id)}`), { method: 'PUT', body: scheduleBody({ ...r, active: !r.active }) }), onSuccess: () => { void refresh(); toast('ok', 'Hours updated'); }, onError: (e) => toast('bad', problem(e)) });
  const remove = useMutation({ mutationFn: (b: BlockItem) => api(wsPath(ws.id, `/schedule/blocks/${encodeURIComponent(b.block_id)}/deactivate`), { method: 'POST', body: {} }), onSuccess: () => { setRemoving(null); void refresh(); toast('ok', 'Removed. The times are open again.'); }, onError: (e) => toast('bad', problem(e)) });
  if (q.isLoading) return <Card><SkeletonRows rows={6} /></Card>;
  if (q.isError) return <Card><ErrorState error={q.error} retry={() => q.refetch()} /></Card>;
  const d = q.data!; const name = (id: string | null) => (id ? d.doctors.find((x) => x.doctor_id === id)?.name || id : 'Everyone');
  const live = d.blocks.filter((b) => b.active).sort((x, y) => (x.date_from < y.date_from ? -1 : 1));
  return (
    <div className="space-y-6">
      {d.problems.length > 0 && <p className="rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-[13px] text-warn" role="alert">Some booking settings need attention: {d.problems.join('; ')}. AI booking stays off until this is fixed.</p>}
      <div className="grid gap-4 xl:grid-cols-2">
        {d.doctors.map((doc) => {
          const rows = d.schedules.filter((s) => s.doctor_id === doc.doctor_id).sort((x, y) => WEEK.indexOf(x.weekday) - WEEK.indexOf(y.weekday) || x.start_time.localeCompare(y.start_time));
          return (
            <Card key={doc.doctor_id} className="overflow-hidden">
              <header className="flex items-start justify-between gap-3 border-b border-line px-4 py-3">
                <div><div className="flex items-center gap-2"><h3 className="text-[15px] font-semibold">{doc.name}</h3>{!doc.active && <Badge tone="neutral">Not taking bookings</Badge>}</div><div className="text-[12.5px] text-fg-2">{doc.qualification || 'Qualification not set'}{doc.default_shift ? ` · ${doc.default_shift} shift` : ''}</div></div>
                {isAdmin && <div className="flex items-center gap-2 text-[12.5px] text-fg-2">Active<Switch checked={doc.active} label={`${doc.name} active`} onChange={(v) => (v ? setActive.mutate({ id: doc.doctor_id, active: true }) : setDeactivating(doc))} /></div>}
              </header>
              <div className="px-4 py-3">
                <div className="mb-2 flex items-center justify-between"><div className="label">Weekly hours</div>{isAdmin && <Button size="sm" variant="secondary" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setEditing({ doctor: doc, row: null })}>Add hours</Button>}</div>
                {rows.length ? (
                  <ul className="divide-y divide-line">{rows.map((r) => (
                    <li key={r.schedule_id} className="flex items-center gap-3 py-2 text-[13px]">
                      <span className="w-10 font-medium">{r.weekday}</span><span className="num w-28">{r.start_time}–{r.end_time}</span>
                      <span className="min-w-0 flex-1 truncate text-fg-2">{r.slot_minutes ? `${r.slot_minutes} min` : 'default length'}{r.capacity ? ` · ${r.capacity} per slot` : ''}{r.effective_from || r.effective_to ? ` · ${r.effective_from ? fdate(r.effective_from) : 'start'} to ${r.effective_to ? fdate(r.effective_to) : 'no end'}` : ''}</span>
                      {r.is_override && <Badge tone="amber">Override</Badge>}
                      {isAdmin && <><Switch checked={r.active} label={`${r.weekday} ${r.start_time} hours active`} onChange={() => toggleHours.mutate(r)} /><Button size="sm" variant="ghost" aria-label={`Edit ${r.weekday} hours`} onClick={() => setEditing({ doctor: doc, row: r })}><Pencil className="h-3.5 w-3.5" /></Button></>}
                      {!isAdmin && !r.active && <Badge tone="neutral">Off</Badge>}
                    </li>))}</ul>
                ) : <p className="text-[13px] text-fg-2">No booking hours set. This doctor is not offered for booking.</p>}
              </div>
            </Card>);
        })}
      </div>

      <Card className="overflow-hidden">
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3"><div><h3 className="text-[15px] font-semibold">Leave, closures and blocked time</h3><p className="text-[12.5px] text-fg-2">Times here are not offered for booking. Appointments already made are not changed.</p></div>
          {canBlocks && <Button size="sm" variant="primary" icon={<CalendarOff className="h-4 w-4" />} onClick={() => setBlockOpen(true)}>Add leave or block time</Button>}</header>
        {live.length ? (
          <ul className="divide-y divide-line px-4">{live.map((b) => (
            <li key={b.block_id} className="flex flex-wrap items-center gap-3 py-2.5 text-[13px]">
              <Badge tone={b.kind === 'Clinic closure' ? 'red' : b.kind === 'Doctor leave' ? 'amber' : 'neutral'}>{b.kind}</Badge>
              <span className="font-medium">{name(b.doctor_id)}</span>
              <span className="text-fg-2">{b.date_from === b.date_to ? fdate(b.date_from) : `${fdate(b.date_from)} to ${fdate(b.date_to)}`}{b.start_time ? ` · ${b.start_time}–${b.end_time}` : ' · whole day'}{b.shift ? ` · ${b.shift}` : ''}</span>
              {b.reason && <span className="min-w-0 flex-1 truncate text-muted">{b.reason}</span>}
              {canBlocks && <Button size="sm" variant="ghost" className="ml-auto" icon={<Trash2 className="h-3.5 w-3.5" />} onClick={() => setRemoving(b)}>Remove</Button>}
            </li>))}</ul>
        ) : <EmptyState className="py-8" icon={<CalendarOff className="h-5 w-5" />} title="Nothing blocked" body="Add leave, a closure or blocked time and it stops being offered straight away." />}
      </Card>

      <ScheduleDialog target={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void refresh(); toast('ok', 'Hours saved'); }} />
      <BlockDialog open={blockOpen} doctors={d.doctors} onClose={() => setBlockOpen(false)} onSaved={() => void refresh()} />
      <Confirm open={!!removing} title="Remove this block?" confirmLabel="Remove" busy={remove.isPending} onClose={() => setRemoving(null)} onConfirm={() => removing && remove.mutate(removing)}
        body={removing ? <>{removing.kind} for {name(removing.doctor_id)}, {fdate(removing.date_from)}{removing.date_from !== removing.date_to ? ` to ${fdate(removing.date_to)}` : ''}. Those times become bookable again. It is switched off, not deleted, so it stays in the history.</> : null} />
      <Confirm open={!!deactivating} title={`Stop offering ${deactivating?.name}?`} danger confirmLabel="Stop offering" busy={setActive.isPending} onClose={() => setDeactivating(null)} onConfirm={() => deactivating && setActive.mutate({ id: deactivating.doctor_id, active: false })}
        body={<>No new bookings (by AI or staff) can be made for {deactivating?.name} until you switch them back on. Appointments already booked stay as they are.</>} />
    </div>
  );
}

const scheduleBody = (r: Pick<ScheduleItem, 'doctor_id' | 'weekday' | 'shift' | 'start_time' | 'end_time' | 'slot_minutes' | 'buffer_minutes' | 'capacity' | 'effective_from' | 'effective_to' | 'active' | 'is_override' | 'reason'>) => ({
  doctor_id: r.doctor_id, weekday: r.weekday, shift: r.shift, start_time: r.start_time, end_time: r.end_time, slot_minutes: r.slot_minutes, buffer_minutes: r.buffer_minutes, capacity: r.capacity, effective_from: r.effective_from, effective_to: r.effective_to, active: r.active, is_override: r.is_override, reason: r.reason,
});
const intOrNull = (v: string) => (v.trim() === '' ? null : Number(v));

function ScheduleDialog({ target, onClose, onSaved }: { target: { doctor: Doctor; row: ScheduleItem | null } | null; onClose: () => void; onSaved: () => void }) {
  const { ws } = useWs(); const row = target?.row; const doc = target?.doctor;
  const [f, setF] = useState({ weekday: 'Mon', shift: 'morning' as Shift, start: '09:00', end: '13:00', slot: '', buffer: '', capacity: '', from: '', to: '', override: false, reason: '', active: true });
  const [err, setErr] = useState(''); const [seen, setSeen] = useState<unknown>(null);
  if (target !== seen) { setSeen(target); if (target) { setErr(''); setF(row ? { weekday: row.weekday, shift: row.shift, start: row.start_time, end: row.end_time, slot: row.slot_minutes?.toString() || '', buffer: row.buffer_minutes?.toString() || '', capacity: row.capacity?.toString() || '', from: row.effective_from || '', to: row.effective_to || '', override: row.is_override, reason: row.reason, active: row.active } : { weekday: 'Mon', shift: doc?.default_shift || 'morning', start: doc?.default_shift === 'evening' ? '16:00' : '09:00', end: doc?.default_shift === 'evening' ? '20:00' : '13:00', slot: '', buffer: '', capacity: '', from: '', to: '', override: false, reason: '', active: true }); } }
  const save = useMutation({
    mutationFn: () => api(wsPath(ws.id, row ? `/schedule/schedules/${encodeURIComponent(row.schedule_id)}` : '/schedule/schedules'), { method: row ? 'PUT' : 'POST', body: scheduleBody({ doctor_id: doc!.doctor_id, weekday: f.weekday, shift: f.shift, start_time: f.start, end_time: f.end, slot_minutes: intOrNull(f.slot), buffer_minutes: intOrNull(f.buffer), capacity: intOrNull(f.capacity), effective_from: f.from || null, effective_to: f.to || null, active: f.active, is_override: f.override, reason: f.reason }) }),
    onSuccess: onSaved, onError: (e) => setErr(problem(e)),
  });
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));
  return (
    <Modal open={!!target} onClose={onClose} label="Doctor hours" className="max-w-xl">
      <form onSubmit={(e) => { e.preventDefault(); setErr(''); save.mutate(); }} className="max-h-[78vh] space-y-4 overflow-y-auto p-6">
        <div><h2 className="font-display text-lg font-semibold">{row ? 'Edit hours' : 'Add hours'} · {doc?.name}</h2><p className="mt-1 text-[13px] text-fg-2">Leave the length, buffer or capacity empty to use the clinic's default (see Settings).</p></div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Field label="Day"><Select value={f.weekday} onChange={(e) => set('weekday', e.target.value)}>{WEEK.map((d) => <option key={d}>{d}</option>)}</Select></Field>
          <Field label="Shift"><Select value={f.shift} onChange={(e) => set('shift', e.target.value as Shift)}><option value="morning">Morning</option><option value="evening">Evening</option></Select></Field>
          <Field label="From"><Input type="time" value={f.start} onChange={(e) => set('start', e.target.value)} /></Field>
          <Field label="To"><Input type="time" value={f.end} onChange={(e) => set('end', e.target.value)} /></Field>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <Field label="Minutes each"><Input inputMode="numeric" value={f.slot} onChange={(e) => set('slot', e.target.value)} placeholder="default" /></Field>
          <Field label="Buffer (min)"><Input inputMode="numeric" value={f.buffer} onChange={(e) => set('buffer', e.target.value)} placeholder="default" /></Field>
          <Field label="Per slot"><Input inputMode="numeric" value={f.capacity} onChange={(e) => set('capacity', e.target.value)} placeholder="default" /></Field>
        </div>
        <div className="grid grid-cols-2 gap-3"><Field label="Effective from"><Input type="date" value={f.from} onChange={(e) => set('from', e.target.value)} /></Field><Field label="Effective to"><Input type="date" value={f.to} onChange={(e) => set('to', e.target.value)} /></Field></div>
        <div className="rounded-xl border border-line bg-surface p-3">
          <label className="flex items-center gap-2 text-[13px] font-medium"><input type="checkbox" checked={f.override} onChange={(e) => set('override', e.target.checked)} className="h-4 w-4 accent-[rgb(var(--blue))]" />This is a temporary override</label>
          <p className="mt-1 text-[12px] text-fg-2">A doctor works their own shift. Covering the other shift, or changing hours for a period, must be an override with a reason and both dates.</p>
          {f.override && <div className="mt-3"><Field label="Reason"><Textarea rows={2} maxLength={200} value={f.reason} onChange={(e) => set('reason', e.target.value)} /></Field></div>}
        </div>
        {err && <p className="rounded-lg border border-bad/30 bg-bad/10 px-3 py-2 text-[13px] text-bad" role="alert">{err}</p>}
        <div className="flex justify-end gap-2"><Button type="button" variant="ghost" onClick={onClose}>Cancel</Button><Button type="submit" variant="primary" loading={save.isPending}>Save hours</Button></div>
      </form>
    </Modal>
  );
}

function BlockDialog({ open, doctors, onClose, onSaved }: { open: boolean; doctors: Doctor[]; onClose: () => void; onSaved: () => void }) {
  const { ws } = useWs(); const toast = useToast();
  const [f, setF] = useState({ kind: 'Doctor leave', doctor: '', shift: '', from: '', to: '', whole: true, start: '', end: '', reason: '' });
  const [err, setErr] = useState(''); const [affected, setAffected] = useState<Array<{ booking_reference: string; date: string; start_time: string; doctor_name: string | null; patient_name: string }> | null>(null); const [seen, setSeen] = useState(false);
  if (open !== seen) { setSeen(open); if (open) { setErr(''); setAffected(null); setF({ kind: 'Doctor leave', doctor: doctors[0]?.doctor_id || '', shift: '', from: '', to: '', whole: true, start: '', end: '', reason: '' }); } }
  const save = useMutation({
    mutationFn: () => api<{ block_id: string; affected: NonNullable<typeof affected> }>(wsPath(ws.id, '/schedule/blocks'), { method: 'POST', body: { kind: f.kind, doctor_id: f.kind === 'Clinic closure' ? null : f.doctor || null, shift: f.shift || null, date_from: f.from, date_to: f.to || f.from, start_time: f.whole ? null : f.start, end_time: f.whole ? null : f.end, reason: f.reason } }),
    onSuccess: (r) => { onSaved(); if (r.affected.length) setAffected(r.affected); else { toast('ok', 'Saved. Those times are no longer offered.'); onClose(); } }, onError: (e) => setErr(problem(e)),
  });
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));
  return (
    <Modal open={open} onClose={onClose} label="Leave or blocked time" className="max-w-xl">
      {affected ? (
        <div className="space-y-4 p-6">
          <h2 className="font-display text-lg font-semibold">Saved. {affected.length} appointment{affected.length === 1 ? ' is' : 's are'} inside this time</h2>
          <p className="text-[13px] text-fg-2">They have NOT been changed. Open each one on the Appointments tab to move or cancel it.</p>
          <ul className="max-h-60 divide-y divide-line overflow-y-auto rounded-xl border border-line">{affected.map((a) => <li key={a.booking_reference} className="flex flex-wrap items-center gap-x-3 px-3 py-2 text-[13px]"><span className="font-medium">{a.patient_name || 'Unnamed'}</span><span className="text-fg-2">{fdate(a.date)} {a.start_time}</span><span className="text-muted">{a.doctor_name}</span><span className="ml-auto font-mono text-[12px] text-muted">{a.booking_reference}</span></li>)}</ul>
          <div className="flex justify-end"><Button variant="primary" onClick={onClose}>Done</Button></div>
        </div>
      ) : (
        <form onSubmit={(e) => { e.preventDefault(); setErr(''); save.mutate(); }} className="max-h-[78vh] space-y-4 overflow-y-auto p-6">
          <div><h2 className="font-display text-lg font-semibold">Leave, closure or blocked time</h2><p className="mt-1 text-[13px] text-fg-2">These times stop being offered immediately. Existing appointments are not touched.</p></div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Type"><Select value={f.kind} onChange={(e) => set('kind', e.target.value)}>{BLOCK_KINDS.map((k) => <option key={k}>{k}</option>)}</Select></Field>
            {f.kind !== 'Clinic closure' && <Field label="Doctor"><Select value={f.doctor} onChange={(e) => set('doctor', e.target.value)}>{f.kind === 'Blocked time' && <option value="">Everyone</option>}{doctors.map((d) => <option key={d.doctor_id} value={d.doctor_id}>{d.name}</option>)}</Select></Field>}
            <Field label="First day" required><Input type="date" value={f.from} onChange={(e) => set('from', e.target.value)} /></Field>
            <Field label="Last day" hint="Leave empty for one day"><Input type="date" min={f.from} value={f.to} onChange={(e) => set('to', e.target.value)} /></Field>
            <Field label="Only this shift"><Select value={f.shift} onChange={(e) => set('shift', e.target.value)}><option value="">Both shifts</option><option value="morning">Morning</option><option value="evening">Evening</option></Select></Field>
          </div>
          <div className="rounded-xl border border-line bg-surface p-3">
            <label className="flex items-center gap-2 text-[13px] font-medium"><input type="checkbox" checked={f.whole} onChange={(e) => set('whole', e.target.checked)} className="h-4 w-4 accent-[rgb(var(--blue))]" />Whole day</label>
            {!f.whole && <div className="mt-3 grid grid-cols-2 gap-3"><Field label="From"><Input type="time" value={f.start} onChange={(e) => set('start', e.target.value)} /></Field><Field label="To"><Input type="time" value={f.end} onChange={(e) => set('end', e.target.value)} /></Field></div>}
          </div>
          <Field label="Reason (optional)"><Input value={f.reason} maxLength={200} onChange={(e) => set('reason', e.target.value)} /></Field>
          {err && <p className="rounded-lg border border-bad/30 bg-bad/10 px-3 py-2 text-[13px] text-bad" role="alert">{err}</p>}
          <div className="flex justify-end gap-2"><Button type="button" variant="ghost" onClick={onClose}>Cancel</Button><Button type="submit" variant="primary" loading={save.isPending} disabled={!f.from}>Save</Button></div>
        </form>
      )}
    </Modal>
  );
}
