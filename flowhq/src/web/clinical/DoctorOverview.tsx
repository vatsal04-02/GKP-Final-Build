// The doctor's part of the dashboard: who is coming back, who was seen, what was prescribed, what is owed.
// Shown only for workspaces that have the clinic records; every number comes from /clinic-summary (nothing is invented here).
import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, ArrowRight, CalendarCheck, CheckCircle2, ClipboardList, FileText, IndianRupee, Phone, UserCheck, UserPlus, Users, Wallet } from 'lucide-react';
import type { DoctorSummary, DoctorTile, TileKey } from '@core/clinical';
import { api, ws as wsPath } from '../lib/api';
import { useWs } from '../lib/workspace';
import { cn } from '../lib/cn';
import { Badge, Card, CardHeader } from '../components/ui/primitives';
import { EmptyState, ErrorState, Skeleton } from '../components/ui/feedback';
import { fdate, rs } from './common';
import { DoctorFilter, useDoctorFilter } from './DoctorFilter';

// true when this workspace keeps clinic records (the dashboard then leads with the doctor's view)
export function useHasDoctorOverview() { return useWs().has('patients'); }

const link = 'inline-flex items-center gap-1 text-xs text-blue-soft hover:text-blue-bright';
type Status = 'ok' | 'warn' | 'bad' | undefined;
// one muted palette for status, used for accents only: soft green = healthy, soft amber = needs attention, soft red = overdue
const TEXT: Record<'ok' | 'warn' | 'bad', string> = { ok: 'text-ok', warn: 'text-warn', bad: 'text-bad' };
const CHIP: Record<'ok' | 'warn' | 'bad', string> = { ok: 'border-ok/25 bg-ok/10 text-ok', warn: 'border-warn/25 bg-warn/10 text-warn', bad: 'border-bad/25 bg-bad/10 text-bad' };
const delay = (i: number): CSSProperties => ({ ['--d' as string]: `${i * 40}ms` });
const reduced = () => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

// counts up from 0 (600ms, ease-out) whenever the value changes; instant when the user prefers reduced motion
function useCountUp(value: number) {
  const [shown, setShown] = useState(reduced() ? value : 0);
  useEffect(() => {
    if (reduced()) { setShown(value); return; }
    const t0 = performance.now(); let raf = 0;
    const step = (t: number) => { const k = Math.min(1, (t - t0) / 600); setShown(value * (1 - Math.pow(1 - k, 3))); if (k < 1) raf = requestAnimationFrame(step); };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value]);
  return Math.abs(shown - value) < 0.5 ? value : shown;
}
const Count = ({ value, format }: { value: number; format: (n: number) => string }) => <>{format(Math.round(useCountUp(value)))}</>;

function Spark({ values, tone }: { values: number[]; tone?: Status }) {
  const W = 64; const H = 20; const max = Math.max(...values, 0);
  const cls = cn('h-5 w-16 shrink-0', tone ? TEXT[tone] : 'text-fg-2');
  if (!values.length || max === 0) return <svg viewBox={`0 0 ${W} ${H}`} className={cn(cls, 'opacity-40')} aria-hidden="true"><line x1="1" y1={H - 2} x2={W - 1} y2={H - 2} stroke="currentColor" strokeWidth="1.5" strokeDasharray="3 3" strokeLinecap="round" /></svg>;
  const pts = values.map((v, i) => `${(1 + (i * (W - 2)) / Math.max(1, values.length - 1)).toFixed(1)},${(H - 2 - (v / max) * (H - 5)).toFixed(1)}`).join(' ');
  return <svg viewBox={`0 0 ${W} ${H}`} className={cls} aria-hidden="true"><polyline points={pts} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" /></svg>;
};

