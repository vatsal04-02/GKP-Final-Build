// Reusable data widgets: metric cards, priority / AI badges, confidence, activity timeline rows, task rows.
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ArrowDownRight, ArrowUpRight, Sparkles } from 'lucide-react';
import type { Activity, ContactStage, MetricKey, MetricValue, Priority, Task } from '@core/domain';
import { ACTIVITY, METRICS, TASKS } from '@core/registry';
import { useWs } from '../../lib/workspace';
import { icon } from '../../lib/icons';
import { money, number, percent, relative, time } from '../../lib/format';
import { cn } from '../../lib/cn';
import { AnimatedNumber, Badge, Card, Progress, StatusDot, type Tone } from '../ui/primitives';
import { Sparkline } from './charts';

const METRIC_ICON: Partial<Record<MetricKey, string>> = { new_contacts: 'user-plus', active_conversations: 'message-circle', bookings: 'calendar', completed: 'calendar-clock', pending_actions: 'alert-triangle', ai_handled: 'sparkles', human_handoffs: 'hand', conversion: 'target', revenue: 'credit-card', follow_ups: 'repeat', reviews: 'star', reminders: 'bell', no_shows: 'calendar-x' };
export function MetricCard({ m, spark, emphasis }: { m: MetricValue; spark?: number[]; emphasis?: boolean }) {
  const { metric, f } = useWs();
  const def = METRICS[m.key];
  const label = metric(m.key);
  const Icon = icon(METRIC_ICON[m.key] || 'activity');
  const show = (v: number) => (m.unit === 'percent' ? percent(f, v) : m.unit === 'currency' ? money(f, v) : number(f, v));
  const delta = m.value !== null && m.previous !== null && m.previous !== undefined ? m.value - m.previous : null;
  const better = delta === null || delta === 0 || def.good === 'neutral' ? null : (delta > 0) === (def.good === 'up');
  return (
    <Card hover className={cn('group relative overflow-hidden p-4', emphasis && 'border-blue/25')}>
      {emphasis && <div className="pointer-events-none absolute -right-10 -top-10 h-28 w-28 rounded-full bg-blue/20 blur-2xl" />}
      <div className="flex items-start justify-between gap-2">
        <span className="text-[12.5px] font-medium text-fg-2" title={label.hint}>{label.label}</span>
        <span className={cn('flex h-7 w-7 items-center justify-center rounded-lg border transition-colors', emphasis || m.key === 'ai_handled' ? 'border-blue/30 bg-blue/10 text-blue-bright' : 'border-line bg-surface-2 text-muted group-hover:text-blue-soft')}><Icon className="h-3.5 w-3.5" /></span>
      </div>
      <div className="mt-2.5 flex items-end justify-between gap-2">
        <div className="num text-[28px] font-semibold leading-none text-fg">{m.value === null ? '—' : <AnimatedNumber value={m.value} format={show} />}</div>
        {spark && <Sparkline values={spark} className="mb-0.5 opacity-80" />}
      </div>
      <div className="mt-2 flex h-4 items-center gap-1.5 overflow-hidden whitespace-nowrap text-[11.5px] text-muted">
        {delta !== null && delta !== 0 ? (
          <span className={cn('inline-flex items-center gap-0.5 font-medium', better === null ? 'text-fg-2' : better ? 'text-ok' : 'text-bad')}>
            {delta > 0 ? <ArrowUpRight className="h-3 w-3" /> : <ArrowDownRight className="h-3 w-3" />}{m.unit === 'percent' ? `${Math.abs(delta).toFixed(1)} pts` : show(Math.abs(delta))}
          </span>
        ) : m.previous !== null && m.previous !== undefined ? <span>no change</span> : null}
        {m.previous !== null && m.previous !== undefined && <span className="hidden truncate sm:inline">vs previous period</span>}
      </div>
    </Card>
  );
}

