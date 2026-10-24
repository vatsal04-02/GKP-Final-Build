// Active patients who have not been seen for 10 days or more: the ones who may be dropping out of treatment.
// Computed from the patient register (latest attended visit, else registration date); nothing is stored or invented.
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, CheckCircle2, HeartPulse, Phone } from 'lucide-react';
import type { PatientList } from '@core/clinical';
import { api, ws as wsPath } from '../lib/api';
import { useWs } from '../lib/workspace';
import { cn } from '../lib/cn';
import { Card, CardHeader } from '../components/ui/primitives';
import { ErrorState, SkeletonRows } from '../components/ui/feedback';
import { patientsToReview } from './dashboardLogic';

const MIN_DAYS = 10;

export function PatientsToReview({ base, today, className }: { base: string; today: string | undefined; className?: string }) {
  const { ws } = useWs();
  const q = useQuery({ queryKey: ['review-patients', ws.id], queryFn: () => api<PatientList>(wsPath(ws.id, '/patients?status=Active&sort=serial&dir=asc&page=1&pageSize=200')), staleTime: 60000 });
  const rows = q.data && today ? patientsToReview(q.data.rows, today, MIN_DAYS) : [];
  return (
    <Card className={cn('fhq-rise', className)}>
      <CardHeader title="Patients to review" subtitle={q.data ? (rows.length ? `Not seen for ${MIN_DAYS}+ days · may be dropping out` : `Everyone active was seen in the last ${MIN_DAYS} days`) : ' '} icon={<HeartPulse className="h-4 w-4" />}
        action={<Link to={`${base}/patients`} className="inline-flex shrink-0 items-center gap-1 text-xs text-blue-soft hover:text-blue-bright">Register <ArrowRight className="h-3 w-3" /></Link>} />
      <div className="px-4 pb-3 pt-1 sm:px-5">
        {q.isLoading ? <SkeletonRows rows={3} className="p-0" /> : q.error ? <ErrorState error={q.error} retry={() => q.refetch()} />
          : rows.length ? (
            <ul className="divide-y divide-line">
              {rows.map((r) => (
                <li key={r.patientId} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 py-2.5">
                  <div className="min-w-[10rem] flex-1">
                    <Link to={`${base}/patients/${r.patientId}`} className="block break-words text-[13.5px] font-medium leading-snug hover:text-blue-bright">{r.name}</Link>
                    <p className="mt-0.5 break-words text-[12px] text-fg-2">{r.complaint || 'No complaint recorded'}</p>
                  </div>
                  <span className={cn('num shrink-0 rounded-md border px-2 py-0.5 text-[12px] font-medium', r.days >= 21 ? 'border-bad/25 bg-bad/10 text-bad' : 'border-warn/25 bg-warn/10 text-warn')}>
                    {r.never ? `No visit in ${r.days} days` : `Last seen ${r.days} days ago`}
                  </span>
                  {r.phone && <a href={`tel:${r.phone}`} className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-line bg-surface px-2.5 text-[12.5px] font-medium hover:border-line-2 hover:text-blue-bright" aria-label={`Call ${r.name}`}><Phone className="h-3.5 w-3.5" />Call</a>}
                </li>
              ))}
            </ul>
          ) : <p className="flex items-center gap-2.5 py-3 text-[13px] text-fg-2"><CheckCircle2 className="h-4 w-4 shrink-0 text-ok" /><span><span className="font-medium text-fg">No one is slipping away</span> · active patients are all being seen</span></p>}
      </div>
    </Card>
  );
}
