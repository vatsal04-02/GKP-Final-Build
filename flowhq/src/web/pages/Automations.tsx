// Automations as business outcomes, not workflow numbers. Every number comes from the backend's own run log; the switches
// write the backend's own per-workspace settings. The implementation id is shown small, for support only.
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CalendarClock, CheckCircle2, Circle, Clock, Repeat, Sparkles, Star, UserPlus, Workflow, XCircle, Zap, BarChart3, ShieldAlert, MessageCircle, Reply, Bell, HeartPulse, type LucideIcon } from 'lucide-react';
import type { Automation, AutomationKey } from '@core/domain';
import { AUTOMATIONS } from '@core/registry';
import { api, ws as wsPath } from '../lib/api';
import { useWs } from '../lib/workspace';
import { dateTime, number, percent, relative } from '../lib/format';
import { cn } from '../lib/cn';
import { Page } from '../components/layout/Shell';
import { Badge, Card, Segmented, StatusDot, Switch, type Tone } from '../components/ui/primitives';
import { EmptyState, ErrorState, Skeleton, useToast } from '../components/ui/feedback';

const CATEGORY_ICON: Record<string, LucideIcon> = { capture: UserPlus, engage: Zap, bookings: CalendarClock, retention: Repeat, ai: Sparkles, insight: BarChart3, system: ShieldAlert };
const KEY_ICON: Partial<Record<AutomationKey, LucideIcon>> = { review_requests: Star, inbound_messaging: MessageCircle, staff_reply: Reply, booking_reminders: Bell, outcome_checkins: HeartPulse };
const STATUS: Record<Automation['status'], { label: string; tone: Tone; pulse?: boolean }> = {
  active: { label: 'Active', tone: 'blue', pulse: true },
  always_on: { label: 'Always on', tone: 'blue' },
  off: { label: 'Off', tone: 'neutral' },
  needs_setup: { label: 'Needs setup', tone: 'amber' },
  attention: { label: 'Last run failed', tone: 'red' },
};
type Filter = 'all' | 'running' | 'off' | 'attention';

export default function Automations() {
  const { ws, tt } = useWs();
  const [filter, setFilter] = useState<Filter>('all');
  const q = useQuery({ queryKey: ['automations', ws.id], queryFn: () => api<Automation[]>(wsPath(ws.id, '/automations')), refetchInterval: 30000 });
  const all = q.data || [];
  const running = all.filter((a) => a.status === 'active' || a.status === 'always_on');
  const attention = all.filter((a) => a.status === 'attention' || a.status === 'needs_setup');
  const shown = filter === 'running' ? running : filter === 'off' ? all.filter((a) => a.status === 'off') : filter === 'attention' ? attention : all;
  const ok = all.reduce((s, a) => s + a.stats.ok7d, 0);
  const failed = all.reduce((s, a) => s + a.stats.failed7d, 0);
  return (
    <Page title="Automations" subtitle={tt('What runs for your {workspace.singular|lower} while nobody is watching.')}>
      <section aria-label="Summary" className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Summary label="Running" value={q.data ? `${running.length} of ${all.length}` : null} />
        <Summary label="Actions today" value={q.data ? number({ locale: ws.locale, timezone: ws.timezone, currency: null }, all.reduce((s, a) => s + a.stats.today, 0)) : null} />
        <Summary label="Success rate, 7 days" value={q.data ? (ok + failed ? percent({ locale: ws.locale, timezone: ws.timezone, currency: null }, Math.round((ok / (ok + failed)) * 1000) / 10) : '—') : null} />
        <Summary label="Errors, 7 days" value={q.data ? String(failed) : null} tone={failed ? 'red' : undefined} />
      </section>
      <div className="mb-4">
        <Segmented value={filter} onChange={setFilter} options={[{ value: 'all', label: 'All', count: all.length }, { value: 'running', label: 'Running', count: running.length }, { value: 'off', label: 'Off', count: all.filter((a) => a.status === 'off').length }, { value: 'attention', label: 'Needs attention', count: attention.length }]} />
      </div>
      {q.error ? <Card><ErrorState error={q.error} retry={() => q.refetch()} /></Card> : !q.data ? (
        <div className="grid gap-4 md:grid-cols-2 2xl:grid-cols-3">{Array.from({ length: 6 }, (_, i) => <Card key={i} className="space-y-3 p-5"><Skeleton className="h-4 w-40" /><Skeleton className="h-3 w-full" /><Skeleton className="h-3 w-2/3" /><Skeleton className="mt-4 h-10 w-full" /></Card>)}</div>
      ) : !shown.length ? (
        <Card><EmptyState icon={<Workflow className="h-5 w-5" />} title={filter === 'attention' ? 'Nothing needs attention' : 'No automations here'} body={filter === 'all' ? 'This workspace has no automations enabled.' : undefined} /></Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 2xl:grid-cols-3">{shown.map((a) => <AutomationCard key={a.key} a={a} />)}</div>
      )}
    </Page>
  );
}

