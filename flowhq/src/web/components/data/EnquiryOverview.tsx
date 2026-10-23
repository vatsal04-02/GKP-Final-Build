// Enquiry conversion at a glance: new, awaiting a first reply, converted, conversion rate for the selected range.
// New and the rate are the dashboard's own `new_contacts` / `conversion` metrics; converted and awaiting come from `enquiries`.
import { Link } from 'react-router-dom';
import { ArrowRight, Target } from 'lucide-react';
import type { Dashboard } from '@core/domain';
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
  const tiles = d ? [
    { key: 'new', label: 'New', value: number(f, total), to: `${base}/contacts`, tone: '' },
    // awaiting-reply work is listed on Tasks; Contacts has no status link, so fall back to it when Tasks is off
    { key: 'awaiting', label: 'Awaiting reply', value: number(f, awaiting), to: has('tasks') ? `${base}/tasks` : `${base}/contacts`, tone: awaiting > 0 ? 'text-warn' : '' },
    { key: 'converted', label: 'Converted', value: number(f, d.enquiries.converted), to: `${base}/contacts`, tone: d.enquiries.converted > 0 ? 'text-ok' : '' },
    { key: 'rate', label: 'Conversion rate', value: percent(f, metric('conversion')?.value), to: `${base}/contacts`, tone: '' },
  ] : [];
  return (
    <Card>
      <CardHeader title={tt('{contact.singular} enquiries')} subtitle={`Created ${RANGE[days] || 'in this period'}`} icon={<Target className="h-4 w-4" />}
        action={<Link to={`${base}/contacts`} className="inline-flex items-center gap-1 text-xs text-blue-soft hover:text-blue-bright">{tt('All {contact.plural|lower}')} <ArrowRight className="h-3 w-3" /></Link>} />
      <div className="px-5 pb-4 pt-3">
        {!d ? (
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">{Array.from({ length: 4 }, (_, i) => <div key={i}><Skeleton className="h-3 w-20" /><Skeleton className="mt-3 h-7 w-12" /></div>)}</div>
        ) : total === 0 ? (
          <p className="py-3 text-[13px] text-muted">No new enquiries {RANGE[days] || 'in this period'}.</p>
        ) : (
          <ul className="grid grid-cols-2 gap-x-4 gap-y-3 md:grid-cols-4">
            {tiles.map((t) => (
              <li key={t.key}>
                <Link to={t.to} className="block rounded-lg px-2 py-1.5 -mx-2 transition-colors hover:bg-surface-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-bright">
                  <span className="text-[12.5px] font-medium text-fg-2">{t.label}</span>
                  <span className={cn('num mt-1.5 block text-[24px] font-semibold leading-none text-fg', t.tone)}>{t.value}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}
