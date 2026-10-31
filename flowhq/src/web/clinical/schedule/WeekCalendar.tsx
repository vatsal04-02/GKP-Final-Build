// The week: seven days side by side, for the whole clinic or for ONE doctor (their hours, leave and appointments). Read-only: click an appointment to open it
// (moving, cancelling and status changes happen in the drawer, through the same booking service as everything else).
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Printer } from 'lucide-react';
import { api, ws as wsPath } from '../../lib/api';
import { useWs } from '../../lib/workspace';
import { cn } from '../../lib/cn';
import { Button, Card, Input, Select } from '../../components/ui/primitives';
import { ErrorState, Skeleton } from '../../components/ui/feedback';
import { useToday } from '../common';
import { StatusBadge, addDays, type Appt, type Doctor, type Shift } from './shared';

interface WeekDay { date: string; closed: string | null; skips: Array<{ shift: Shift; doctorId: string | null; reason: string }>; windows: Array<{ doctor_id: string; doctor_name: string; shift: Shift; start_time: string; end_time: string; free: number; booked: number }>; appointments: Appt[]; summary: { available: number } }
interface Week { from: string; to: string; doctor_id: string | null; days: WeekDay[]; totals: { appointments: number; free_slots: number } }
const SKIP_TEXT: Record<string, string> = { doctor_on_leave: 'On leave', blocked_all_day: 'Blocked', shift_disabled: 'Shift off', doctor_inactive: 'Not taking bookings' };
const CLOSED_TEXT: Record<string, string> = { not_operating_day: 'Closed', clinic_closure: 'Clinic closed', beyond_booking_window: 'Beyond booking window' };
const dayName = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });

export function WeekCalendar({ doctors, onOpen }: { doctors: Doctor[]; onOpen: (ref: string) => void }) {
  const { ws } = useWs(); const today = useToday();
  const [date, setDate] = useState(today); const [doctor, setDoctor] = useState('');
  const q = useQuery({ queryKey: ['sched', ws.id, 'week', date, doctor], queryFn: () => api<Week>(wsPath(ws.id, `/schedule/week?date=${date}${doctor ? `&doctor_id=${encodeURIComponent(doctor)}` : ''}`)) });
  const w = q.data; const who = doctors.find((d) => d.doctor_id === doctor);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2.5 print:hidden">
        <div className="flex items-center gap-1"><Button size="sm" variant="ghost" aria-label="Previous week" onClick={() => setDate(addDays(date, -7))}><ChevronLeft className="h-4 w-4" /></Button>
          <Input type="date" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} className="w-[10.5rem]" aria-label="Any day in the week" />
          <Button size="sm" variant="ghost" aria-label="Next week" onClick={() => setDate(addDays(date, 7))}><ChevronRight className="h-4 w-4" /></Button></div>
        <Button size="sm" variant="secondary" onClick={() => setDate(today)}>This week</Button>
        <div className="w-[12rem]"><Select value={doctor} onChange={(e) => setDoctor(e.target.value)} aria-label="Doctor"><option value="">All doctors</option>{doctors.map((x) => <option key={x.doctor_id} value={x.doctor_id}>{x.name}</option>)}</Select></div>
        <Button size="sm" variant="ghost" icon={<Printer className="h-4 w-4" />} onClick={() => window.print()}>Print</Button>
        {w && <span className="ml-auto text-[13px] text-fg-2">{w.totals.appointments} appointment{w.totals.appointments === 1 ? '' : 's'} · {w.totals.free_slots} free slot{w.totals.free_slots === 1 ? '' : 's'}</span>}
      </div>
      <h3 className="font-display text-xl font-semibold">{who ? `${who.name}: ` : 'Clinic: '}{w ? `${dayName(w.from)} to ${dayName(w.to)}` : '…'}</h3>
      {q.isLoading ? <Card className="p-5"><Skeleton className="h-6 w-1/3" /><Skeleton className="mt-4 h-40 w-full" /></Card>
        : q.isError || !w ? <Card><ErrorState error={q.error} retry={() => q.refetch()} /></Card>
        : <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-7" aria-label="Week">{w.days.map((d) => (
          <Card key={d.date} className={cn('flex min-h-[9rem] flex-col overflow-hidden', d.date === today && 'border-blue ring-1 ring-blue')}>
            <header className={cn('border-b border-line px-3 py-2', d.date === today ? 'bg-blue text-white' : 'bg-surface-2')}><div className="whitespace-nowrap font-display text-[13px] font-semibold">{dayName(d.date)}</div>{!d.closed && <div className={cn('num text-[12px]', d.date === today ? 'text-white/85' : 'text-fg-2')}>{d.summary.available} free</div>}</header>
            <div className="flex-1 space-y-2 p-2.5 text-[12.5px]">
              {d.closed ? <p className="text-muted">{CLOSED_TEXT[d.closed] || d.closed}</p> : (<>
                {d.windows.map((x) => <p key={`${x.doctor_id}${x.shift}`} className="text-fg-2"><span className="font-medium text-fg">{doctor ? '' : `${x.doctor_name.replace(/^Dr\.?\s*/, 'Dr ')} `}</span>{x.start_time}–{x.end_time}</p>)}
                {d.skips.filter((s) => !doctor || s.doctorId === doctor || s.doctorId === null).map((s, i) => <p key={`${s.reason}${i}`} className="text-warn">{SKIP_TEXT[s.reason] || s.reason}{s.doctorId ? ` (${doctors.find((x) => x.doctor_id === s.doctorId)?.name || s.doctorId})` : ''}</p>)}
                {!d.windows.length && !d.skips.length && <p className="text-muted">No hours set</p>}
                <ul className="space-y-1">{d.appointments.map((a) => (
                  <li key={a.id}><button type="button" onClick={() => onOpen(a.booking_reference)} className="w-full rounded-lg border border-line bg-surface px-2 py-1.5 text-left transition-colors hover:border-line-2 hover:bg-surface-2">
                    <span className="num font-medium">{a.start_time}</span> <span className="truncate">{a.patient.name || 'Unnamed'}</span>
                    <div className="mt-0.5 flex flex-wrap items-center gap-1 text-[11.5px] text-muted">{!doctor && a.doctor_name ? <span>{a.doctor_name}</span> : null}<StatusBadge status={a.status} /></div></button></li>))}</ul>
              </>)}
            </div>
          </Card>))}</div>}
    </div>
  );
}
