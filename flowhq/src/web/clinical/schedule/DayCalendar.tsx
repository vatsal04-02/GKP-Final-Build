// The day calendar: every slot of the day by doctor, who is in it, and a click to book a free one or open a booked one.
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Plus } from 'lucide-react';
import { api, ws as wsPath } from '../../lib/api';
import { useWs } from '../../lib/workspace';
import { cn } from '../../lib/cn';
import { Button, Card, Input, Segmented, Select } from '../../components/ui/primitives';
import { EmptyState, ErrorState, Skeleton } from '../../components/ui/feedback';
import { useToday } from '../common';
import { SourceBadge, StatusBadge, addDays, fdateLong, type DayView, type Doctor } from './shared';

export function DayCalendar({ doctors, onOpen, onBook }: { doctors: Doctor[]; onOpen: (ref: string) => void; onBook: (date: string, slotId: string) => void }) {
  const { ws } = useWs(); const today = useToday();
  const [date, setDate] = useState(today); const [doctor, setDoctor] = useState(''); const [shift, setShift] = useState<'all' | 'morning' | 'evening'>('all');
  const q = useQuery({ queryKey: ['sched', ws.id, 'day', date, doctor, shift], queryFn: () => api<DayView>(wsPath(ws.id, `/schedule/day?date=${date}${doctor ? `&doctor_id=${encodeURIComponent(doctor)}` : ''}${shift !== 'all' ? `&shift=${shift}` : ''}`)), refetchInterval: 60000 });
  const d = q.data;
  const groups = (() => { const m = new Map<string, NonNullable<typeof d>['slots']>(); for (const s of d?.slots || []) m.set(`${s.doctor_name}|${s.shift}`, [...(m.get(`${s.doctor_name}|${s.shift}`) || []), s]); return [...m]; })();
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2.5">
        <div className="flex items-center gap-1"><Button size="sm" variant="ghost" aria-label="Previous day" onClick={() => setDate(addDays(date, -1))}><ChevronLeft className="h-4 w-4" /></Button>
          <Input type="date" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} className="w-[10.5rem]" aria-label="Day" />
          <Button size="sm" variant="ghost" aria-label="Next day" onClick={() => setDate(addDays(date, 1))}><ChevronRight className="h-4 w-4" /></Button></div>
        <Button size="sm" variant={date === today ? 'subtle' : 'secondary'} onClick={() => setDate(today)}>Today</Button>
        <div className="w-[12rem]"><Select value={doctor} onChange={(e) => setDoctor(e.target.value)} aria-label="Doctor"><option value="">All doctors</option>{doctors.map((x) => <option key={x.doctor_id} value={x.doctor_id}>{x.name}</option>)}</Select></div>
        <Segmented value={shift} onChange={setShift} options={[{ value: 'all', label: 'Both shifts' }, { value: 'morning', label: 'Morning' }, { value: 'evening', label: 'Evening' }]} />
        <h3 className="ml-auto font-display text-xl font-semibold">{fdateLong(date)}</h3>
      </div>

      {q.isLoading ? <Card className="p-5"><Skeleton className="h-6 w-1/3" /><Skeleton className="mt-4 h-40 w-full" /></Card>
        : q.isError ? <Card><ErrorState error={q.error} retry={() => q.refetch()} /></Card>
        : d!.closed ? <Card><EmptyState icon={<Plus className="h-5 w-5 rotate-45" />} title={d!.closed === 'not_operating_day' ? 'The clinic is closed on this day' : d!.closed === 'clinic_closure' ? 'The clinic is closed on this date' : 'Outside the booking window'} body="No times are offered. Existing appointments, if any, are listed below." /></Card>
        : !groups.length ? <Card><EmptyState icon={<Plus className="h-5 w-5 rotate-45" />} title="No bookable times" body={d!.skips.length ? 'Every shift is switched off, on leave or blocked for this day. See Doctors & hours.' : 'No doctor has hours on this day.'} /></Card>
        : <div className="grid gap-4 lg:grid-cols-2">{groups.map(([key, slots]) => {
          const [name, sh] = key.split('|');
          return (
            <Card key={key} className="overflow-hidden">
              <header className="flex items-baseline justify-between gap-3 border-b border-line bg-surface-2 px-4 py-3"><div><h4 className="font-display text-[15px] font-semibold">{name}</h4><div className="mt-0.5 text-[12.5px] capitalize text-fg-2">{sh} shift · <span className="num">{slots[0]!.start_time}–{slots[slots.length - 1]!.end_time}</span></div></div>
                <span className="num text-[13px] text-fg-2"><span className="font-semibold text-ok">{slots.filter((s) => s.state === 'open').length}</span> free</span></header>
              <ul className="divide-y divide-line">{slots.map((s) => (
                <li key={s.slot_id} className="flex items-center gap-3 px-4 py-2.5">
                  <span className="num w-12 shrink-0 text-[13px] font-semibold text-fg-2">{s.start_time}</span>
                  <div className="min-w-0 flex-1">
                    {s.appointments.length ? s.appointments.map((a) => (
                      <button key={a.id} type="button" onClick={() => onOpen(a.booking_reference)} className="group flex w-full flex-wrap items-center gap-x-3 gap-y-1 rounded-lg px-2 py-1 text-left transition-colors hover:bg-bg-2/60">
                        <span className="truncate text-[13.5px] font-medium group-hover:text-blue-bright">{a.patient.name || 'Unnamed'}</span><StatusBadge status={a.status} /><SourceBadge source={a.source} /></button>))
                      : s.state === 'blocked' ? <span className="text-[13px] text-muted">Blocked{s.blocked_by === 'leave' ? ' (leave)' : s.blocked_by === 'closure' ? ' (closed)' : ''}</span>
                      : s.state === 'past' ? <span className="text-[13px] text-muted">Passed</span>
                      : <span className="text-[13px] text-ok">Free</span>}
                  </div>
                  {s.state === 'open' && <Button size="sm" variant="secondary" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => onBook(date, s.slot_id)} aria-label={`Book ${s.start_time} with ${s.doctor_name}`}>Book</Button>}
                  <span className={cn('h-2 w-2 shrink-0 rounded-full', s.state === 'open' ? 'bg-ok' : s.state === 'full' ? 'bg-blue-bright' : s.state === 'blocked' ? 'bg-warn' : 'bg-muted')} aria-hidden="true" />
                </li>))}</ul>
            </Card>);
        })}</div>}

      {d && d.outside_slots.length > 0 && (
        <Card className="p-4"><div className="label mb-2">Other appointments this day (not inside a bookable time)</div>
          <ul className="divide-y divide-line">{d.outside_slots.map((a) => (<li key={a.id}><button type="button" onClick={() => onOpen(a.booking_reference)} className="flex w-full flex-wrap items-center gap-2 py-2 text-left"><span className="num w-12 text-[13px] font-medium">{a.start_time}</span><span className="text-[13.5px]">{a.patient.name || 'Unnamed'}</span><span className="text-[12px] text-fg-2">{a.doctor_name || 'No doctor'}</span><StatusBadge status={a.status} /><SourceBadge source={a.source} /></button></li>))}</ul></Card>)}
      <div className="flex flex-wrap items-center gap-4 text-[12px] text-fg-2" aria-label="Legend"><span className="inline-flex items-center gap-1.5"><i className="h-2 w-2 rounded-full bg-ok" />Free</span><span className="inline-flex items-center gap-1.5"><i className="h-2 w-2 rounded-full bg-blue-bright" />Booked</span><span className="inline-flex items-center gap-1.5"><i className="h-2 w-2 rounded-full bg-warn" />Blocked</span><span className="inline-flex items-center gap-1.5"><i className="h-2 w-2 rounded-full bg-muted" />Passed</span></div>
    </div>
  );
}
