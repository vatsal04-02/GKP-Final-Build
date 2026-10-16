// Bookings for every industry. The booking system stays the source of truth: this page shows what it says and lets the team
// mark what only the team knows (completed / no-show). It never creates, moves or offers times.
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarCheck2, CalendarDays, CalendarX2, Check, Info, Search, Sparkles } from 'lucide-react';
import type { Booking, BookingStatus } from '@core/domain';
import { api, ws as wsPath } from '../lib/api';
import { useWs } from '../lib/workspace';
import { dateTime, dayKey, money, time, weekday } from '../lib/format';
import { cn } from '../lib/cn';
import { Page } from '../components/layout/Shell';
import { Badge, Button, Card, Input, Segmented, type Tone } from '../components/ui/primitives';
import { EmptyState, ErrorState, SkeletonRows, useToast } from '../components/ui/feedback';

type View = 'upcoming' | 'needs_outcome' | 'past' | 'all';
const STATUS_TONE: Record<BookingStatus, Tone> = { scheduled: 'blue', rescheduled: 'blue', cancelled: 'neutral', completed: 'green', no_show: 'amber' };

export default function Bookings() {
  const { ws, t, tt } = useWs();
  const caps = ws.backend.capabilities;
  const [view, setView] = useState<View>('upcoming');
  const [q, setQ] = useState('');
  const list = useQuery({ queryKey: ['bookings', ws.id, view, q], queryFn: () => api<Booking[]>(wsPath(ws.id, `/bookings?view=${view}&q=${encodeURIComponent(q)}`)), refetchInterval: 30000 });
  const pending = useQuery({ queryKey: ['bookings', ws.id, 'needs_outcome', ''], queryFn: () => api<Booking[]>(wsPath(ws.id, '/bookings?view=needs_outcome')), refetchInterval: 60000 });
  const days = useMemo(() => {
    const out: Array<{ key: string; label: string; items: Booking[] }> = [];
    for (const b of list.data || []) {
      const k = b.start ? dayKey({ locale: ws.locale, timezone: ws.timezone, currency: ws.currency }, b.start) : 'none';
      let d = out.find((x) => x.key === k);
      if (!d) { d = { key: k, label: b.start ? weekday({ locale: ws.locale, timezone: ws.timezone, currency: ws.currency }, b.start) : 'No time', items: [] }; out.push(d); }
      d.items.push(b);
    }
    return out;
  }, [list.data, ws]);
  const views: Array<{ value: View; label: string; count?: number }> = [
    { value: 'upcoming', label: 'Upcoming' },
    ...(caps.bookingStatusUpdate.length ? [{ value: 'needs_outcome' as View, label: 'Needs outcome', count: pending.data?.length }] : []),
    { value: 'past', label: 'Past' },
    { value: 'all', label: 'All' },
  ];
  return (
    <Page title={t('booking.plural')} subtitle={list.data ? tt(`${list.data.length} ${list.data.length === 1 ? '{booking.singular|lower}' : '{booking.plural|lower}'}`) : ' '}>
      {caps.bookingSourceOfTruth && (
        <div className="mb-4 flex items-start gap-2.5 rounded-xl border border-blue/20 bg-blue/[0.06] px-4 py-3 text-[13px] text-fg-2">
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-blue-bright" />
          <p>{tt(`${caps.bookingSourceOfTruth} is the source of truth for {booking.plural|lower}. Create, move or cancel them there; they appear here automatically. Free times are never offered from this screen.`)}</p>
        </div>
      )}
      <div className="mb-4 flex flex-wrap items-center gap-2.5">
        <Segmented value={view} onChange={setView} options={views} />
        <div className="w-full max-w-xs"><Input icon={<Search className="h-4 w-4" />} placeholder={tt('Search {contact.singular|lower}, {service.singular|lower}, {staff.singular|lower}')} value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search" /></div>
      </div>
      <Card className="overflow-hidden">
        {list.isLoading ? <SkeletonRows rows={8} /> : list.error ? <ErrorState error={list.error} retry={() => list.refetch()} /> : !days.length ? (
          <EmptyState icon={view === 'needs_outcome' ? <CalendarCheck2 className="h-5 w-5" /> : <CalendarDays className="h-5 w-5" />}
            title={view === 'needs_outcome' ? 'Every outcome is marked' : tt('No {booking.plural|lower} here')}
            body={view === 'needs_outcome' ? tt('Past {booking.plural|lower} still waiting for completed or no-show appear here.') : q ? 'Try a different search.' : tt('New {booking.plural|lower} appear as soon as they are made.')} />
        ) : (
          <div className="divide-y divide-line">
            {days.map((d) => (
              <section key={d.key} aria-label={d.label}>
                <h2 className="sticky top-0 z-[1] flex items-center justify-between border-b border-line bg-surface/95 px-5 py-2 text-[12px] font-semibold uppercase tracking-wide text-muted backdrop-blur">
                  <span>{d.label}</span><span className="num normal-case">{tt(`${d.items.length} ${d.items.length === 1 ? '{booking.singular|lower}' : '{booking.plural|lower}'}`)}</span>
                </h2>
                <ul className="divide-y divide-line/60">{d.items.map((b) => <BookingRow key={b.id} b={b} />)}</ul>
              </section>
            ))}
          </div>
        )}
      </Card>
    </Page>
  );
}

