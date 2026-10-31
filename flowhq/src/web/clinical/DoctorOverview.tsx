// The doctor's part of the dashboard: who is coming back, who was seen, what was prescribed, what is owed.
// Shown only for workspaces that have the clinic records; every number comes from /clinic-summary (nothing is invented here).
import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, CalendarCheck, CheckCircle2, ClipboardList, FileText, IndianRupee, UserCheck, UserPlus, Users, Wallet } from 'lucide-react';
import type { DoctorSummary, DoctorTile, TileKey } from '@core/clinical';
import { api, ws as wsPath } from '../lib/api';
import { useWs } from '../lib/workspace';
import { cn } from '../lib/cn';
import { initials } from '../lib/format';
import { Avatar, Card, CardHeader } from '../components/ui/primitives';
import { EmptyState, ErrorState, Skeleton } from '../components/ui/feedback';
import { fdate, rs } from './common';
import type { Invoice } from '@core/clinical';
import { FollowUpList } from './FollowUpList';
import { TodaysAppointments } from './TodaysAppointments';
import { QuickActions } from './QuickActions';
import { WhatsAppButton } from './WhatsAppButton';
import { followUpMessage } from './whatsapp';
import { PatientsToReview } from './PatientsToReview';
import { moneyNote, moneyState, type MoneyState } from './dashboardLogic';
import { DoctorFilter, type DoctorFilterState } from './DoctorFilter';

// true when this workspace keeps clinic records (the dashboard then leads with the doctor's view)
export function useHasDoctorOverview() { return useWs().has('patients'); }

const link = 'inline-flex items-center gap-1 text-xs text-blue-soft hover:text-blue-bright';
type Status = 'ok' | 'warn' | 'bad' | undefined;
// one muted palette for status, used for accents only: soft green = healthy, soft amber = needs attention, soft red = overdue
const TEXT: Record<'ok' | 'warn' | 'bad', string> = { ok: 'text-ok', warn: 'text-warn', bad: 'text-bad' };
const CHIP: Record<'ok' | 'warn' | 'bad', string> = { ok: 'border-ok/25 bg-ok/10 text-ok', warn: 'border-warn/25 bg-warn/10 text-warn', bad: 'border-bad/25 bg-bad/10 text-bad' };
const delay = (i: number): CSSProperties => ({ ['--d' as string]: `${i * 12}ms` });
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
  return <svg viewBox={`0 0 ${W} ${H}`} className={cls} aria-hidden="true"><polyline points={pts} pathLength={1} className="fhq-draw" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" /></svg>;
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

const PRIMARY: TileKey[] = ['seen', 'followUps', 'active', 'outstanding'];
const money = (spec: TileSpec, tile: DoctorTile, state: MoneyState) => (spec.money ? moneyNote(tile.value, state) : null);

// The four numbers that matter most. A zero in a money tile is only shown as a zero when invoices exist: otherwise it says what is missing.
// A tile that goes somewhere is a link: "#..." jumps within the dashboard, anything else opens that page.
function Go({ to, className, children }: { to?: string; className?: string; children: ReactNode }) {
  if (!to) return <>{children}</>;
  const cls = cn('group block rounded-xl outline-offset-2', className);
  return to.startsWith('#') ? <a href={to} className={cls}>{children}</a> : <Link to={to} className={cls}>{children}</Link>;
}
const BAR: Record<'ok' | 'warn' | 'bad', string> = { ok: 'bg-ok/70', warn: 'bg-warn/70', bad: 'bg-bad/70' };