interface TileSpec { key: TileKey; label: string; icon: ReactNode; money?: boolean; empty: string; emptyTone?: 'ok'; goodWhen?: 'up' | 'down'; status: (t: DoctorTile, d: DoctorSummary) => Status; sub: (range: string) => string }
const SPECS: TileSpec[] = [
  { key: 'seen', label: 'Patients seen', icon: <UserCheck className="h-4 w-4" />, empty: 'No one seen yet', goodWhen: 'up', status: () => undefined, sub: (r) => r },
  { key: 'followUps', label: 'Follow-ups due', icon: <CalendarCheck className="h-4 w-4" />, empty: 'All caught up', emptyTone: 'ok', status: (t, d) => (t.value === 0 ? 'ok' : d.followUps.some((f) => f.overdueDays > 0) ? 'bad' : 'warn'), sub: () => 'due today or overdue' },
  { key: 'active', label: 'Active patients', icon: <Users className="h-4 w-4" />, empty: 'No active patients', status: () => undefined, sub: () => 'under treatment' },
  { key: 'newPatients', label: 'New patients', icon: <UserPlus className="h-4 w-4" />, empty: 'None registered', goodWhen: 'up', status: () => undefined, sub: (r) => r },
  { key: 'prescriptions', label: 'Prescriptions', icon: <FileText className="h-4 w-4" />, empty: 'None written', goodWhen: 'up', status: () => undefined, sub: (r) => r },
  { key: 'collected', label: 'Collected', icon: <IndianRupee className="h-4 w-4" />, money: true, empty: 'Nothing collected', goodWhen: 'up', status: (t) => (t.value > 0 ? 'ok' : undefined), sub: (r) => r },
  { key: 'outstanding', label: 'Outstanding dues', icon: <Wallet className="h-4 w-4" />, money: true, empty: 'All settled', emptyTone: 'ok', goodWhen: 'down', status: (t) => (t.value > 0 ? 'warn' : 'ok'), sub: () => 'to collect' },
  { key: 'visits', label: 'Visits attended', icon: <ClipboardList className="h-4 w-4" />, empty: 'No visits yet', goodWhen: 'up', status: () => undefined, sub: (r) => r },
];

function Tile({ spec, tile, d, vs, range, i }: { spec: TileSpec; tile: DoctorTile; d: DoctorSummary; vs: string; range: string; i: number }) {
  const status = spec.status(tile, d);
  const fmt = (n: number) => (spec.money ? rs(n) : String(n));
  const diff = tile.previous === null ? null : tile.value - tile.previous;
  const good = diff === null || diff === 0 || !spec.goodWhen ? null : (diff > 0) === (spec.goodWhen === 'up');
  const empty = tile.value === 0;
  return (
    <Card className="fhq-rise p-[13px]" style={delay(i)}>
      <div className="flex items-start justify-between gap-2">
        <span className="text-[12.5px] font-medium text-fg-2">{spec.label}</span>
        <span className={cn('flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-line bg-surface text-fg-2', status && CHIP[status])}>{spec.icon}</span>
      </div>
      <div className="mt-2 flex min-h-[34px] flex-wrap items-end justify-between gap-x-2 gap-y-1">
        {empty ? (
          <span className={cn('flex items-center gap-1.5 text-[14px] font-medium leading-tight', spec.emptyTone === 'ok' ? TEXT.ok : 'text-muted')}>{spec.emptyTone === 'ok' && <CheckCircle2 className="h-4 w-4" />}{spec.empty}</span>
        ) : (
          <span className={cn('num text-[24px] font-semibold leading-none', status ? TEXT[status] : 'text-fg')}><Count value={tile.value} format={fmt} /></span>
        )}
        <Spark values={tile.series} tone={status} />
      </div>
      <div className="mt-2 flex h-4 items-center gap-1.5 overflow-hidden whitespace-nowrap text-[11.5px] text-muted">
        {diff === null ? <span>—</span> : diff === 0 ? <span>same as {vs}</span> : (
          <span className={cn('font-medium', good === null ? 'text-fg-2' : good ? 'text-ok' : 'text-bad')}>{diff > 0 ? '+' : '-'}{fmt(Math.abs(diff))} vs {vs}</span>
        )}
        <span className="hidden truncate sm:inline">· {spec.sub(range)}</span>
      </div>
    </Card>
  );
}

