// Follow-ups to call, most overdue first. Each row: the full name (never cut off), what is due and how late, the complaint, and two actions:
// Call (the phone's dialler) and Reschedule (moves the patient's follow-up date through the existing patient update; nothing else changes).
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ArrowRight, CalendarClock, CalendarCheck, CheckCircle2, X } from 'lucide-react';
import type { DoctorSummary } from '@core/clinical';
import { api, ApiError, ws as wsPath } from '../lib/api';
import { useWs } from '../lib/workspace';
import { cn } from '../lib/cn';
import { Badge, Button, Card, CardHeader, Input } from '../components/ui/primitives';
import { EmptyState, Skeleton, useToast } from '../components/ui/feedback';
import { fdate } from './common';
import { checkRescheduleDate, dueLabel, rescheduleChoices, sortFollowUps } from './dashboardLogic';
import { WhatsAppButton } from './WhatsAppButton';
import { followUpMessage } from './whatsapp';

type Row = DoctorSummary['followUps'][number];

function Reschedule({ row, today, onDone }: { row: Row; today: string; onDone: () => void }) {
  const { ws } = useWs();
  const qc = useQueryClient();
  const toast = useToast();
  const [value, setValue] = useState('');
  const [err, setErr] = useState('');
  const save = useMutation({
    mutationFn: (followUpOn: string) => api(wsPath(ws.id, `/patients/${row.patientId}`), { method: 'PATCH', body: { followUpOn } }),
    onSuccess: (_r, followUpOn) => {
      toast('ok', followUpOn ? `${row.name}: follow-up moved to ${fdate(followUpOn)}` : `${row.name}: follow-up cleared`);
      qc.invalidateQueries({ queryKey: ['clinic-summary', ws.id] });
      qc.invalidateQueries({ queryKey: ['patient', ws.id] });
      qc.invalidateQueries({ queryKey: ['register', ws.id] });
      onDone();
    },
    onError: (e) => toast('bad', `Not saved: ${e instanceof ApiError ? e.message : (e as Error).message}`),
  });
  const go = (date: string) => { const bad = checkRescheduleDate(date, today); setErr(bad || ''); if (!bad) save.mutate(date); };
  return (
    <div className="mt-2 rounded-lg border border-line bg-surface-2 p-3" role="group" aria-label={`Reschedule the follow-up for ${row.name}`}>
      <div className="flex flex-wrap items-center gap-1.5">
        {rescheduleChoices(today).map((c) => (
          <Button key={c.label} size="sm" variant="secondary" disabled={save.isPending} onClick={() => go(c.date)} title={fdate(c.date)}>{c.label}</Button>
        ))}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Input type="date" min={today} value={value} onChange={(e) => { setValue(e.target.value); setErr(''); }} aria-label="Pick a date" className="w-[11rem]" />
        <Button size="sm" variant="primary" loading={save.isPending} onClick={() => go(value)}>Save date</Button>
        <Button size="sm" variant="ghost" disabled={save.isPending} onClick={() => save.mutate('')} title="Remove the follow-up date">Clear</Button>
        <Button size="sm" variant="ghost" onClick={onDone} aria-label="Close"><X className="h-3.5 w-3.5" /></Button>
      </div>
      {err && <p className="mt-1.5 text-[12px] text-bad" role="alert">{err}</p>}
    </div>
  );
}

export function FollowUpList({ d, base, hasPatients, className }: { d: DoctorSummary | undefined; base: string; hasPatients: boolean; className?: string }) {
  const [open, setOpen] = useState<string | null>(null);
  const rows = d ? sortFollowUps(d.followUps) : [];
  const overdue = rows.filter((r) => r.overdueDays > 0).length;
  return (
    <Card className={cn('fhq-rise', className)}>
      <CardHeader title="Follow-ups to message" subtitle={d ? (rows.length ? `${overdue ? `${overdue} overdue · ` : ''}${rows.length} in the next 3 days` : 'Nothing due in the next 3 days') : ' '} icon={<CalendarCheck className="h-4 w-4" />}
        action={hasPatients ? <Link to={`${base}/patients`} className="inline-flex shrink-0 items-center gap-1 text-xs text-blue-soft hover:text-blue-bright">Register <ArrowRight className="h-3 w-3" /></Link> : undefined} />
      <div className="px-4 pb-3 pt-1 sm:px-5">
        {!d ? <Skeleton className="h-32" /> : rows.length ? (
          <ul className="divide-y divide-line">
            {rows.map((f) => {
              const due = dueLabel(f, d.today);
              return (
                <li key={f.patientId} className="py-2.5">
                  <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
                    <div className="min-w-[10rem] flex-1">
                      <Link to={`${base}/patients/${f.patientId}`} className="block break-words text-[13.5px] font-medium leading-snug hover:text-blue-bright">{f.name}</Link>
                      <p className="mt-0.5 break-words text-[12px] text-fg-2">{f.complaint || 'No complaint recorded'}</p>
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Badge tone={due.tone} icon={due.tone === 'red' ? <AlertTriangle className="h-3 w-3" /> : undefined}>{due.text}</Badge>
                      <span className="num text-[11.5px] text-muted" title="Follow-up date">{fdate(f.followUpOn)}</span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <WhatsAppButton size="sm" phone={f.phone} name={f.name} message={(clinic) => followUpMessage({ name: f.name, clinic, followUpOn: f.followUpOn, today: d.today })} />
                      <Button size="sm" variant="secondary" icon={<CalendarClock className="h-3.5 w-3.5" />} aria-expanded={open === f.patientId} onClick={() => setOpen(open === f.patientId ? null : f.patientId)}>Reschedule</Button>
                    </div>
                  </div>
                  {open === f.patientId && <Reschedule row={f} today={d.today} onDone={() => setOpen(null)} />}
                </li>
              );
            })}
          </ul>
        ) : <EmptyState className="py-6" icon={<CheckCircle2 className="h-5 w-5 text-ok" />} title="All caught up" body="No active patient has a follow-up due in the next 3 days. Set a follow-up date on a patient and it appears here." />}
      </div>
    </Card>
  );
}