function Tile({ spec, tile, d, vs, range, i, state, to }: { spec: TileSpec; tile: DoctorTile; d: DoctorSummary; vs: string; range: string; i: number; state: MoneyState; to?: string }) {
  const note = money(spec, tile, state);
  const status = note ? undefined : spec.status(tile, d);
  const fmt = (n: number) => (spec.money ? rs(n) : String(n));
  const diff = tile.previous === null ? null : tile.value - tile.previous;
  const good = diff === null || diff === 0 || !spec.goodWhen ? null : (diff > 0) === (spec.goodWhen === 'up');
  const empty = tile.value === 0;
  return (
    <Go to={to}>
    <Card hover={!!to} className="fhq-rise h-full overflow-hidden p-4" style={delay(i)}>
      {status && <span aria-hidden="true" className={cn('absolute inset-x-0 top-0 h-[3px]', BAR[status])} />}
      <div className="flex items-start justify-between gap-2">
        <span className="text-[12.5px] font-medium text-fg-2">{spec.label}</span>
        <span className={cn('flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-line bg-surface text-fg-2 shadow-[0_1px_2px_rgb(13_64_56/0.08)] transition-transform duration-200 group-hover:scale-110 group-hover:-rotate-6', status && CHIP[status])}>{spec.icon}</span>
      </div>
      <div className="mt-2 flex min-h-[34px] flex-wrap items-end justify-between gap-x-2 gap-y-1">
        {note ? <span className="text-[14px] font-medium leading-tight text-muted">{note}</span> : empty ? (
          <span className={cn('flex items-center gap-1.5 text-[14px] font-medium leading-tight', spec.emptyTone === 'ok' ? TEXT.ok : 'text-muted')}>{spec.emptyTone === 'ok' && <CheckCircle2 className="h-4 w-4" />}{spec.empty}</span>
        ) : (
          <span className={cn('num-display text-[30px] font-semibold leading-none', status ? TEXT[status] : 'text-fg')}><Count value={tile.value} format={fmt} /></span>
        )}
        {!note && <Spark values={tile.series} tone={status} />}
      </div>
      <div className="mt-2 flex min-h-4 flex-wrap items-center gap-x-1.5 text-[11.5px] leading-4 text-muted">
        {note || diff === null ? <span>{spec.sub(range)}</span> : diff === 0 ? <><span>same as {vs}</span><span className="hidden sm:inline">· {spec.sub(range)}</span></> : (
          <><span className={cn('font-medium', good === null ? 'text-fg-2' : good ? 'text-ok' : 'text-bad')}>{diff > 0 ? '+' : '-'}{fmt(Math.abs(diff))} vs {vs}</span><span className="hidden sm:inline">· {spec.sub(range)}</span></>
        )}
        {to && <ArrowRight aria-hidden="true" className="ml-auto h-3.5 w-3.5 -translate-x-1 text-blue-bright opacity-0 transition-all duration-200 group-hover:translate-x-0 group-hover:opacity-100" />}
      </div>
    </Card>
    </Go>
  );
}

// The other four, as one compact strip.
function MiniStat({ spec, tile, vs, range, state, to }: { spec: TileSpec; tile: DoctorTile; vs: string; range: string; state: MoneyState; to?: string }) {
  const note = money(spec, tile, state);
  const fmt = (n: number) => (spec.money ? rs(n) : String(n));
  const diff = tile.previous === null ? null : tile.value - tile.previous;
  const good = diff === null || diff === 0 || !spec.goodWhen ? null : (diff > 0) === (spec.goodWhen === 'up');
  return (
    <Go to={to}>
    <Card hover={!!to} className="flex h-full min-w-0 items-center gap-2.5 !rounded-lg px-3 py-2.5">
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-line bg-surface-2 text-fg-2 transition-transform duration-200 group-hover:scale-110">{spec.icon}</span>
      <div className="min-w-0">
        <div className="text-[11.5px] leading-tight text-fg-2">{spec.label} <span className="text-muted">· {range}</span></div>
        <div className="mt-0.5 flex flex-wrap items-baseline gap-x-1.5">
          {note ? <span className="text-[12.5px] font-medium text-muted">{note}</span> : <span className="num text-[16px] font-semibold leading-tight">{fmt(tile.value)}</span>}
          {!note && diff !== null && diff !== 0 && <span className={cn('text-[12px] font-medium', good === null ? 'text-fg-2' : good ? 'text-ok' : 'text-bad')} title={`compared with ${vs}`}>{diff > 0 ? '+' : '-'}{fmt(Math.abs(diff))}</span>}
        </div>
      </div>
    </Card>
    </Go>
  );
}