export const PRIORITY_TONE: Record<Priority, Tone> = { urgent: 'red', high: 'amber', normal: 'neutral' };
export function PriorityBadge({ p }: { p: Priority | null }) {
  if (!p) return null;
  return <Badge tone={PRIORITY_TONE[p]}>{p === 'urgent' ? 'Urgent' : p === 'high' ? 'High' : 'Normal'}</Badge>;
}
export function AttentionBadge({ priority }: { priority: Priority | null }) {
  return <Badge tone={priority === 'urgent' ? 'red' : 'amber'} icon={<StatusDot tone={priority === 'urgent' ? 'red' : 'amber'} className="h-1.5 w-1.5" />}>{priority === 'urgent' ? 'Urgent' : 'Needs a person'}</Badge>;
}
export function AiBadge({ label }: { label?: string }) {
  const { t } = useWs();
  return <Badge tone="blue" icon={<Sparkles className="h-3 w-3" />}>{label || t('ai.short')}</Badge>;
}
export function StageDot({ stage }: { stage: ContactStage | null }) {
  const { t } = useWs();
  if (!stage) return <span className="text-[12.5px] text-muted">—</span>;
  const tone = stage === 'hot' ? 'bg-blue-bright shadow-[0_0_8px_rgb(var(--blue-bright))]' : stage === 'warm' ? 'bg-blue-soft/70' : 'bg-muted';
  return <span className="inline-flex items-center gap-1.5 text-[12.5px] text-fg-2"><span className={cn('h-2 w-2 rounded-full', tone)} />{t(`contactStage.${stage}`)}</span>;
}
export function Confidence({ value }: { value: number | null }) {
  if (value === null) return <span className="text-xs text-muted">—</span>;
  return <div className="flex items-center gap-2"><Progress value={value * 100} className="w-16" /><span className="num text-xs text-fg-2">{Math.round(value * 100)}%</span></div>;
}

export function ActivityRow({ a, compact }: { a: Activity; compact?: boolean }) {
  const { tt, ws, f, automation } = useWs();
  const def = ACTIVITY[a.kind];
  const Icon = icon(def.icon);
  const tone = { blue: 'border-blue/30 bg-blue/10 text-blue-bright', neutral: 'border-line bg-surface-2 text-fg-2', amber: 'border-warn/30 bg-warn/10 text-warn', red: 'border-bad/30 bg-bad/10 text-bad', green: 'border-ok/30 bg-ok/10 text-ok' }[def.tone];
  return (
    <div className="group flex gap-3 py-2.5">
      <span className={cn('mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border', tone)}><Icon className="h-3.5 w-3.5" /></span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-3">
          <p className="truncate text-[13px] text-fg">
            <span className="font-medium">{tt(def.label)}</span>
            {a.contactName && <> · {a.contactId ? <Link className="text-fg-2 hover:text-blue-soft" to={`/w/${ws.id}/contacts/${a.contactId}`}>{a.contactName}</Link> : <span className="text-fg-2">{a.contactName}</span>}</>}
          </p>
          <time className="shrink-0 text-[11.5px] text-muted" title={a.at}>{compact ? relative(a.at) : time(f, a.at)}</time>
        </div>
        {!compact && a.detail && <p className={cn('mt-0.5 line-clamp-2 text-[12.5px]', a.outcome === 'failed' ? 'text-bad/90' : 'text-fg-2')}>{a.detail}</p>}
        {!compact && a.automationKey && <p className="mt-0.5 text-[11.5px] text-muted">{automation(a.automationKey).name}</p>}
      </div>
    </div>
  );
}

export function TaskRow({ task, action }: { task: Task; action?: ReactNode }) {
  const { tt, ws } = useWs();
  const def = TASKS[task.kind];
  const to = task.conversationId && (task.kind === 'reply_needed' || task.kind === 'reply_failed') ? `/w/${ws.id}/inbox/${task.conversationId}` : task.contactId ? `/w/${ws.id}/contacts/${task.contactId}` : task.bookingId ? `/w/${ws.id}/bookings` : `/w/${ws.id}`;
  return (
    <div className="flex items-center gap-3 rounded-lg px-2 py-2.5 transition-colors hover:bg-surface-2">
      <StatusDot tone={task.priority === 'urgent' ? 'red' : task.priority === 'high' ? 'amber' : 'blue'} pulse={task.priority === 'urgent'} />
      <Link to={to} className="min-w-0 flex-1">
        <p className="truncate text-[13px]"><span className="font-medium text-fg">{tt(def.label)}</span>{task.contactName && <span className="text-fg-2"> · {task.contactName}</span>}</p>
        {task.detail && <p className="truncate text-[12px] text-muted">{tt(task.detail)}</p>}
      </Link>
      {action || <span className="shrink-0 text-[11.5px] text-muted">{relative(task.dueAt)}</span>}
    </div>
  );
}
