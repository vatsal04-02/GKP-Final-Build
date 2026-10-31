// The universal dashboard: the workspace decides which metrics show; every label comes from its terminology.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, CalendarDays, CheckCircle2, Sparkles } from 'lucide-react';
import type { Dashboard as DashboardData } from '@core/domain';
import { api, ws as wsPath } from '../lib/api';
import { useWs } from '../lib/workspace';
import { date, number, time, weekday } from '../lib/format';
import { Page } from '../components/layout/Shell';
import { Badge, Card, CardHeader, Segmented } from '../components/ui/primitives';
import { EmptyState, ErrorState, Skeleton, SkeletonRows } from '../components/ui/feedback';
import { AreaChart } from '../components/data/charts';
import { ActivityRow, MetricCard, TaskRow } from '../components/data/widgets';
import { DoctorOverview, useHasDoctorOverview } from '../clinical/DoctorOverview';
import { useDoctorFilter } from '../clinical/DoctorFilter';
import { EnquiryOverview } from '../components/data/EnquiryOverview';

const RANGES = [{ value: '1', label: 'Today' }, { value: '7', label: '7 days' }, { value: '30', label: '30 days' }] as const;

// "Dr. Sandeep Tiwari" -> "Dr. Sandeep"; a plain name -> its first word; no name -> the role.
function firstName(name: string, role: string) {
  const w = name.trim().split(/\s+/).filter(Boolean);
  if (!w.length) return role === 'admin' ? 'Admin' : 'Team';
  return /^(dr|mr|mrs|ms|prof)\.?$/i.test(w[0]!) && w[1] ? `${w[0]} ${w[1]}` : w[0]!;
}

