// Enquiry conversion at a glance: new, awaiting a first reply, converted, conversion rate for the selected range.
// New and the rate are the dashboard's own `new_contacts` / `conversion` metrics; converted and awaiting come from `enquiries`.
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, Target } from 'lucide-react';
import type { Dashboard, Task } from '@core/domain';
import { api, ws as wsPath } from '../../lib/api';
import { useWs } from '../../lib/workspace';
import { number, percent } from '../../lib/format';
import { cn } from '../../lib/cn';
import { Card, CardHeader } from '../ui/primitives';
import { Skeleton } from '../ui/feedback';

const RANGE = { '1': 'today', '7': 'in the last 7 days', '30': 'in the last 30 days' } as Record<string, string>;

export function EnquiryOverview({ d, days }: { d: Dashboard | undefined; days: string }) {
  const { ws, f, tt, has } = useWs();
  const base = `/w/${ws.id}`;
  const metric = (k: string) => d?.metrics.find((m) => m.key === k);
  const total = metric('new_contacts')?.value ?? 0;
  const awaiting = d?.enquiries.awaitingReply ?? 0;
  // Overdue replies = the open "waiting for a first reply" tasks (an enquiry nobody has answered 30 minutes after it arrived), from the same list the Tasks page shows.
  const tasks = useQuery({ queryKey: ['tasks', ws.id], queryFn: () => api<Task[]>(wsPath(ws.id, '/tasks')), enabled: has('tasks'), staleTime: 30000, refetchInterval: 60000 });
  const overdue = tasks.data ? tasks.data.filter((x) => x.kind === 'first_response').length : null;
  const overdueValue = !has('tasks') ? null : tasks.isError ? 'Not available' : overdue === null ? '…' : number(f, overdue);
  const tiles = d ? [
    { key: 'new', label: 'New', value: number(f, total), to: `${base}/contacts`, tone: '' },
    // awaiting-reply work is listed on Tasks; Contacts has no status link, so fall back to it when Tasks is off
    { key: 'awaiting', label: 'Awaiting reply', value: number(f, awaiting), to: has('tasks') ? `${base}/tasks` : `${base}/contacts`, tone: awaiting > 0 ? 'text-warn' : '' },
    ...(overdueValue === null ? [] : [{ key: 'overdue', label: 'Waiting 30+ min', value: overdueValue, to: `${base}/tasks`, tone: overdue ? 'text-bad' : '', hint: 'Enquiries still waiting for a first reply 30 minutes or more after they arrived (last 7 days)' }]),
    { key: 'converted', label: 'Converted', value: number(f, d.enquiries.converted), to: `${base}/contacts`, tone: d.enquiries.converted > 0 ? 'text-ok' : '' },
    { key: 'rate', label: 'Conversion rate', value: percent(f, metric('conversion')?.value), to: `${base}/contacts`, tone: '' },
  ] : [];
  return (
    <Card>
      <CardHeader title={tt('{contact.singular} enquiries')} subtitle={`Created ${RANGE[days] || 'in this period'}`} icon={<Target className="h-4 w-4" />}
        action={<Link to={`${base}/contacts`} className="inline-flex items-center gap-1 text-xs text-blue-soft hover:text-blue-bright">{tt('All {contact.plural|lower}')} <ArrowRight className="h-3 w-3" /></Link>} />
      <div className="px-4 pb-4 pt-3 sm:px-5">
        {!d ? (
          <div className="grid grid-cols-2 gap-3 md:grid-cols-5">{Array.from({ length: 5 }, (_, i) => <div key={i}><Skeleton className="h-3 w-20" /><Skeleton className="mt-3 h-7 w-12" /></div>)}</div>
        ) : total === 0 ? (
          <div className="py-3 text-[13px] text-muted">
            <p>No new enquiries {RANGE[days] || 'in this period'}.</p>
            {overdue ? <p className="mt-1.5"><Link to={`${base}/tasks`} className="font-medium text-bad hover:underline">{overdue} earlier {overdue === 1 ? 'enquiry is' : 'enquiries are'} still waiting for a first reply</Link></p> : null}
          </div>
        ) : (
          <ul className="grid grid-cols-2 gap-x-4 gap-y-3 md:grid-cols-5">
            {tiles.map((t) => (
              <li key={t.key}>
                <Link to={t.to} title={'hint' in t ? t.hint : undefined} className="block rounded-lg px-2 py-1.5 -mx-2 transition-colors hover:bg-surface-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-bright">
                  <span className="text-[12.5px] font-medium text-fg-2">{t.label}</span>
                  <span className={cn('num mt-1.5 block font-semibold leading-none text-fg', t.value === 'Not available' ? 'text-[13px] text-muted' : 'text-[24px]', t.tone)}>{t.value}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}