function Hero({ d, base, has }: { d: DoctorSummary; base: string; has: (m: string) => boolean }) {
  const due = d.tiles.followUps.value;
  const next = d.followUps.find((f) => f.followUpOn <= d.today);
  const callable = d.followUps.find((f) => f.followUpOn <= d.today && f.phone);
  const showDue = due > 0;
  const big = showDue ? due : d.collectedTodayPaise;
  const cta = 'inline-flex h-10 shrink-0 items-center gap-2 rounded-lg px-4 text-sm font-semibold transition-all btn-primary text-white hover:brightness-110';
  return (
    <Card className="fhq-rise relative overflow-hidden" style={delay(0)}>
      <span className={cn('absolute inset-y-0 left-0 w-1', showDue ? (next && next.overdueDays > 0 ? 'bg-bad/60' : 'bg-warn/60') : 'bg-ok/60')} aria-hidden="true" />
      <div className="flex flex-wrap items-center justify-between gap-4 py-4 pl-6 pr-5">
        <div className="min-w-0">
          <div className="text-[12px] font-semibold uppercase tracking-wide text-muted">{showDue ? 'Needs your call today' : 'Today so far'}</div>
          <div className="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className={cn('num font-display text-[40px] font-bold leading-none [font-variant-numeric:lining-nums]', showDue ? (next && next.overdueDays > 0 ? TEXT.bad : TEXT.warn) : big > 0 ? TEXT.ok : 'text-fg')}><Count value={big} format={showDue ? String : rs} /></span>
            <span className="text-[14px] text-fg-2">
              {showDue ? `follow-up${due === 1 ? '' : 's'} due${next ? ` · ${next.name}${next.overdueDays > 0 ? `, ${next.overdueDays}d overdue` : ''} first` : ''}`
                : big > 0 ? 'collected today' : 'nothing collected yet today'}
            </span>
          </div>
        </div>
        {showDue ? (callable ? <a href={`tel:${callable.phone}`} className={cta}><Phone className="h-4 w-4" />Call now</a>
          : has('patients') ? <Link to={`${base}/patients`} className={cta}>View<ArrowRight className="h-4 w-4" /></Link> : null)
          : has('invoices') ? <Link to={`${base}/invoices`} className={cta}>View<ArrowRight className="h-4 w-4" /></Link> : null}
      </div>
    </Card>
  );
}

