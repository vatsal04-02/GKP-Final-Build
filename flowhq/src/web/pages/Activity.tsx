// The activity timeline: one stream of what happened, from every automation and every person, grouped by day.
import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Activity as ActivityIcon, X } from 'lucide-react';
import type { Activity, ActivityKind } from '@core/domain';
import { ACTIVITY } from '@core/registry';
import { api, ws as wsPath } from '../lib/api';
import { useWs } from '../lib/workspace';
import { dayKey, weekday } from '../lib/format';
import { Page } from '../components/layout/Shell';
import { Button, Card, Segmented, Select } from '../components/ui/primitives';
import { EmptyState, ErrorState, SkeletonRows } from '../components/ui/feedback';
import { ActivityRow } from '../components/data/widgets';

const GROUPS: Record<string, { label: string; kinds: ActivityKind[] | null }> = {
  all: { label: 'Everything', kinds: null },
  people: { label: '{contact.plural}', kinds: ['contact_created', 'message_received', 'contact_escalated'] },
  ai: { label: '{ai.short}', kinds: ['ai_replied', 'ai_handoff'] },
  bookings: { label: '{booking.plural}', kinds: ['booking_created', 'booking_rescheduled', 'booking_cancelled'] },
  messages: { label: 'Automated messages', kinds: ['reminder_sent', 'follow_up_sent', 'outcome_checkin_sent', 'review_requested', 'message_sent', 'staff_replied', 'report_generated'] },
  problems: { label: 'Problems', kinds: ['automation_failed', 'automation_skipped'] },
};

export default function ActivityPage() {
  const { ws, tt, f, has } = useWs();
  const [params, setParams] = useSearchParams();
  const contact = params.get('contact') || '';
  const [group, setGroup] = useState<keyof typeof GROUPS>('all');
  const [kind, setKind] = useState<ActivityKind | ''>('');
  const q = useQuery({ queryKey: ['activity', ws.id, kind, contact], queryFn: () => api<Activity[]>(wsPath(ws.id, `/activity?limit=300${kind ? `&kind=${kind}` : ''}${contact ? `&contact=${encodeURIComponent(contact)}` : ''}`)), refetchInterval: 20000 });
  const visibleGroups = Object.entries(GROUPS).filter(([k]) => (k !== 'ai' || has('ai')) && (k !== 'bookings' || has('bookings')));
  const days = useMemo(() => {
    const allowed = GROUPS[group].kinds;
    const out: Array<{ key: string; label: string; items: Activity[] }> = [];
    for (const a of q.data || []) {
      if (allowed && !allowed.includes(a.kind)) continue;
      const k = dayKey(f, a.at);
      let d = out.find((x) => x.key === k);
      if (!d) { d = { key: k, label: weekday(f, a.at), items: [] }; out.push(d); }
      d.items.push(a);
    }
    return out;
  }, [q.data, group, f]);
  const contactName = contact ? q.data?.find((a) => a.contactId === contact)?.contactName : null;
  return (
    <Page title="Activity" subtitle={tt('Everything your automations, your {ai.name} and your team did.')}>
      <div className="mb-4 flex flex-wrap items-center gap-2.5">
        <Segmented value={group} onChange={(g) => { setGroup(g); setKind(''); }} options={visibleGroups.map(([k, g]) => ({ value: k, label: tt(g.label) }))} />
        <Select value={kind} onChange={(e) => setKind(e.target.value as ActivityKind | '')} className="w-56" aria-label="Kind of activity">
          <option value="">Any kind</option>
          {(GROUPS[group].kinds || (Object.keys(ACTIVITY) as ActivityKind[])).map((k) => <option key={k} value={k}>{tt(ACTIVITY[k].label)}</option>)}
        </Select>
        {contact && <Button size="sm" variant="subtle" icon={<X className="h-3.5 w-3.5" />} onClick={() => { params.delete('contact'); setParams(params); }}>{contactName || tt('One {contact.singular|lower}')}</Button>}
      </div>
      <Card>
        {q.error ? <ErrorState error={q.error} retry={() => q.refetch()} /> : q.isLoading ? <SkeletonRows rows={10} /> : !days.length ? (
          <EmptyState icon={<ActivityIcon className="h-5 w-5" />} title="Nothing here yet" body="Activity appears as soon as messages arrive and automations run." />
        ) : (
          <ol className="px-5 pb-2">
            {days.map((d) => (
              <li key={d.key}>
                <h2 className="sticky top-0 z-[1] -mx-5 border-b border-line bg-surface/95 px-5 py-2 text-[12px] font-semibold uppercase tracking-wide text-muted backdrop-blur">{d.label}</h2>
                <div className="divide-y divide-line/50">{d.items.map((a) => <ActivityRow key={a.id} a={a} />)}</div>
              </li>
            ))}
          </ol>
        )}
      </Card>
    </Page>
  );
}
