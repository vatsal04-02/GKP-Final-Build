// The appointments table: filter by day, doctor, shift, status and who booked it; search by name, phone or reference.
import { useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { CalendarX, Search } from 'lucide-react';
import { api, ws as wsPath } from '../../lib/api';
import { useWs } from '../../lib/workspace';
import { Card, Input, Segmented, Select } from '../../components/ui/primitives';
import { EmptyState, ErrorState, SkeletonRows } from '../../components/ui/feedback';
import { useDebounced, useToday } from '../common';
import { SOURCES, SourceBadge, STATUSES, StatusBadge, addDays, fdateLong, sourceLabel, type Appt, type Doctor } from './shared';

type Range = 'today' | 'tomorrow' | 'week' | 'upcoming' | 'range' | 'all';
export function AppointmentsList({ doctors, onOpen }: { doctors: Doctor[]; onOpen: (ref: string) => void }) {
  const { ws } = useWs(); const today = useToday();
  const [range, setRange] = useState<Range>('upcoming'); const [from, setFrom] = useState(today); const [to, setTo] = useState(addDays(today, 7));
  const [doctor, setDoctor] = useState(''); const [shift, setShift] = useState(''); const [status, setStatus] = useState(''); const [source, setSource] = useState('');
  const [text, setText] = useState(''); const dq = useDebounced(text);
  const win = range === 'today' ? [today, today] : range === 'tomorrow' ? [addDays(today, 1), addDays(today, 1)] : range === 'week' ? [today, addDays(today, 6)] : range === 'upcoming' ? [today, ''] : range === 'range' ? [from, to] : ['', ''];
  const qs = new URLSearchParams(); if (win[0]) qs.set('from', win[0]); if (win[1]) qs.set('to', win[1]); if (doctor) qs.set('doctor_id', doctor); if (shift) qs.set('shift', shift); if (status) qs.set('status', status); if (source) qs.set('source', source); if (dq) qs.set('q', dq); qs.set('limit', '300'); if (range === 'all') qs.set('order', 'desc');
  const q = useQuery({ queryKey: ['sched', ws.id, 'list', qs.toString()], queryFn: () => api<{ rows: Appt[]; total: number }>(wsPath(ws.id, `/schedule/appointments?${qs}`)), placeholderData: keepPreviousData, refetchInterval: 60000 });
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2.5">
        <Segmented value={range} onChange={setRange} options={[{ value: 'today', label: 'Today' }, { value: 'tomorrow', label: 'Tomorrow' }, { value: 'week', label: '7 days' }, { value: 'upcoming', label: 'Upcoming' }, { value: 'range', label: 'Date range' }, { value: 'all', label: 'All' }]} />
        {range === 'range' && <><Input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} className="w-[10.5rem]" aria-label="From" /><span className="text-fg-2">to</span><Input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} className="w-[10.5rem]" aria-label="To" /></>}
      </div>
      <div className="flex flex-wrap items-center gap-2.5">
        <div className="w-full max-w-xs"><Input icon={<Search className="h-4 w-4" />} placeholder="Search name, phone or reference" value={text} onChange={(e) => setText(e.target.value)} aria-label="Search appointments" /></div>
        <div className="w-[11.5rem]"><Select value={doctor} onChange={(e) => setDoctor(e.target.value)} aria-label="Doctor"><option value="">All doctors</option>{doctors.map((x) => <option key={x.doctor_id} value={x.doctor_id}>{x.name}</option>)}</Select></div>
        <div className="w-[9.5rem]"><Select value={shift} onChange={(e) => setShift(e.target.value)} aria-label="Shift"><option value="">Both shifts</option><option value="morning">Morning</option><option value="evening">Evening</option></Select></div>
        <div className="w-[12.5rem]"><Select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status"><option value="">Any status</option>{STATUSES.map((s) => <option key={s}>{s}</option>)}</Select></div>
        <div className="w-[11.5rem]"><Select value={source} onChange={(e) => setSource(e.target.value)} aria-label="Booked by"><option value="">Any source</option>{SOURCES.map((s) => <option key={s} value={s}>{sourceLabel(s)}</option>)}</Select></div>
        {q.data && <span className="ml-auto text-[13px] text-fg-2">{q.data.total} appointment{q.data.total === 1 ? '' : 's'}</span>}
      </div>
      <Card className="overflow-hidden">
        {q.isLoading ? <SkeletonRows rows={7} /> : q.isError ? <ErrorState error={q.error} retry={() => q.refetch()} />
          : !q.data!.rows.length ? <EmptyState icon={<CalendarX className="h-5 w-5" />} title="No appointments match" body="Try another day or clear a filter." />
          : (
            <div className="max-h-[calc(100vh-24rem)] min-h-[260px] overflow-auto">
              <table className="w-full min-w-[860px] border-separate border-spacing-0 text-[13px]">
                <thead><tr>{['When', 'Patient', 'Doctor', 'Status', 'Booked by', 'Reference'].map((h) => <th key={h} className="sticky top-0 z-[2] whitespace-nowrap border-b border-line-2 bg-[rgb(235_242_238)] px-3 py-2.5 text-left text-[12.5px] font-semibold text-fg-2">{h}</th>)}</tr></thead>
                <tbody>{q.data!.rows.map((a) => (
                  <tr key={a.id} onClick={() => onOpen(a.booking_reference)} className="cursor-pointer transition-colors even:bg-surface-2/60 hover:bg-sage/40">
                    <td className="whitespace-nowrap border-b border-line/60 px-3 py-2.5"><div className="font-medium">{a.start_time}–{a.end_time}</div><div className="text-[12px] text-muted">{fdateLong(a.date)}</div></td>
                    <td className="border-b border-line/60 px-3 py-2.5"><div className="font-medium">{a.patient.name || 'Unnamed'}</div><div className="num text-[12px] text-muted">{a.patient.phone || '—'}</div></td>
                    <td className="border-b border-line/60 px-3 py-2.5">{a.doctor_name || '—'}<div className="text-[12px] capitalize text-muted">{a.shift || ''}</div></td>
                    <td className="border-b border-line/60 px-3 py-2.5"><StatusBadge status={a.status} /></td>
                    <td className="border-b border-line/60 px-3 py-2.5"><SourceBadge source={a.source} /></td>
                    <td className="whitespace-nowrap border-b border-line/60 px-3 py-2.5 font-mono text-[12px] text-fg-2">{a.booking_reference}</td>
                  </tr>))}</tbody>
              </table>
            </div>)}
      </Card>
    </div>
  );
}