function Summary({ label, value, tone }: { label: string; value: string | null; tone?: 'red' }) {
  return (
    <Card className="px-4 py-3.5">
      <div className="text-[12px] text-fg-2">{label}</div>
      {value === null ? <Skeleton className="mt-2 h-6 w-16" /> : <div className={cn('num mt-1 text-[22px] font-semibold', tone === 'red' ? 'text-bad' : 'text-fg')}>{value}</div>}
    </Card>
  );
}

function AutomationCard({ a }: { a: Automation }) {
  const { ws, tt, f, automation, isAdmin } = useWs();
  const qc = useQueryClient();
  const toast = useToast();
  const { name, description } = automation(a.key);
  const Icon = KEY_ICON[a.key] || CATEGORY_ICON[AUTOMATIONS[a.key].category] || Workflow;
  const st = STATUS[a.status];
  const set = useMutation({
    mutationFn: (value: string) => api<Automation>(wsPath(ws.id, `/automations/${a.key}`), { method: 'PATCH', body: { value } }),
    onSuccess: (r) => {
      qc.setQueryData<Automation[]>(['automations', ws.id], (old) => old?.map((x) => (x.key === r.key ? r : x)));
      qc.invalidateQueries({ queryKey: ['ai', ws.id] }); qc.invalidateQueries({ queryKey: ['settings', ws.id] }); qc.invalidateQueries({ queryKey: ['conversations', ws.id] });
      toast('ok', `${name} updated`);
    },
    onError: (e: Error) => toast('bad', e.message),
  });
  const ctl = a.control;
  const isAi = AUTOMATIONS[a.key].category === 'ai';
  return (
    <Card hover className={cn('flex flex-col p-5', isAi && a.status === 'active' && 'ai-tint border-blue/25')}>
      <div className="flex items-start gap-3">
        <span className={cn('flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border', a.status === 'off' ? 'border-line bg-surface-2 text-muted' : 'border-blue/30 bg-blue/10 text-blue-bright')}><Icon className="h-[18px] w-[18px]" /></span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <h3 className="truncate text-[14.5px] font-semibold">{name}</h3>
            {ctl?.kind === 'toggle' && !ctl.label && <Switch checked={ctl.value === 'on'} onChange={(v) => set.mutate(v ? 'on' : 'off')} disabled={!isAdmin || set.isPending} label={`${name}: ${ctl.value === 'on' ? 'on' : 'off'}`} />}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <Badge tone={st.tone} icon={<StatusDot tone={st.tone} pulse={st.pulse} className="h-1.5 w-1.5" />}>{st.label}</Badge>
            <span className="inline-flex items-center gap-1 text-[11.5px] text-muted">{a.trigger.kind === 'schedule' ? <Clock className="h-3 w-3" /> : <Zap className="h-3 w-3" />}{tt(a.trigger.label)}</span>
          </div>
        </div>
      </div>
      <p className="mt-3 text-[13px] leading-relaxed text-fg-2">{description}</p>

      {ctl?.kind === 'choice' && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {ctl.label && <span className="text-[12px] text-fg-2">{tt(ctl.label)}</span>}
          <Segmented size="sm" value={ctl.value} onChange={(v) => isAdmin && v !== ctl.value && set.mutate(v)} options={ctl.options.map((o) => ({ value: o.value, label: o.label }))} />
          {!isAdmin && <span className="text-[11.5px] text-muted">Only an admin can change this</span>}
        </div>
      )}
      {ctl?.kind === 'toggle' && ctl.label && (
        <div className="mt-3 flex items-center justify-between gap-3 rounded-lg border border-line bg-bg-2 px-3 py-2">
          <span className="text-[12.5px] text-fg-2">{tt(ctl.label)}</span>
          <Switch checked={ctl.value === 'on'} onChange={(v) => set.mutate(v ? 'on' : 'off')} disabled={!isAdmin || set.isPending} label={tt(ctl.label)} />
        </div>
      )}

      <dl className="mt-4 grid grid-cols-3 gap-px overflow-hidden rounded-lg border border-line bg-line text-center">
        <Stat k="Today" v={number(f, a.stats.today)} hint={a.measures ? tt(`Counts ${a.measures}`) : undefined} />
        <Stat k="Success, 7d" v={a.stats.successRate === null ? '—' : percent(f, a.stats.successRate)} />
        <Stat k="Errors, 7d" v={number(f, a.stats.failed7d)} bad={a.stats.failed7d > 0} />
      </dl>
      <div className="mt-3 grid grid-cols-2 gap-2 text-[12px]">
        <div><span className="text-muted">Last run </span><span className="text-fg-2" title={a.lastRunAt ? dateTime(f, a.lastRunAt) : undefined}>{a.lastRunAt ? relative(a.lastRunAt) : 'not yet'}</span></div>
        <div className="text-right"><span className="text-muted">Next run </span><span className="text-fg-2" title={a.nextRunAt ? dateTime(f, a.nextRunAt) : undefined}>{a.nextRunAt ? relative(a.nextRunAt) : a.trigger.kind === 'event' ? 'on demand' : '—'}</span></div>
      </div>

      {a.requirements.length > 0 && (
        <ul className="mt-3 space-y-1">
          {a.requirements.map((r) => (
            <li key={r.label} className="flex items-center gap-2 text-[12px]">
              {r.ok ? <CheckCircle2 className="h-3.5 w-3.5 text-blue-bright" /> : <Circle className="h-3.5 w-3.5 text-warn" />}
              <span className={r.ok ? 'text-fg-2' : 'text-warn'}>{tt(r.label)}</span>
            </li>
          ))}
        </ul>
      )}
      {a.lastError && (
        <div className="mt-3 flex items-start gap-2 rounded-lg border border-bad/25 bg-bad/[0.07] px-3 py-2 text-[12px] text-fg-2">
          {a.status === 'attention' ? <XCircle className="mt-px h-3.5 w-3.5 shrink-0 text-bad" /> : <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0 text-warn" />}
          <span className="line-clamp-3 break-words"><span className="font-medium text-fg">Last error: </span>{a.lastError}</span>
        </div>
      )}
      <div className="mt-auto flex items-center justify-between pt-4 text-[11px] text-muted">
        <span>{a.stats.skipped7d ? `${a.stats.skipped7d} skipped by safety checks, 7d` : ' '}</span>
        <span className="font-mono" title="Implementation reference, for support">{a.backendRef}</span>
      </div>
    </Card>
  );
}

function Stat({ k, v, bad, hint }: { k: string; v: string; bad?: boolean; hint?: string }) {
  return (
    <div className="flex flex-col-reverse bg-surface px-2 py-2.5" title={hint}>
      <dt className="mt-0.5 text-[11px] text-muted">{k}</dt>
      <dd className={cn('num text-[16px] font-semibold', bad ? 'text-bad' : 'text-fg')}>{v}</dd>
    </div>
  );
}