// 7 (or 30) daily bars, today highlighted; drawn with plain divs so it needs no chart library
function AttendanceBars({ data, today }: { data: DoctorSummary['attendance']; today: string }) {
  const max = Math.max(...data.map((a) => a.attended));
  const long = data.length > 7;
  const label = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-IN', long ? { day: 'numeric', month: 'short', timeZone: 'UTC' } : { weekday: 'short', timeZone: 'UTC' });
  if (max === 0) return <EmptyState className="py-8" icon={<ClipboardList className="h-5 w-5" />} title="No attendance recorded in this period" body="Mark attendance as patients arrive and it shows up here." />;
  const top = Math.max(4, max);
  return (
    <div className="px-5 pb-4 pt-3">
      <div className="flex h-[150px] items-end gap-1.5 sm:gap-2" role="img" aria-label="Patients attended per day">
        {data.map((a, i) => (
          <div key={a.date} className="group relative flex h-full min-w-0 flex-1 flex-col justify-end" title={`${fdate(a.date)}: ${a.attended} attended`}>
            <span className="num mb-1 text-center text-[11px] text-muted opacity-0 transition-opacity group-hover:opacity-100">{a.attended}</span>
            <div className={cn('fhq-grow w-full rounded-t-md', a.date === today ? 'bg-blue-bright' : 'bg-blue-soft/45', a.attended === 0 && 'opacity-30')}
              style={{ height: `${Math.max(a.attended === 0 ? 2 : 6, (a.attended / top) * 100)}%`, ...delay(i) }} />
          </div>
        ))}
      </div>
      <div className="mt-2 flex gap-1.5 sm:gap-2">
        {data.map((a, i) => (
          <span key={a.date} className={cn('relative h-4 min-w-0 flex-1 text-[11px]', a.date === today ? 'font-semibold text-fg' : 'text-muted', long && i % 5 !== 0 && a.date !== today && 'invisible')}>
            <span className="absolute left-1/2 -translate-x-1/2 whitespace-nowrap">{label(a.date)}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

export function DoctorOverview({ days }: { days: string }) {
  const { ws, has } = useWs();
  const doc = useDoctorFilter();
  const q = useQuery({ queryKey: ['clinic-summary', ws.id, days, doc.key], queryFn: () => api<DoctorSummary>(wsPath(ws.id, `/clinic-summary?days=${days}${doc.qs}`)), refetchInterval: 60000 });
  const d = q.data;
  const base = `/w/${ws.id}`;
  if (q.error) return <Card><ErrorState error={q.error} retry={() => q.refetch()} /></Card>;
  const range = days === '1' ? 'today' : `last ${days} days`;
  const vs = days === '1' ? 'yesterday' : days === '7' ? 'last week' : 'previous 30 days';
  const period = days === '1' ? 'today' : `in the last ${days} days`;
  return (
    <div className="space-y-4">
      {(doc.show || doc.own) && (
        <div className="flex flex-wrap items-center gap-2.5">
          {doc.own ? <span className="text-[12.5px] text-fg-2">Prescriptions and dues shown here are <b className="font-medium text-fg">{doc.own}</b>'s own. Patients and attendance are shared.</span> : <><span className="text-[12.5px] text-fg-2">Prescriptions and dues for</span><DoctorFilter f={doc} /></>}
        </div>
      )}
      {!d ? <Card className="p-5"><Skeleton className="h-12 w-64" /></Card> : <Hero d={d} base={base} has={has} />}

      <section aria-label="Clinic numbers" className="grid grid-cols-2 gap-2.5 md:grid-cols-4">
        {!d ? Array.from({ length: 8 }, (_, i) => <Card key={i} className="p-[13px]"><Skeleton className="h-3 w-24" /><Skeleton className="mt-4 h-7 w-16" /></Card>)
          : SPECS.map((s, i) => <Tile key={s.key} spec={s} tile={d.tiles[s.key]} d={d} vs={vs} range={range} i={i + 1} />)}
      </section>

      {d?.byDoctor && d.byDoctor.length > 0 && (
        <Card className="fhq-rise" style={delay(8)}>
          <CardHeader title="By doctor" subtitle={`Dues, collections and prescriptions ${period}, side by side`} icon={<Users className="h-4 w-4" />} />
          <div className="overflow-x-auto px-5 pb-4 pt-1">
            <table className="w-full min-w-[420px] text-[13px]">
              <thead><tr className="text-left text-[11.5px] uppercase tracking-wide text-muted"><th className="py-2 pr-3 font-medium">Doctor</th><th className="px-3 py-2 text-right font-medium">Dues</th><th className="px-3 py-2 text-right font-medium">Collected</th><th className="py-2 pl-3 text-right font-medium">Prescriptions</th></tr></thead>
              <tbody className="divide-y divide-line">
                {d.byDoctor.map((r) => (
                  <tr key={r.name}>
                    <td className="py-2.5 pr-3 font-medium">{r.name}</td>
                    <td className={cn('num px-3 py-2.5 text-right', r.outstandingPaise > 0 && TEXT.warn)}>{rs(r.outstandingPaise)}</td>
                    <td className="num px-3 py-2.5 text-right">{rs(r.collectedPaise)}</td>
                    <td className="num py-2.5 pl-3 text-right">{r.prescriptions}</td>
                  </tr>
                ))}
                <tr className="font-semibold"><td className="py-2.5 pr-3">All doctors</td><td className="num px-3 py-2.5 text-right">{rs(d.byDoctor.reduce((t, r) => t + r.outstandingPaise, 0))}</td><td className="num px-3 py-2.5 text-right">{rs(d.byDoctor.reduce((t, r) => t + r.collectedPaise, 0))}</td><td className="num py-2.5 pl-3 text-right">{d.byDoctor.reduce((t, r) => t + r.prescriptions, 0)}</td></tr>
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <div className="grid gap-5 xl:grid-cols-3">
        <Card className="fhq-rise xl:col-span-2" style={delay(9)}>
          <CardHeader title="Follow-ups to call" subtitle="Active patients due today, overdue or within 3 days" icon={<CalendarCheck className="h-4 w-4" />}
            action={has('patients') ? <Link to={`${base}/patients`} className={link}>Register <ArrowRight className="h-3 w-3" /></Link> : undefined} />
          <div className="px-5 pb-4 pt-1">
            {!d ? <Skeleton className="h-32" /> : d.followUps.length ? (
              <ul className="divide-y divide-line">
                {d.followUps.map((f) => (
                  <li key={f.patientId} className="flex items-center gap-3 py-2.5">
                    <div className="min-w-0 flex-1">
                      <Link to={`${base}/patients/${f.patientId}`} className="block truncate text-[13px] font-medium hover:text-blue-bright">{f.name}</Link>
                      <p className="truncate text-[12px] text-fg-2">{f.complaint || 'No complaint recorded'}</p>
                    </div>
                    {f.overdueDays > 0 ? <Badge tone="red" icon={<AlertTriangle className="h-3 w-3" />}>{f.overdueDays}d overdue</Badge> : f.followUpOn === d.today ? <Badge tone="amber">Today</Badge> : <Badge>{fdate(f.followUpOn)}</Badge>}
                    {f.phone && <a href={`tel:${f.phone}`} className="inline-flex items-center gap-1 text-[12px] text-fg-2 hover:text-fg" aria-label={`Call ${f.name}`}><Phone className="h-3.5 w-3.5" /><span className="hidden sm:inline">{f.phone}</span></a>}
                  </li>
                ))}
              </ul>
            ) : <EmptyState className="py-8" icon={<CheckCircle2 className="h-5 w-5 text-ok" />} title="All caught up" body="No follow-ups are due. Set a follow-up date on a patient and it appears here." />}
          </div>
        </Card>

        <Card className="fhq-rise" style={delay(10)}>
          <CardHeader title="Today's patients" subtitle={d ? `${d.todaysVisits.length} marked in attendance` : ' '} icon={<UserCheck className="h-4 w-4" />}
            action={has('visits') ? <Link to={`${base}/attendance`} className={link}>Attendance <ArrowRight className="h-3 w-3" /></Link> : undefined} />
          <div className="px-5 pb-4 pt-1">
            {!d ? <Skeleton className="h-32" /> : d.todaysVisits.length ? (
              <ul className="divide-y divide-line">
                {d.todaysVisits.map((v) => (
                  <li key={v.patientId} className="flex items-center justify-between gap-3 py-2.5">
                    <Link to={`${base}/patients/${v.patientId}`} className="truncate text-[13px] font-medium hover:text-blue-bright">{v.name}</Link>
                    <Badge tone={v.status === 'Attended' ? 'green' : 'red'}>{v.status}</Badge>
                  </li>
                ))}
              </ul>
            ) : <EmptyState className="py-8" icon={<UserCheck className="h-5 w-5" />} title="No one marked yet" body="Mark attendance as patients arrive." />}
          </div>
        </Card>
      </div>

      <div className="grid gap-5 xl:grid-cols-3">
        <Card className="fhq-rise xl:col-span-2" style={delay(11)}>
          <CardHeader title="Recent prescriptions" subtitle={`Written ${period}`} icon={<FileText className="h-4 w-4" />}
            action={has('prescriptions') ? <Link to={`${base}/prescriptions`} className={link}>All <ArrowRight className="h-3 w-3" /></Link> : undefined} />
          <div className="px-5 pb-4 pt-1">
            {!d ? <Skeleton className="h-32" /> : d.recentPrescriptions.length ? (
              <ul className="divide-y divide-line">
                {d.recentPrescriptions.map((r) => (
                  <li key={r.rxId} className="flex items-center gap-3 py-2.5">
                    <div className="min-w-0 flex-1">
                      <Link to={`${base}/prescriptions/${r.rxId}`} className="block truncate text-[13px] font-medium hover:text-blue-bright">{r.patientName || r.patientId}</Link>
                      <p className="truncate text-[12px] text-fg-2">{r.diagnosis || 'No diagnosis entered'}</p>
                    </div>
                    <span className="num shrink-0 text-[12px] text-muted">{fdate(r.rxDate)}</span>
                  </li>
                ))}
              </ul>
            ) : <EmptyState className="py-8" icon={<FileText className="h-5 w-5" />} title={`No prescriptions ${period}`} />}
          </div>
        </Card>

        <Card className="fhq-rise" style={delay(12)}>
          <CardHeader title="Dues to collect" subtitle="Largest balances first" icon={<Wallet className="h-4 w-4" />}
            action={has('invoices') ? <Link to={`${base}/invoices`} className={link}>Invoices <ArrowRight className="h-3 w-3" /></Link> : undefined} />
          <div className="px-5 pb-4 pt-1">
            {!d ? <Skeleton className="h-32" /> : d.owing.length ? (
              <ul className="divide-y divide-line">
                {d.owing.map((o) => (
                  <li key={o.patientId} className="flex items-center justify-between gap-3 py-2.5">
                    <Link to={`${base}/patients/${o.patientId}`} className="truncate text-[13px] font-medium hover:text-blue-bright">{o.name}</Link>
                    <span className={cn('num shrink-0 rounded-md border px-2 py-0.5 text-[12.5px] font-semibold', CHIP.warn)}>{rs(o.outstandingPaise)}</span>
                  </li>
                ))}
              </ul>
            ) : <EmptyState className="py-8" icon={<CheckCircle2 className="h-5 w-5 text-ok" />} title="All settled" body="No patient owes a balance." />}
          </div>
        </Card>
      </div>

      <Card className="fhq-rise" style={delay(13)}>
        <CardHeader title={`Patients attended, last ${d ? d.attendance.length : 7} days`} subtitle="Today is highlighted" icon={<ClipboardList className="h-4 w-4" />} />
        {!d ? <Skeleton className="mx-5 mb-4 h-[150px]" /> : <AttendanceBars data={d.attendance} today={d.today} />}
      </Card>
    </div>
  );
}
