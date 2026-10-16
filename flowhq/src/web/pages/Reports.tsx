// Reports visualise the backend's own report engine: the analytics are computed by the same code that writes the weekly report,
// and stored reports are shown as written. This page never calculates a business number of its own.
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, BarChart3, FileText, Lightbulb, Sparkles } from 'lucide-react';
import type { Analytics, AnalyticsCategory, AnalyticsMetric, Report } from '@core/domain';
import { ANALYTICS_CATEGORIES } from '@core/registry';
import { api, ws as wsPath } from '../lib/api';
import { useWs } from '../lib/workspace';
import { dateTime, number, percent } from '../lib/format';
import { cn } from '../lib/cn';
import { Page } from '../components/layout/Shell';
import { Badge, Card, CardHeader, Segmented } from '../components/ui/primitives';
import { EmptyState, ErrorState, Skeleton, SkeletonRows } from '../components/ui/feedback';
import { BarList } from '../components/data/charts';

const ORDER: AnalyticsCategory[] = ['acquisition', 'conversion', 'engagement', 'bookings', 'ai', 'handoffs', 'automation', 'retention', 'feedback'];

export default function Reports() {
  const { ws, automation, has } = useWs();
  const [week, setWeek] = useState<'last' | 'this'>('last');
  const [tab, setTab] = useState<'overview' | 'reports'>('overview');
  const an = useQuery({ queryKey: ['analytics', ws.id, week], queryFn: () => api<Analytics>(wsPath(ws.id, `/analytics?week=${week}`)) });
  const reports = useQuery({ queryKey: ['reports', ws.id], queryFn: () => api<Report[]>(wsPath(ws.id, '/reports')), enabled: ws.backend.capabilities.reports });
  const engine = an.data ? automation(an.data.engine as never).name : automation('weekly_reports').name;
  const shownCategory = (c: AnalyticsCategory) => (c === 'ai' || c === 'handoffs' ? has('ai') : c === 'bookings' ? has('bookings') : c === 'retention' || c === 'feedback' ? has('follow_ups') || has('reviews') : true);
  return (
    <Page
      title="Reports"
      subtitle={<span className="inline-flex items-center gap-1.5"><BarChart3 className="h-3.5 w-3.5 text-blue-bright" />Numbers from {engine}: the same engine that writes the weekly report.</span>}
      actions={<>
        {ws.backend.capabilities.reports && <Segmented value={tab} onChange={setTab} options={[{ value: 'overview', label: 'Overview' }, { value: 'reports', label: 'Weekly reports', count: reports.data?.length }]} />}
        {tab === 'overview' && <Segmented value={week} onChange={setWeek} options={[{ value: 'last', label: 'Last week' }, { value: 'this', label: 'This week so far' }]} />}
      </>}
    >
      {tab === 'overview' ? (
        an.error ? <Card><ErrorState error={an.error} retry={() => an.refetch()} /></Card> : !an.data ? (
          <div className="space-y-5"><div className="grid grid-cols-2 gap-3 md:grid-cols-4">{Array.from({ length: 4 }, (_, i) => <Card key={i} className="p-4"><Skeleton className="h-3 w-24" /><Skeleton className="mt-3 h-7 w-14" /></Card>)}</div><div className="grid gap-4 lg:grid-cols-2">{Array.from({ length: 4 }, (_, i) => <Card key={i}><SkeletonRows rows={4} /></Card>)}</div></div>
        ) : <Overview a={an.data} categories={ORDER.filter(shownCategory)} />
      ) : (
        <StoredReports q={reports} />
      )}
    </Page>
  );
}

function useMetricFormat() {
  const { f } = useWs();
  return (m: Pick<AnalyticsMetric, 'unit' | 'value'>) => (m.value === null ? '—' : m.unit === 'percent' ? percent(f, m.value) : m.unit === 'minutes' ? `${number(f, m.value, 1)} min` : number(f, m.value));
}