export default function Dashboard() {
  const { ws, me, tt, t, f, has } = useWs();
  const [days, setDays] = useState<'1' | '7' | '30'>('7');
  const doc = useDoctorFilter();   // lives here so the greeting follows the doctor picked in the filter
  const q = useQuery({ queryKey: ['dashboard', ws.id, days], queryFn: () => api<DashboardData>(wsPath(ws.id, `/dashboard?days=${days}`)), refetchInterval: 30000 });
  const hour = Number(new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hour12: false, timeZone: ws.timezone }).format(new Date()));
  const greet = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  const d = q.data;
  const series = (key: string) => d?.series.find((s) => s.key === key)?.points.map((p) => p.value);
  // A clinic workspace leads with the doctor's own numbers; enquiries and AI collapse into one slim row.
  const clinical = useHasDoctorOverview();
  const SLIM = ['new_contacts', 'pending_actions', 'ai_handled'];
  // the enquiry card already carries New and Conversion, so the metric grid does not repeat them
  const enquiryCard = has('contacts');
  const metrics = d ? (clinical ? ws.dashboardMetrics.filter((k) => SLIM.includes(k)) : ws.dashboardMetrics).filter((k) => !(enquiryCard && (k === 'new_contacts' || k === 'conversion'))).map((k) => d.metrics.find((m) => m.key === k)).filter((m): m is NonNullable<typeof m> => !!m) : [];
  const labels = d?.series[0]?.points.map((p) => date(f, `${p.date}T12:00:00Z`)) || [];
  const aiMetric = d && clinical ? (() => { const m = d.metrics.find((x) => x.key === 'ai_handled'); return m ? <MetricCard m={m} spark={days !== '1' ? series(m.key) : undefined} emphasis /> : null; })() : null;
  const attentionCard = (
    <Card className="flex flex-col">
      <CardHeader title="Needs attention" subtitle={d ? `${d.attention.length ? d.metrics.find((m) => m.key === 'pending_actions')?.value : 0} open` : ' '} action={has('tasks') ? <Link to={`/w/${ws.id}/tasks`} className="inline-flex items-center gap-1 text-xs text-blue-soft hover:text-blue-bright">All tasks <ArrowRight className="h-3 w-3" /></Link> : undefined} />
      <div className="flex-1 px-3 pb-3 pt-2">
        {!d ? <SkeletonRows rows={4} className="p-2" /> : d.attention.length ? d.attention.map((tk) => <TaskRow key={tk.id} task={tk} />) : <EmptyState className="py-8" icon={<CheckCircle2 className="h-5 w-5" />} title="All clear" body="Nothing is waiting for a person right now." />}
      </div>
    </Card>
  );
  return (
    <Page
      title={`${greet}, ${firstName(doc.key || me.user.name, me.user.role)}`}
      subtitle={<span>Here is what is happening at <span className="text-fg">{ws.name}</span>.</span>}
      actions={<Segmented value={days} onChange={setDays} options={RANGES.map((r) => ({ value: r.value, label: r.label }))} />}
    >
      {q.error ? <Card><ErrorState error={q.error} retry={() => q.refetch()} /></Card> : (
        <div className="space-y-6">
          {clinical && <DoctorOverview days={days} doc={doc} />}
          {clinical && <h2 className="border-t border-line pt-6 text-[12.5px] font-semibold text-muted">Enquiries &amp; messages</h2>}
          {clinical ? (
            <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_24rem] [&>*]:min-w-0">
              {enquiryCard ? <EnquiryOverview d={d} days={days} /> : <div />}
              <div className="space-y-6">{aiMetric}{attentionCard}</div>
            </div>
          ) : enquiryCard && <EnquiryOverview d={d} days={days} />}
          {!clinical && <section aria-label="Key metrics" className={clinical ? 'grid grid-cols-2 gap-3 md:grid-cols-3' : 'grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-6'}>
            {!d ? Array.from({ length: 8 }, (_, i) => <Card key={i} className="p-4"><Skeleton className="h-3 w-24" /><Skeleton className="mt-4 h-7 w-16" /><Skeleton className="mt-3 h-3 w-28" /></Card>)
              : metrics.map((m) => <MetricCard key={m.key} m={m} spark={days !== '1' ? series(m.key) : undefined} emphasis={m.key === 'new_contacts' || m.key === 'ai_handled'} />)}
          </section>}

          <div className={clinical ? 'hidden' : 'grid gap-4 xl:grid-cols-3 [&>*]:min-w-0'}>
            {!clinical && <Card className="xl:col-span-2">
              <CardHeader title="Conversations" subtitle={has('ai') ? tt('Incoming messages and what the {ai.name} did with them') : 'Incoming messages'} icon={<Sparkles className="h-4 w-4" />} />
              <div className="px-3 pb-3 pt-2">
                {!d ? <Skeleton className="mx-2 h-[220px]" /> : (
                  <AreaChart labels={labels} format={(n) => number(f, n)} series={[
                    { key: 'in', label: 'Messages in', tone: 'soft', values: series('messages_in') || [] },
                    ...(has('ai') ? [{ key: 'ai', label: tt('{ai.short} handled'), tone: 'blue' as const, values: series('ai_handled') || [], area: true }, { key: 'h', label: 'Handed to a person', tone: 'amber' as const, values: series('human_handoffs') || [] }] : []),
                  ]} />
                )}
              </div>
            </Card>}
            {!clinical && attentionCard}
          </div>

          <div className={clinical ? 'hidden' : 'grid gap-4 xl:grid-cols-3 [&>*]:min-w-0'}>
            {has('bookings') && !clinical && (
              <Card className="xl:col-span-1">
                <CardHeader title={tt('Upcoming {booking.plural|lower}')} icon={<CalendarDays className="h-4 w-4" />} action={<Link to={`/w/${ws.id}/bookings`} className="inline-flex items-center gap-1 text-xs text-blue-soft hover:text-blue-bright">View all <ArrowRight className="h-3 w-3" /></Link>} />
                <div className="px-5 pb-4 pt-2">
                  {!d ? <SkeletonRows rows={4} className="p-0" /> : d.upcoming.length ? (
                    <ul className="divide-y divide-line">
                      {d.upcoming.map((b) => (
                        <li key={b.id} className="flex items-center gap-3 py-2.5">
                          <div className="w-14 shrink-0 text-center"><div className="num text-[13px] font-semibold text-fg">{time(f, b.start)}</div><div className="text-[12px] text-muted">{b.start ? weekday(f, b.start).split(',')[0].slice(0, 3) : ''}</div></div>
                          <div className="min-w-0 flex-1"><p className="truncate text-[13px] font-medium">{b.contactName || t('contact.singular')}</p><p className="truncate text-[12px] text-fg-2">{b.title || t('booking.singular')}{b.owner ? ` · ${b.owner}` : ''}</p></div>
                          {b.status === 'rescheduled' && <Badge>{t('bookingStatus.rescheduled')}</Badge>}
                        </li>
                      ))}
                    </ul>
                  ) : <EmptyState className="py-8" icon={<CalendarDays className="h-5 w-5" />} title={tt('No upcoming {booking.plural|lower}')} />}
                </div>
              </Card>
            )}
            {!clinical && (            <Card className={has('bookings') ? 'xl:col-span-2' : 'xl:col-span-3'}>
              <CardHeader title="Recent activity" action={<Link to={`/w/${ws.id}/activity`} className="inline-flex items-center gap-1 text-xs text-blue-soft hover:text-blue-bright">Timeline <ArrowRight className="h-3 w-3" /></Link>} />
              <div className="grid gap-x-8 px-5 pb-3 pt-1 md:grid-cols-2">
                {!d ? <SkeletonRows rows={6} className="p-0" /> : d.recent.length ? d.recent.map((a) => <ActivityRow key={a.id} a={a} compact />) : <EmptyState className="py-8 md:col-span-2" icon={<Sparkles className="h-5 w-5" />} title="No activity yet" />}
              </div>
            </Card>
            )}
          </div>
        </div>
      )}
    </Page>
  );
}