function BookingRow({ b }: { b: Booking }) {
  const { ws, t, f, automation } = useWs();
  const caps = ws.backend.capabilities;
  const qc = useQueryClient();
  const toast = useToast();
  const mark = useMutation({
    mutationFn: (status: BookingStatus) => api<Booking>(wsPath(ws.id, `/bookings/${b.id}`), { method: 'PATCH', body: { status } }),
    onSuccess: (r) => { toast('ok', `Marked ${t(`bookingStatus.${r.status}`).toLowerCase()}`); qc.invalidateQueries({ queryKey: ['bookings', ws.id] }); qc.invalidateQueries({ queryKey: ['tasks', ws.id] }); qc.invalidateQueries({ queryKey: ['dashboard', ws.id] }); },
    onError: (e: Error) => toast('bad', e.message),
  });
  const canMark = b.needsOutcome && caps.bookingStatusUpdate.length > 0;
  return (
    <li className={cn('flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3 transition-colors hover:bg-surface-2/60', b.status === 'cancelled' && 'opacity-60')}>
      <div className="w-[92px] shrink-0">
        <div className="num text-[14px] font-semibold text-fg">{time(f, b.start)}</div>
        <div className="num text-[11.5px] text-muted">{b.end ? `until ${time(f, b.end)}` : ''}</div>
      </div>
      <div className="min-w-[200px] flex-1">
        <div className="flex flex-wrap items-center gap-2">
          {b.contactId ? <Link to={`/w/${ws.id}/contacts/${b.contactId}`} className="truncate text-[13.5px] font-medium text-fg hover:text-blue-soft">{b.contactName || t('contact.singular')}</Link> : <span className="truncate text-[13.5px] font-medium">{b.contactName || t('contact.singular')}</span>}
          <Badge tone={STATUS_TONE[b.status]}>{t(`bookingStatus.${b.status}`)}</Badge>
          {b.needsOutcome && <Badge tone="amber">Outcome not marked</Badge>}
        </div>
        <p className="mt-0.5 truncate text-[12.5px] text-fg-2">{[b.title || b.service || t('booking.singular'), b.owner].filter(Boolean).join(' · ')}</p>
        {b.automationsDone.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {b.automationsDone.map((a, i) => (
              <span key={i} title={`${automation(a.key).name}${a.at ? ` · ${dateTime(f, a.at)}` : ''}`} className="inline-flex items-center gap-1 rounded-md border border-line bg-bg-2 px-1.5 py-0.5 text-[11px] text-fg-2"><Check className="h-3 w-3 text-blue-bright" />{a.label}</span>
            ))}
          </div>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-3">
        <span className={cn('inline-flex items-center gap-1 text-[11.5px]', b.source.kind === 'assistant' ? 'text-blue-soft' : 'text-muted')}>{b.source.kind === 'assistant' && <Sparkles className="h-3 w-3" />}{b.source.label}</span>
        {b.value !== null && <span className="num text-[13px] font-medium text-fg">{money(f, b.value)}</span>}
        {canMark && (
          <div className="flex gap-1.5">
            {caps.bookingStatusUpdate.includes('completed') && <Button size="sm" variant="subtle" icon={<CalendarCheck2 className="h-3.5 w-3.5" />} loading={mark.isPending && mark.variables === 'completed'} disabled={mark.isPending} onClick={() => mark.mutate('completed')}>{t('bookingStatus.completed')}</Button>}
            {caps.bookingStatusUpdate.includes('no_show') && <Button size="sm" variant="ghost" icon={<CalendarX2 className="h-3.5 w-3.5" />} loading={mark.isPending && mark.variables === 'no_show'} disabled={mark.isPending} onClick={() => mark.mutate('no_show')}>{t('bookingStatus.no_show')}</Button>}
          </div>
        )}
      </div>
    </li>
  );
}