// Money, kept apart from the patient follow-ups: what came in over the period and what is still owed today.
function PaymentsSummary({ d, state, range, base, has, className }: { d: DoctorSummary; state: MoneyState; range: string; base: string; has: (m: string) => boolean; className?: string }) {
  const col = d.tiles.collected; const out = d.tiles.outstanding;
  const cell = (label: string, hint: string, v: number, tone: Status) => {
    const note = moneyNote(v, state);
    return (
      <div className="min-w-0">
        <div className="text-[12px] font-medium text-fg-2">{label}</div>
        {note ? <div className="mt-1 text-[14px] font-medium text-muted">{note}</div> : <div className={cn('num mt-1 break-words text-[24px] font-semibold leading-tight', tone ? TEXT[tone] : 'text-fg')}>{rs(v)}</div>}
        <div className="mt-0.5 text-[11.5px] text-muted">{hint}</div>
      </div>
    );
  };
  return (
    <Card className={cn('fhq-rise', className)} style={delay(8)}>
      <CardHeader title="Payments" subtitle="Money only: collected and still owed" icon={<Wallet className="h-4 w-4" />}
        action={has('invoices') ? <Link to={`${base}/invoices`} className={cn(link, 'shrink-0')}>Invoices <ArrowRight className="h-3 w-3" /></Link> : undefined} />
      <div className="grid grid-cols-2 gap-4 px-4 pb-4 pt-3 sm:px-5">
        {cell('Collected', range, col.value, col.value > 0 ? 'ok' : undefined)}
        {cell('Outstanding', 'all unpaid balances today', out.value, out.value > 0 ? 'warn' : 'ok')}
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
      <span className={cn('absolute inset-y-0 left-0 w-1', showDue ? (next && next.overdueDays > 0 ? 'bg-bad/60 fhq-breathe' : 'bg-warn/60') : 'bg-ok/60')} aria-hidden="true" />
      <span className={cn('pointer-events-none absolute -left-16 -top-16 h-48 w-72 rounded-full blur-3xl', showDue ? (next && next.overdueDays > 0 ? 'bg-bad/[0.07]' : 'bg-warn/[0.08]') : 'bg-ok/[0.08]')} aria-hidden="true" />
      <div className="flex flex-wrap items-center justify-between gap-3 py-3 pl-5 pr-4">
        <div className="min-w-0">
          <div className="text-[12.5px] font-semibold text-muted">{showDue ? 'Needs a message today' : 'Today so far'}</div>
          <div className="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-1">
            {(showDue || big > 0) ? <span className={cn('num font-display text-[34px] font-bold leading-none [font-variant-numeric:lining-nums]', showDue ? (next && next.overdueDays > 0 ? TEXT.bad : TEXT.warn) : TEXT.ok)}><Count value={big} format={showDue ? String : rs} /></span>
              : <span className="inline-flex items-center gap-2 font-display text-[24px] font-semibold text-ok"><CheckCircle2 className="h-6 w-6" />All caught up</span>}
            <span className="text-[14px] text-fg-2">
              {showDue ? `follow-up${due === 1 ? '' : 's'} due${next ? ` · ${next.name}${next.overdueDays > 0 ? `, ${next.overdueDays} day${next.overdueDays === 1 ? '' : 's'} overdue` : ''} first` : ''}`
                : big > 0 ? 'collected today' : 'no follow-ups due · no payment recorded yet today'}
            </span>
          </div>
        </div>
        {showDue ? (callable ? <div className="flex flex-wrap items-center gap-2"><a href="#follow-ups" className="text-[13px] font-medium text-blue-soft hover:text-blue-bright">See the list</a><WhatsAppButton size="lg" phone={callable.phone} name={callable.name} label="Message now" message={(clinic) => followUpMessage({ name: callable.name, clinic, followUpOn: callable.followUpOn, today: d.today })} /></div>
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
      <div className="flex h-[96px] items-end gap-1.5 sm:gap-2" role="img" aria-label="Patients attended per day">
        {data.map((a, i) => (
          <div key={a.date} className="group relative flex h-full min-w-0 flex-1 flex-col justify-end" title={`${fdate(a.date)}: ${a.attended} attended`}>
            <span className="num mb-1 text-center text-[12px] text-muted opacity-0 transition-opacity group-hover:opacity-100">{a.attended}</span>
            <div className={cn('fhq-grow w-full rounded-t-md', a.date === today ? 'bg-blue-bright' : 'bg-blue-soft/45', a.attended === 0 && 'opacity-30')}
              style={{ height: `${Math.max(a.attended === 0 ? 2 : 6, (a.attended / top) * 100)}%`, ...delay(i) }} />
          </div>
        ))}
      </div>
      <div className="mt-2 flex gap-1.5 sm:gap-2">
        {data.map((a, i) => (
          <span key={a.date} className={cn('relative h-4 min-w-0 flex-1 text-[12px]', a.date === today ? 'font-semibold text-fg' : 'text-muted', long && i % 5 !== 0 && a.date !== today && 'invisible')}>
            <span className="absolute left-1/2 -translate-x-1/2 whitespace-nowrap">{label(a.date)}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

export function DoctorOverview({ days, doc }: { days: string; doc: DoctorFilterState }) {
  const { ws, has } = useWs();
  const q = useQuery({ queryKey: ['clinic-summary', ws.id, days, doc.key], queryFn: () => api<DoctorSummary>(wsPath(ws.id, `/clinic-summary?days=${days}${doc.qs}`)), refetchInterval: 60000 });
  // Does this view have any invoices at all? Decides whether a money zero is a real zero (same endpoint and doctor scope as the Invoices page).
  const inv = useQuery({ queryKey: ['invoices-any', ws.id, doc.key], queryFn: () => api<Invoice[]>(wsPath(ws.id, `/invoices${doc.qs ? `?${doc.qs.slice(1)}` : ''}`)), enabled: has('invoices'), staleTime: 60000 });
  const state: MoneyState = has('invoices') ? moneyState({ loading: inv.isLoading, error: inv.isError, count: inv.data ? inv.data.length : null }) : 'unknown';
  const d = q.data;
  const base = `/w/${ws.id}`;
  if (q.error) return <Card><ErrorState error={q.error} retry={() => q.refetch()} /></Card>;
  const range = days === '1' ? 'today' : `last ${days} days`;
  const vs = days === '1' ? 'yesterday' : days === '7' ? 'last week' : 'previous 30 days';
  const period = days === '1' ? 'today' : `in the last ${days} days`;
  const primary = PRIMARY.map((k) => SPECS.find((s) => s.key === k)!);
  const more = SPECS.filter((s) => !PRIMARY.includes(s.key));
  // where each tile leads (only for modules this workspace has)
  const dest: Partial<Record<TileKey, string>> = {
    followUps: '#follow-ups',
    seen: has('visits') ? `${base}/attendance` : undefined, visits: has('visits') ? `${base}/attendance` : undefined,
    active: has('patients') ? `${base}/patients` : undefined, newPatients: has('patients') ? `${base}/patients` : undefined,
    prescriptions: has('prescriptions') ? `${base}/prescriptions` : undefined,
    outstanding: has('invoices') ? `${base}/invoices` : undefined, collected: has('invoices') ? `${base}/invoices` : undefined,
  };
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <QuickActions base={base} />
        {(doc.show || doc.own) && (
          <div className="flex flex-wrap items-center gap-2.5">
            {doc.own ? <span className="text-[12.5px] text-fg-2">Showing <b className="font-medium text-fg">{doc.own}</b>'s own prescriptions and dues. Patients and attendance are shared.</span> : <><span className="text-[12.5px] text-fg-2">Prescriptions and dues for</span><DoctorFilter f={doc} /></>}
          </div>
        )}
      </div>
      {!d ? <Card className="p-5"><Skeleton className="h-12 w-64" /></Card> : <Hero d={d} base={base} has={has} />}

      <div className="space-y-3">
        <section aria-label="Key numbers" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {!d ? Array.from({ length: 4 }, (_, i) => <Card key={i} className="p-3.5"><Skeleton className="h-3 w-24" /><Skeleton className="mt-4 h-7 w-16" /></Card>)
            : primary.map((s, i) => <Tile key={s.key} spec={s} tile={d.tiles[s.key]} d={d} vs={vs} range={range} i={i + 1} state={state} to={dest[s.key]} />)}
        </section>
        <section aria-label="More numbers" className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {!d ? Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-[52px] rounded-lg" />)
            : more.map((s) => <MiniStat key={s.key} spec={s} tile={d.tiles[s.key]} vs={vs} range={range} state={state} to={dest[s.key]} />)}
        </section>
      </div>

      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_24rem] [&>*]:min-w-0">
        <div className="space-y-6">
          <div id="follow-ups" className="scroll-mt-4"><FollowUpList d={d} base={base} hasPatients={has('patients')} /></div>
          {has('patients') && <PatientsToReview base={base} today={d?.today} />}
          <Card className="fhq-rise" style={delay(11)}>
            <CardHeader title="Recent prescriptions" subtitle={`Written ${period}`} icon={<FileText className="h-4 w-4" />}
              action={has('prescriptions') ? <Link to={`${base}/prescriptions`} className={cn(link, 'shrink-0')}>All <ArrowRight className="h-3 w-3" /></Link> : undefined} />
            <div className="px-4 pb-3 pt-1 sm:px-5">
              {!d ? <Skeleton className="h-32" /> : d.recentPrescriptions.length ? (
                <ul className="divide-y divide-line">
                  {d.recentPrescriptions.map((r) => (
                    <li key={r.rxId} className="flex flex-wrap items-start gap-x-3 gap-y-1 py-2.5">
                      <div className="min-w-[10rem] flex-1">
                        <Link to={`${base}/prescriptions/${r.rxId}`} className="block break-words text-[13.5px] font-medium leading-snug hover:text-blue-bright">{r.patientName || r.patientId}</Link>
                        <p className="mt-0.5 break-words text-[12px] text-fg-2">{r.diagnosis || 'No diagnosis entered'}</p>
                      </div>
                      <span className="num shrink-0 text-[12px] text-muted">{fdate(r.rxDate)}</span>
                    </li>
                  ))}
                </ul>
              ) : <p className="flex items-center gap-2.5 py-3 text-[13px] text-fg-2"><FileText className="h-4 w-4 shrink-0 text-muted" /><span><span className="font-medium text-fg">No prescriptions {`${period}`}</span></span></p>}
            </div>
          </Card>


          <Card className="fhq-rise" style={delay(13)}>
            <CardHeader title={`Patients attended, last ${d ? d.attendance.length : 7} days`} subtitle="Today is highlighted" icon={<ClipboardList className="h-4 w-4" />} />
            {!d ? <Skeleton className="mx-5 mb-4 h-[150px]" /> : <AttendanceBars data={d.attendance} today={d.today} />}
          </Card>

        </div>
        <div className="space-y-6">
          {has('bookings') && <TodaysAppointments base={base} />}
          {!d ? <Card className="p-5"><Skeleton className="h-20" /></Card> : (
            <>
              <PaymentsSummary d={d} state={state} range={range} base={base} has={has} />
              <Card className="fhq-rise" style={delay(9)}>
                <CardHeader title="Dues to collect" subtitle="Largest balances first" icon={<Wallet className="h-4 w-4" />}
                  action={has('invoices') ? <Link to={`${base}/invoices`} className={cn(link, 'shrink-0')}>Invoices <ArrowRight className="h-3 w-3" /></Link> : undefined} />
                <div className="px-4 pb-3 pt-1 sm:px-5">
                  {d.owing.length ? (
                    <ul className="divide-y divide-line">
                      {d.owing.map((o) => (
                        <li key={o.patientId} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 py-2.5">
                          <Link to={`${base}/patients/${o.patientId}`} className="min-w-0 flex-1 break-words text-[13.5px] font-medium hover:text-blue-bright">{o.name}</Link>
                          <span className={cn('num shrink-0 rounded-md border px-2 py-0.5 text-[12.5px] font-semibold', CHIP.warn)}>{rs(o.outstandingPaise)}</span>
                        </li>
                      ))}
                    </ul>
                  ) : state === 'yes' ? <p className="flex items-center gap-2.5 py-3 text-[13px] text-fg-2"><CheckCircle2 className="h-4 w-4 shrink-0 text-ok" /><span><span className="font-medium text-fg">All settled</span> · no patient owes a balance</span></p>
                    : <EmptyState className="py-6" icon={<Wallet className="h-5 w-5" />} title={state === 'none' ? 'No invoices yet' : 'Not confirmed yet'} body={state === 'none' ? 'Dues appear here once an invoice is raised.' : 'The invoice list could not be checked, so no balance is claimed either way.'} />}
                </div>
              </Card>

            </>
          )}
          <Card className="fhq-rise" style={delay(12)}>
            <CardHeader title="Today's patients" subtitle={d ? `${d.todaysVisits.length} marked in attendance` : ' '} icon={<UserCheck className="h-4 w-4" />}
              action={has('visits') ? <Link to={`${base}/attendance`} className={cn(link, 'shrink-0')}>Attendance <ArrowRight className="h-3 w-3" /></Link> : undefined} />
            <div className="px-4 pb-3 pt-1 sm:px-5">
              {!d ? <Skeleton className="h-32" /> : d.todaysVisits.length ? (
                <ul className="divide-y divide-line">
                  {d.todaysVisits.map((v) => (
                    <li key={v.patientId} className="flex items-center justify-between gap-3 py-2.5">
                      <Link to={`${base}/patients/${v.patientId}`} className="min-w-0 flex-1 break-words text-[13.5px] font-medium hover:text-blue-bright">{v.name}</Link>
                      <span className={cn('shrink-0 rounded-md border px-1.5 text-[11.5px] font-medium leading-[20px]', v.status === 'Attended' ? CHIP.ok : CHIP.bad)}>{v.status}</span>
                    </li>
                  ))}
                </ul>
              ) : <p className="flex items-center gap-2.5 py-3 text-[13px] text-fg-2"><UserCheck className="h-4 w-4 shrink-0 text-muted" /><span><span className="font-medium text-fg">No one marked yet</span> · mark attendance as patients arrive</span></p>}
            </div>
          </Card>

        </div>
      </div>

      {d?.byDoctor && d.byDoctor.length > 0 && (
        <Card className="fhq-rise" style={delay(10)}>
          <CardHeader title="By doctor" subtitle={`Dues, collections and prescriptions ${period}`} icon={<Users className="h-4 w-4" />} />
          <div className="px-4 pb-3 pt-1 sm:px-5">
            <ul className="divide-y divide-line sm:hidden">
              {d.byDoctor.map((r) => (
                <li key={r.name} className="py-2.5">
                  <div className="flex items-center gap-2.5 text-[13.5px] font-medium"><Avatar text={r.name.startsWith('Other') ? 'FD' : initials(r.name.replace(/^Dr\.?\s+/i, ''))} size={24} tone={r.name.startsWith('Other') ? 'neutral' : 'blue'} /><span className="min-w-0 break-words">{r.name}</span></div>
                  <dl className="mt-1.5 grid grid-cols-3 gap-2 pl-[34px] text-[12px]">
                    <div><dt className="text-muted">Dues</dt><dd className={cn('num font-medium', r.outstandingPaise > 0 && TEXT.warn)}>{rs(r.outstandingPaise)}</dd></div>
                    <div><dt className="text-muted">Collected</dt><dd className="num font-medium">{rs(r.collectedPaise)}</dd></div>
                    <div><dt className="text-muted">Prescriptions</dt><dd className="num font-medium">{r.prescriptions}</dd></div>
                  </dl>
                </li>
              ))}
              <li className="py-2.5 text-[12.5px] font-semibold">All doctors: {rs(d.byDoctor.reduce((t, r) => t + r.outstandingPaise, 0))} due · {rs(d.byDoctor.reduce((t, r) => t + r.collectedPaise, 0))} collected · {d.byDoctor.reduce((t, r) => t + r.prescriptions, 0)} prescriptions</li>
            </ul>
            <div className="hidden overflow-x-auto sm:block">
              <table className="w-full text-[13px]">
                <thead><tr className="text-left text-[12.5px] text-muted"><th className="py-2 pr-3 font-medium">Doctor</th><th className="px-3 py-2 text-right font-medium">Dues</th><th className="px-3 py-2 text-right font-medium">Collected</th><th className="py-2 pl-3 text-right font-medium">Prescriptions</th></tr></thead>
                <tbody className="divide-y divide-line">
                  {d.byDoctor.map((r) => (
                    <tr key={r.name}>
                      <td className="py-2.5 pr-3 font-medium"><span className="inline-flex items-center gap-2.5"><Avatar text={r.name.startsWith('Other') ? 'FD' : initials(r.name.replace(/^Dr\.?\s+/i, ''))} size={24} tone={r.name.startsWith('Other') ? 'neutral' : 'blue'} />{r.name}</span></td>
                      <td className={cn('num px-3 py-2.5 text-right', r.outstandingPaise > 0 && TEXT.warn)}>{rs(r.outstandingPaise)}</td>
                      <td className="num px-3 py-2.5 text-right">{rs(r.collectedPaise)}</td>
                      <td className="num py-2.5 pl-3 text-right">{r.prescriptions}</td>
                    </tr>
                  ))}
                  <tr className="font-semibold"><td className="py-2.5 pr-3">All doctors</td><td className="num px-3 py-2.5 text-right">{rs(d.byDoctor.reduce((t, r) => t + r.outstandingPaise, 0))}</td><td className="num px-3 py-2.5 text-right">{rs(d.byDoctor.reduce((t, r) => t + r.collectedPaise, 0))}</td><td className="num py-2.5 pl-3 text-right">{d.byDoctor.reduce((t, r) => t + r.prescriptions, 0)}</td></tr>
                </tbody>
              </table>
            </div>
          </div>
        </Card>
      )}
    </div>
  );
}
