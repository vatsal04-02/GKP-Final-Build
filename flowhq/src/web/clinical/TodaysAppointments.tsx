// Today's appointments, from the existing bookings (the booking system is the source of truth; nothing is invented here).
// Each row: time, patient, the doctor it is with, status, and the actions this user may use (open the patient, mark completed / no-show).
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, CalendarCheck2, CalendarClock, CalendarX2 } from 'lucide-react';
import type { Booking, BookingStatus } from '@core/domain';
import { api, ApiError, ws as wsPath } from '../lib/api';
import { useWs } from '../lib/workspace';
import { time } from '../lib/format';
import { cn } from '../lib/cn';
import { Badge, Button, Card, CardHeader, type Tone } from '../components/ui/primitives';
import { ErrorState, SkeletonRows, useToast } from '../components/ui/feedback';
import { useToday } from './common';
import { dayOf } from './dashboardLogic';

const TONE: Record<BookingStatus, Tone> = { scheduled: 'blue', rescheduled: 'blue', completed: 'green', no_show: 'amber', cancelled: 'neutral' };

function Row({ b, base, next }: { b: Booking; base: string; next: boolean }) {
  const { ws, f, t } = useWs();
  const qc = useQueryClient();
  const toast = useToast();
  const caps = ws.backend.capabilities;
  const mark = useMutation({
    mutationFn: (status: BookingStatus) => api<Booking>(wsPath(ws.id, `/bookings/${b.id}`), { method: 'PATCH', body: { status } }),
    onSuccess: () => { toast('ok', 'Saved'); qc.invalidateQueries({ queryKey: ['bookings-today', ws.id] }); qc.invalidateQueries({ queryKey: ['dashboard', ws.id] }); qc.invalidateQueries({ queryKey: ['bookings', ws.id] }); },
    onError: (e) => toast('bad', `Not saved: ${e instanceof ApiError ? e.message : (e as Error).message}`),
  });
  const canMark = b.needsOutcome && caps.bookingStatusUpdate.length > 0;
  return (
    <li className="relative py-3 pl-5">
      <span aria-hidden="true" className={cn("absolute left-0 top-[18px] h-2.5 w-2.5 rounded-full border-2 bg-surface", next ? "border-accent bg-accent" : b.needsOutcome ? "border-warn" : "border-blue/50")} />
      <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
        <div className="num w-16 shrink-0 pt-px text-[14px] font-semibold">{time(f, b.start)}{next && <span className="mt-0.5 block text-[10.5px] font-semibold uppercase tracking-wide text-accent-strong">Next</span>}</div>
        <div className="min-w-[9rem] flex-1">
          {b.contactId ? <Link to={`${base}/contacts/${b.contactId}`} className="block break-words text-[13.5px] font-medium leading-snug hover:text-blue-bright">{b.contactName || t('contact.singular')}</Link>
            : <span className="block break-words text-[13.5px] font-medium leading-snug">{b.contactName || t('contact.singular')}</span>}
          <p className="mt-0.5 break-words text-[12px] text-fg-2">{b.title || t('booking.singular')}{b.owner ? <> · <span className="font-medium text-fg">{b.owner}</span></> : <span className="text-muted"> · no doctor assigned</span>}</p>
        </div>
        <Badge tone={b.needsOutcome ? 'amber' : TONE[b.status]}>{b.needsOutcome ? 'Needs outcome' : t(`bookingStatus.${b.status}`)}</Badge>
      </div>
      {canMark && (
        <div className="mt-2 flex flex-wrap gap-1.5 pl-[4.75rem]">
          {caps.bookingStatusUpdate.includes('completed') && <Button size="sm" variant="subtle" icon={<CalendarCheck2 className="h-3.5 w-3.5" />} loading={mark.isPending && mark.variables === 'completed'} disabled={mark.isPending} onClick={() => mark.mutate('completed')}>Completed</Button>}
          {caps.bookingStatusUpdate.includes('no_show') && <Button size="sm" variant="ghost" icon={<CalendarX2 className="h-3.5 w-3.5" />} loading={mark.isPending && mark.variables === 'no_show'} disabled={mark.isPending} onClick={() => mark.mutate('no_show')}>No-show</Button>}
        </div>
      )}
    </li>
  );
}

export function TodaysAppointments({ base, className }: { base: string; className?: string }) {
  const { ws } = useWs();
  const today = useToday();
  const q = useQuery({ queryKey: ['bookings-today', ws.id], queryFn: () => api<Booking[]>(wsPath(ws.id, '/bookings?view=upcoming')), refetchInterval: 60000 });
  const list = (q.data || []).filter((b) => dayOf(b.start, ws.timezone) === today).sort((a, b) => (a.start || '') < (b.start || '') ? -1 : 1);
  const nextId = list.find((b) => !b.needsOutcome && (b.start || '') >= new Date().toISOString())?.id;
  return (
    <Card className={cn('fhq-rise', className)}>
      <CardHeader title="Today's appointments" subtitle={q.data ? (list.length ? `${list.length} booked today` : 'Nothing booked today') : ' '} icon={<CalendarClock className="h-4 w-4" />}
        action={<Link to={`${base}/bookings`} className="inline-flex shrink-0 items-center gap-1 text-xs text-blue-soft hover:text-blue-bright">All <ArrowRight className="h-3 w-3" /></Link>} />
      <div className="px-4 pb-3 pt-1 sm:px-5">
        {q.isLoading ? <SkeletonRows rows={3} className="p-0" /> : q.error ? <ErrorState error={q.error} retry={() => q.refetch()} />
          : list.length ? <ul className="relative divide-y divide-line before:absolute before:bottom-4 before:left-[4px] before:top-4 before:w-px before:bg-line">{list.map((b) => <Row key={b.id} b={b} base={base} next={b.id === nextId} />)}</ul>
          : <p className="flex items-center gap-2.5 py-3 text-[13px] text-fg-2"><CalendarClock className="h-4 w-4 shrink-0 text-muted" /><span><span className="font-medium text-fg">No appointments today</span> · bookings appear here as they are made</span></p>}
      </div>
    </Card>
  );
}
