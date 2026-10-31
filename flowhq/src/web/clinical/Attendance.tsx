// The weekly attendance sheet: patients down the side, Monday to Sunday across, like the notebook's M T W T F S S columns.
// Every mark is a separate dated record, so starting a new week never overwrites an old one.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarCheck, ChevronLeft, ChevronRight, Search } from 'lucide-react';
import type { VisitStatus, VisitWeek } from '@core/clinical';
import { api, ws as wsPath } from '../lib/api';
import { useWs } from '../lib/workspace';
import { cn } from '../lib/cn';
import { Page } from '../components/layout/Shell';
import { Button, Card, Input } from '../components/ui/primitives';
import { EmptyState, ErrorState, SkeletonRows, useToast } from '../components/ui/feedback';
import { errText, fdate, useToday } from './common';

const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const mondayOf = (d: string) => addDays(d, -((new Date(`${d}T00:00:00Z`).getUTCDay() + 6) % 7));
const NEXT: Record<string, VisitStatus | null> = { '': 'Attended', Attended: 'Missed', Missed: 'Cancelled', Cancelled: null };
const LOOK: Record<VisitStatus, { glyph: string; cls: string }> = { Attended: { glyph: '✓', cls: 'bg-ok/10 text-ok' }, Missed: { glyph: '✗', cls: 'bg-bad/10 text-bad' }, Cancelled: { glyph: '–', cls: 'bg-surface-2 text-muted' } };
const NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export default function Attendance() {
  const { ws } = useWs();
  const qc = useQueryClient(); const toast = useToast(); const today = useToday();
  const [week, setWeek] = useState(() => mondayOf(today)); const [q, setQ] = useState(''); const [busy, setBusy] = useState<string | null>(null);
  const key = ['attendance', ws.id, week];
  const data = useQuery({ queryKey: key, queryFn: () => api<VisitWeek>(wsPath(ws.id, `/visits?week=${week}`)), placeholderData: keepPreviousData });
  const set = useMutation({
    mutationFn: (v: { patientId: string; date: string; status: VisitStatus | null }) => api(wsPath(ws.id, '/visits'), { method: 'PUT', body: v }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['attendance', ws.id] }); qc.invalidateQueries({ queryKey: ['register', ws.id] }); },
    onError: (e) => toast('bad', `Not saved: ${errText(e)}`),
    onSettled: () => setBusy(null),
  });
  const rows = (data.data?.rows || []).filter((r) => !q.trim() || r.name.toLowerCase().includes(q.trim().toLowerCase()) || r.patientId.toLowerCase().includes(q.trim().toLowerCase()));
  const count = (d: string) => (data.data?.rows || []).filter((r) => r.cells[d]?.status === 'Attended').length;
  return (
    <Page title="Attendance" subtitle="Click a day to cycle: attended, missed, cancelled, cleared." wide
      actions={<div className="flex items-center gap-1"><Button size="sm" variant="ghost" onClick={() => setWeek(addDays(week, -7))} aria-label="Previous week"><ChevronLeft className="h-4 w-4" /></Button><span className="min-w-[150px] text-center text-sm font-medium">{fdate(week)} – {fdate(addDays(week, 6))}</span><Button size="sm" variant="ghost" onClick={() => setWeek(addDays(week, 7))} aria-label="Next week"><ChevronRight className="h-4 w-4" /></Button><Button size="sm" onClick={() => setWeek(mondayOf(today))}>This week</Button></div>}>
      <div className="mb-3 w-full max-w-xs"><Input icon={<Search className="h-4 w-4" />} placeholder="Search name or patient ID" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search patients" /></div>
      <Card className="overflow-hidden">
        {data.isLoading ? <SkeletonRows rows={8} /> : data.error ? <ErrorState error={data.error} retry={() => data.refetch()} /> : !rows.length ? <EmptyState icon={<CalendarCheck className="h-5 w-5" />} title="No patients to show" body="Active patients appear here automatically." /> : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] border-collapse text-[13px]">
              <thead><tr>
                <th className="border-b border-r border-line/70 bg-sage/40 px-3 py-2 text-left text-[12.5px] font-semibold text-fg-2">Patient</th>
                {data.data!.days.map((d, i) => <th key={d} className={cn('w-[84px] border-b border-r border-line/70 bg-sage/40 px-1 py-2 text-center text-[11.5px] font-semibold text-fg-2 last:border-r-0', d === today && 'text-accent-strong')}>{NAMES[i]}<div className="text-[11.5px] font-normal text-muted">{d.slice(8)}/{d.slice(5, 7)}</div></th>)}
              </tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.patientId}>
                    <td className="border-b border-r border-line/60 px-3 py-1.5"><Link to={`/w/${ws.id}/patients/${r.patientId}`} className="font-medium hover:underline">{r.name}</Link><div className="text-[12px] text-muted">{r.patientId}</div></td>
                    {data.data!.days.map((d) => {
                      const c = r.cells[d]; const future = d > today; const k = `${r.patientId}|${d}`;
                      return (
                        <td key={d} className="border-b border-r border-line/60 p-1 text-center last:border-r-0">
                          <button type="button" disabled={future || busy === k} aria-label={`${r.name}, ${fdate(d)}: ${c?.status || 'not marked'}`} title={c?.notes || undefined}
                            onClick={() => { setBusy(k); set.mutate({ patientId: r.patientId, date: d, status: NEXT[c?.status || ''] ?? null }); }}
                            className={cn('h-9 w-full rounded-lg text-base font-semibold transition-colors', c ? LOOK[c.status].cls : 'text-line-2 hover:bg-sage/40', future && 'cursor-not-allowed opacity-40', busy === k && 'animate-pulse')}>{busy === k ? '…' : c ? LOOK[c.status].glyph : '·'}</button>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
              <tfoot><tr className="bg-sage/30 text-[12px] font-semibold"><td className="px-3 py-2">Attended</td>{data.data!.days.map((d) => <td key={d} className="num px-1 py-2 text-center">{count(d)}</td>)}</tr></tfoot>
            </table>
          </div>
        )}
      </Card>
    </Page>
  );
}