function Overview({ a, categories }: { a: Analytics; categories: AnalyticsCategory[] }) {
  const { tt, f, automation } = useWs();
  const show = useMetricFormat();
  const present = categories.filter((c) => a.metrics.some((m) => m.category === c));
  const headline = present.map((c) => a.metrics.find((m) => m.category === c)!).slice(0, 4);
  const label = (s: string) => (s.startsWith('automation:') ? automation(s.slice(11) as never).name : tt(s));
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2 text-[12.5px] text-fg-2">
        <Badge tone="blue">{a.period.label}</Badge>
        {a.incomplete && <Badge tone="amber" icon={<AlertTriangle className="h-3 w-3" />}>Some history was cut at the row limit</Badge>}
      </div>
      <section aria-label="Headline numbers" className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {headline.map((m, i) => (
          <Card key={m.key} className={cn('relative overflow-hidden p-4', i === 0 && 'border-blue/25')}>
            {i === 0 && <div className="pointer-events-none absolute -right-10 -top-10 h-28 w-28 rounded-full bg-blue/20 blur-2xl" />}
            <div className="text-[12.5px] text-fg-2">{tt(m.label)}</div>
            <div className="num mt-2 text-[28px] font-semibold leading-none">{show(m)}</div>
            <div className="mt-2 text-[11.5px] text-muted">{tt(ANALYTICS_CATEGORIES[m.category].label)}</div>
          </Card>
        ))}
      </section>
      <div className="grid gap-4 lg:grid-cols-2">
        {present.map((c) => {
          const metrics = a.metrics.filter((m) => m.category === c);
          const breakdowns = a.breakdowns.filter((b) => b.category === c);
          const def = ANALYTICS_CATEGORIES[c];
          return (
            <Card key={c}>
              <CardHeader title={tt(def.label)} subtitle={tt(def.description)} icon={c === 'ai' ? <Sparkles className="h-4 w-4" /> : undefined} />
              <div className="px-5 pb-5 pt-3">
                <dl className="grid grid-cols-2 gap-x-6 gap-y-2.5 sm:grid-cols-3">
                  {metrics.map((m) => (
                    <div key={m.key} className="flex flex-col-reverse">
                      <dt className="text-[11.5px] leading-snug text-muted">{tt(m.label)}</dt>
                      <dd className="num text-[18px] font-semibold text-fg">{show(m)}</dd>
                    </div>
                  ))}
                </dl>
                {breakdowns.map((b) => (
                  <div key={b.key} className="mt-5">
                    <div className="label mb-2.5">{tt(b.label)}</div>
                    <BarList items={b.items.map((i) => ({ label: label(i.label), value: i.value }))} format={(n) => number(f, n)} empty="Nothing in this period" />
                  </div>
                ))}
              </div>
            </Card>
          );
        })}
      </div>
    </div>
  );
}

function StoredReports({ q }: { q: { data?: Report[]; error: unknown; isLoading: boolean; refetch: () => unknown } }) {
  const { f, automation } = useWs();
  const [sel, setSel] = useState<string | null>(null);
  if (q.error) return <Card><ErrorState error={q.error} retry={() => q.refetch()} /></Card>;
  if (q.isLoading || !q.data) return <Card><SkeletonRows rows={6} /></Card>;
  if (!q.data.length) return <Card><EmptyState icon={<FileText className="h-5 w-5" />} title="No reports yet" body={`Reports appear here every time ${automation('weekly_reports').name} runs.`} /></Card>;
  const r = q.data.find((x) => x.id === sel) || q.data[0];
  return (
    <div className="grid gap-4 lg:grid-cols-[280px_1fr]">
      <Card className="h-fit p-2">
        <ul role="listbox" aria-label="Reports">
          {q.data.map((x) => (
            <li key={x.id}>
              <button role="option" aria-selected={x.id === r.id} onClick={() => setSel(x.id)} className={cn('w-full rounded-lg px-3 py-2.5 text-left transition-colors', x.id === r.id ? 'bg-blue/[0.1] shadow-[inset_0_0_0_1px_rgb(var(--blue)/0.25)]' : 'hover:bg-surface-2')}>
                <div className="truncate text-[13px] font-medium">{x.periodLabel || 'Weekly report'}</div>
                <div className="text-[11.5px] text-muted">Generated {dateTime(f, x.generatedAt)}</div>
              </button>
            </li>
          ))}
        </ul>
      </Card>
      <Card>
        <div className="border-b border-line px-6 py-4">
          <h2 className="text-[15px] font-semibold">{r.periodLabel || r.title}</h2>
          <p className="mt-0.5 text-[12px] text-muted">Generated {dateTime(f, r.generatedAt)} · numbers computed by the automation, text checked against them</p>
        </div>
        <div className="space-y-6 px-6 py-5">
          {r.sections.map((s, i) => {
            const advice = /recommend/i.test(s.title);
            return (
              <section key={s.key} className={cn(advice && 'ai-tint rounded-xl border border-blue/20 p-4')}>
                <h3 className="mb-2 flex items-center gap-2 text-[13px] font-semibold text-fg">{advice ? <Lightbulb className="h-4 w-4 text-blue-bright" /> : <span className="num flex h-5 w-5 items-center justify-center rounded-md bg-surface-2 text-[11px] text-fg-2">{i + 1}</span>}{s.title}</h3>
                <ul className="space-y-1.5">
                  {s.lines.map((l, k) => <li key={k} className={cn('text-[13px] leading-relaxed text-fg-2', s.lines.length > 1 && 'relative pl-4 before:absolute before:left-0 before:top-[9px] before:h-1 before:w-1 before:rounded-full before:bg-blue-soft/70')}>{l}</li>)}
                </ul>
              </section>
            );
          })}
          {r.note && <p className="rounded-lg border border-warn/25 bg-warn/[0.07] px-3 py-2 text-[12px] text-fg-2">{r.note}</p>}
        </div>
      </Card>
    </div>
  );
}
