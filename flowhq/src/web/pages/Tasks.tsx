// Tasks: everything a person owes right now, derived from live data (replies, outcomes, follow-ups). Nothing to file away by
// hand: a task disappears when the thing it points to is done.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, CheckCircle2, ListChecks } from 'lucide-react';
import type { Booking, BookingStatus, Task, TaskKind } from '@core/domain';
import { TASKS } from '@core/registry';
import { api, ws as wsPath } from '../lib/api';
import { useWs } from '../lib/workspace';
import { Page } from '../components/layout/Shell';
import { Button, Card, Segmented } from '../components/ui/primitives';
import { EmptyState, ErrorState, SkeletonRows, useToast } from '../components/ui/feedback';
import { TaskRow } from '../components/data/widgets';

const ORDER: TaskKind[] = ['reply_needed', 'reply_failed', 'first_response', 'next_action_due', 'booking_outcome'];

export default function Tasks() {
  const { ws, tt } = useWs();
  const [kind, setKind] = useState<'all' | TaskKind>('all');
  const q = useQuery({ queryKey: ['tasks', ws.id], queryFn: () => api<Task[]>(wsPath(ws.id, '/tasks')), refetchInterval: 20000 });
  const all = q.data || [];
  const kinds = ORDER.filter((k) => all.some((x) => x.kind === k));
  const groups = (kind === 'all' ? kinds : [kind]).map((k) => ({ kind: k, items: all.filter((x) => x.kind === k) })).filter((g) => g.items.length);
  const urgent = all.filter((x) => x.priority === 'urgent').length;
  return (
    <Page title="Tasks" subtitle={q.data ? `${all.length} open${urgent ? ` · ${urgent} urgent` : ''}` : ' '}>
      {kinds.length > 1 && (
        <div className="mb-4"><Segmented value={kind} onChange={setKind} options={[{ value: 'all', label: 'All', count: all.length }, ...kinds.map((k) => ({ value: k, label: tt(TASKS[k].label), count: all.filter((x) => x.kind === k).length }))]} /></div>
      )}
      {q.error ? <Card><ErrorState error={q.error} retry={() => q.refetch()} /></Card> : q.isLoading ? <Card><SkeletonRows rows={8} /></Card> : !groups.length ? (
        <Card><EmptyState icon={<CheckCircle2 className="h-5 w-5" />} title="You are all caught up" body={tt('Replies a person owes, {booking.plural|lower} to mark and due follow-ups appear here as they come up.')} /></Card>
      ) : (
        <div className="space-y-4">
          {groups.map((g) => (
            <Card key={g.kind}>
              <div className="flex items-center justify-between px-5 pt-4">
                <h2 className="text-sm font-semibold">{tt(TASKS[g.kind].label)} <span className="num ml-1 text-muted">{g.items.length}</span></h2>
                <span className="text-[12px] text-muted">{tt(TASKS[g.kind].action)}</span>
              </div>
              <div className="px-3 pb-3 pt-2">{g.items.map((t) => <TaskRow key={t.id} task={t} action={<TaskAction task={t} />} />)}</div>
            </Card>
          ))}
        </div>
      )}
      {!q.isLoading && !q.error && all.length === 0 && <p className="mt-4 flex items-center justify-center gap-1.5 text-[12px] text-muted"><ListChecks className="h-3.5 w-3.5" />Tasks refresh automatically.</p>}
    </Page>
  );
}

function TaskAction({ task }: { task: Task }) {
  const { ws, t } = useWs();
  const caps = ws.backend.capabilities;
  const qc = useQueryClient();
  const toast = useToast();
  const mark = useMutation({
    mutationFn: (status: BookingStatus) => api<Booking>(wsPath(ws.id, `/bookings/${task.bookingId}`), { method: 'PATCH', body: { status } }),
    onSuccess: (r) => { toast('ok', `${task.contactName || t('booking.singular')}: ${t(`bookingStatus.${r.status}`).toLowerCase()}`); qc.invalidateQueries({ queryKey: ['tasks', ws.id] }); qc.invalidateQueries({ queryKey: ['bookings', ws.id] }); qc.invalidateQueries({ queryKey: ['dashboard', ws.id] }); },
    onError: (e: Error) => toast('bad', e.message),
  });
  if (task.kind === 'booking_outcome' && task.bookingId && caps.bookingStatusUpdate.length) {
    return (
      <div className="flex shrink-0 gap-1.5">
        {caps.bookingStatusUpdate.includes('completed') && <Button size="sm" variant="subtle" loading={mark.isPending && mark.variables === 'completed'} disabled={mark.isPending} onClick={() => mark.mutate('completed')}>{t('bookingStatus.completed')}</Button>}
        {caps.bookingStatusUpdate.includes('no_show') && <Button size="sm" variant="ghost" loading={mark.isPending && mark.variables === 'no_show'} disabled={mark.isPending} onClick={() => mark.mutate('no_show')}>{t('bookingStatus.no_show')}</Button>}
      </div>
    );
  }
  const to = task.conversationId && (task.kind === 'reply_needed' || task.kind === 'reply_failed' || task.kind === 'first_response') ? `/w/${ws.id}/inbox/${task.conversationId}` : task.contactId ? `/w/${ws.id}/contacts/${task.contactId}` : null;
  return to ? <Link to={to} className="inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-[12px] text-blue-soft hover:bg-blue/10 hover:text-blue-bright">Open <ArrowRight className="h-3 w-3" /></Link> : null;
}
