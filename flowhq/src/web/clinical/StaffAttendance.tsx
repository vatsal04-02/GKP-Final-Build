// Staff attendance: the clinic's own people (doctors, front desk), Monday to Sunday. Not the patients' sheet (that is Attendance.tsx).
// Every mark is saved to the clinic's Grist (Staff_Attendance) and logged in the audit log; "Check in now" stamps the real clinic-local time.
import { useEffect, useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, LogIn, LogOut, UserCheck } from 'lucide-react';
import { STAFF_STATUSES, type StaffMark, type StaffMonth, type StaffStatus, type StaffWeek } from '@core/clinical';
import { api, ws as wsPath } from '../lib/api';
import { useWs } from '../lib/workspace';
import { cn } from '../lib/cn';
import { Page } from '../components/layout/Shell';
import { Badge, Button, Card, Input, Segmented, Textarea } from '../components/ui/primitives';
import { EmptyState, ErrorState, Modal, SkeletonRows, useToast } from '../components/ui/feedback';
import { Field, errText, fdate, useToday } from './common';

const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const mondayOf = (d: string) => addDays(d, -((new Date(`${d}T00:00:00Z`).getUTCDay() + 6) % 7));
const addMonths = (m: string, n: number) => { const t = Number(m.slice(0, 4)) * 12 + Number(m.slice(5)) - 1 + n; return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`; };
const monthLabel = (m: string) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const hours = (min: number) => (min > 0 ? `${Math.floor(min / 60)}h ${String(min % 60).padStart(2, '0')}m` : '—');
const NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const LOOK: Record<StaffStatus, { glyph: string; cls: string; tone: 'green' | 'red' | 'amber' | 'blue' }> = {
  Present: { glyph: 'P', cls: 'bg-ok/10 text-ok', tone: 'green' },
  Absent: { glyph: 'A', cls: 'bg-bad/10 text-bad', tone: 'red' },
  'Half day': { glyph: 'H', cls: 'bg-warn/15 text-warn', tone: 'amber' },
  Leave: { glyph: 'L', cls: 'bg-sage text-blue-bright', tone: 'blue' },
};
type Row = StaffWeek['rows'][number];
type Target = { row: Row; date: string };

export default function StaffAttendance() {
  const { ws } = useWs();
  const qc = useQueryClient(); const toast = useToast(); const today = useToday();
  const [week, setWeek] = useState(() => mondayOf(today)); const [tab, setTab] = useState<'week' | 'month'>('week'); const [month, setMonth] = useState(() => today.slice(0, 7));
  const [target, setTarget] = useState<Target | null>(null);
  const data = useQuery({ queryKey: ['staff-att', ws.id, 'week', week], queryFn: () => api<StaffWeek>(wsPath(ws.id, `/staff-attendance?week=${week}`)), placeholderData: keepPreviousData });
  const sum = useQuery({ queryKey: ['staff-att', ws.id, 'month', month], queryFn: () => api<StaffMonth>(wsPath(ws.id, `/staff-attendance/month?month=${month}`)), enabled: tab === 'month', placeholderData: keepPreviousData });
  const refresh = () => qc.invalidateQueries({ queryKey: ['staff-att', ws.id] });
  const clock = useMutation({
    mutationFn: (v: { staffKey: string; kind: 'in' | 'out' }) => api<{ mark: StaffMark; duplicate: boolean }>(wsPath(ws.id, '/staff-attendance/clock'), { method: 'POST', body: v }),
    onSuccess: (r, v) => { refresh(); toast('ok', r.duplicate ? `Already checked in at ${r.mark.checkIn}` : v.kind === 'in' ? `Checked in at ${r.mark.checkIn}` : `Checked out at ${r.mark.checkOut}`); },
    onError: (e) => toast('bad', `Not saved: ${errText(e)}`),
  });
  const w = data.data; const rows = w?.rows || [];
  const me = rows.find((r) => r.isMe); const mine = me && w ? me.cells[w.today] : null;
  const thisWeek = w ? w.days.includes(w.today) : false;
  const count = (d: string) => rows.filter((r) => { const s = r.cells[d]?.status; return s === 'Present' || s === 'Half day'; }).length;
  const nav = tab === 'week'
    ? <div className="flex items-center gap-1"><Button size="sm" variant="ghost" onClick={() => setWeek(addDays(week, -7))} aria-label="Previous week"><ChevronLeft className="h-4 w-4" /></Button><span className="min-w-[150px] text-center text-sm font-medium">{fdate(week)} – {fdate(addDays(week, 6))}</span><Button size="sm" variant="ghost" onClick={() => setWeek(addDays(week, 7))} aria-label="Next week"><ChevronRight className="h-4 w-4" /></Button><Button size="sm" onClick={() => setWeek(mondayOf(today))}>This week</Button></div>
    : <div className="flex items-center gap-1"><Button size="sm" variant="ghost" onClick={() => setMonth(addMonths(month, -1))} aria-label="Previous month"><ChevronLeft className="h-4 w-4" /></Button><span className="min-w-[150px] text-center text-sm font-medium">{monthLabel(month)}</span><Button size="sm" variant="ghost" onClick={() => setMonth(addMonths(month, 1))} aria-label="Next month" disabled={month >= today.slice(0, 7)}><ChevronRight className="h-4 w-4" /></Button><Button size="sm" onClick={() => setMonth(today.slice(0, 7))}>This month</Button></div>;

  return (
    <Page title="Staff attendance" subtitle="Who is in today. Every change is saved to the clinic's records and logged." wide actions={nav}>
      {me && w && (
        <Card className="mb-4 flex flex-wrap items-center justify-between gap-3 px-5 py-4">
          <div className="min-w-0">
            <div className="text-[13px] text-fg-2">Your attendance today · {fdate(w.today)} · clinic time {w.now}</div>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-sm">
              {mine ? <><Badge tone={LOOK[mine.status].tone}>{mine.status}</Badge>{mine.checkIn && <span className="num">In {mine.checkIn}</span>}{mine.checkOut && <span className="num">· Out {mine.checkOut}</span>}</> : <span className="text-fg-2">Not marked yet</span>}
            </div>
          </div>
          <div className="flex gap-2">
            <Button variant="primary" icon={<LogIn className="h-4 w-4" />} loading={clock.isPending && clock.variables?.kind === 'in'} disabled={!!mine?.checkIn || clock.isPending} onClick={() => clock.mutate({ staffKey: me.key, kind: 'in' })}>Check in now</Button>
            <Button icon={<LogOut className="h-4 w-4" />} loading={clock.isPending && clock.variables?.kind === 'out'} disabled={!mine?.checkIn || !!mine?.checkOut || clock.isPending} onClick={() => clock.mutate({ staffKey: me.key, kind: 'out' })}>Check out now</Button>
          </div>
        </Card>
      )}
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <Segmented value={tab} onChange={setTab} options={[{ value: 'week', label: 'Week' }, { value: 'month', label: 'Month summary' }]} />
        <div className="flex flex-wrap items-center gap-1.5 text-[12px] text-fg-2">{STAFF_STATUSES.map((s) => <span key={s} className="inline-flex items-center gap-1"><span className={cn('inline-flex h-5 w-5 items-center justify-center rounded text-[11px] font-semibold', LOOK[s].cls)}>{LOOK[s].glyph}</span>{s}</span>)}</div>
      </div>

      {tab === 'week' ? (
        <Card className="overflow-hidden">
          {data.isLoading ? <SkeletonRows rows={6} /> : data.error ? <ErrorState error={data.error} retry={() => data.refetch()} /> : !rows.length ? <EmptyState icon={<UserCheck className="h-5 w-5" />} title="No staff to show" body="People with a FLOW HQ login, and the doctors in the clinic details, appear here automatically." /> : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[760px] border-collapse text-[13px]">
                <thead><tr>
                  <th className="border-b border-r border-line/70 bg-sage/40 px-3 py-2 text-left text-[12.5px] font-semibold text-fg-2">Staff</th>
                  {w!.days.map((d, i) => <th key={d} className={cn('w-[84px] border-b border-r border-line/70 bg-sage/40 px-1 py-2 text-center text-[11.5px] font-semibold text-fg-2 last:border-r-0', d === today && 'text-accent-strong')}>{NAMES[i]}<div className="text-[11.5px] font-normal text-muted">{d.slice(8)}/{d.slice(5, 7)}</div></th>)}
                </tr></thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.key} className={r.isMe ? 'bg-sage/15' : undefined}>
                      <td className="border-b border-r border-line/60 px-3 py-1.5"><span className="font-medium">{r.name}</span>{r.isMe && <span className="ml-1.5 text-[11.5px] text-muted">(you)</span>}{r.former && <div className="text-[12px] text-muted">No longer on the team list</div>}</td>
                      {w!.days.map((d) => {
                        const c = r.cells[d]; const future = d > w!.today;
                        return (
                          <td key={d} className="border-b border-r border-line/60 p-1 text-center last:border-r-0">
                            <button type="button" disabled={future} onClick={() => setTarget({ row: r, date: d })} aria-label={`${r.name}, ${fdate(d)}: ${c ? `${c.status}${c.checkIn ? `, in ${c.checkIn}` : ''}${c.checkOut ? `, out ${c.checkOut}` : ''}` : 'not marked'}`} title={c?.notes || undefined}
                              className={cn('flex h-10 w-full flex-col items-center justify-center rounded-lg text-base font-semibold leading-none transition-colors', c ? LOOK[c.status].cls : 'text-line-2 hover:bg-sage/40', future && 'cursor-not-allowed opacity-40')}>
                              {c ? LOOK[c.status].glyph : '·'}
                              {c?.checkIn && <span className="num mt-0.5 text-[10.5px] font-normal opacity-80">{c.checkIn}{c.checkOut ? `–${c.checkOut}` : ''}</span>}
                            </button>
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
                <tfoot><tr className="bg-sage/30 text-[12px] font-semibold"><td className="px-3 py-2">In (present + half day)</td>{w!.days.map((d) => <td key={d} className="num px-1 py-2 text-center">{count(d)}</td>)}</tr></tfoot>
              </table>
            </div>
          )}
        </Card>
      ) : (
        <Card className="overflow-hidden">
          {sum.isLoading ? <SkeletonRows rows={6} /> : sum.error ? <ErrorState error={sum.error} retry={() => sum.refetch()} /> : !sum.data?.rows.length ? <EmptyState icon={<UserCheck className="h-5 w-5" />} title="No staff to show" /> : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[620px] border-collapse text-[13px]">
                <thead><tr className="bg-sage/40 text-[12.5px] font-semibold text-fg-2">
                  <th className="border-b border-line/70 px-3 py-2 text-left">Staff</th>
                  {['Present', 'Half day', 'Absent', 'Leave', 'Hours worked'].map((h) => <th key={h} className="border-b border-line/70 px-3 py-2 text-right">{h}</th>)}
                </tr></thead>
                <tbody>
                  {sum.data.rows.map((r) => (
                    <tr key={r.key}><td className="border-b border-line/60 px-3 py-2 font-medium">{r.name}</td>
                      <td className="num border-b border-line/60 px-3 py-2 text-right">{r.present}</td><td className="num border-b border-line/60 px-3 py-2 text-right">{r.halfDay}</td>
                      <td className="num border-b border-line/60 px-3 py-2 text-right">{r.absent}</td><td className="num border-b border-line/60 px-3 py-2 text-right">{r.leave}</td>
                      <td className="num border-b border-line/60 px-3 py-2 text-right">{hours(r.workedMinutes)}</td></tr>
                  ))}
                </tbody>
              </table>
              <p className="px-3 py-2 text-[12px] text-muted">Hours count only days with both a check-in and a later check-out.</p>
            </div>
          )}
        </Card>
      )}
      {!thisWeek && tab === 'week' && w && <p className="mt-2 text-[12px] text-muted">You are looking at another week. Use "This week" to get back to today.</p>}
      {target && w && <MarkDialog target={target} now={w.now} onClose={() => setTarget(null)} onSaved={() => { refresh(); setTarget(null); }} />}
    </Page>
  );
}

function MarkDialog({ target, now, onClose, onSaved }: { target: Target; now: string; onClose: () => void; onSaved: () => void }) {
  const { ws } = useWs(); const toast = useToast();
  const { row, date } = target; const cur = row.cells[date];
  const [status, setStatus] = useState<StaffStatus>(cur?.status || 'Present'); const [checkIn, setIn] = useState(cur?.checkIn || ''); const [checkOut, setOut] = useState(cur?.checkOut || ''); const [notes, setNotes] = useState(cur?.notes || '');
  const [err, setErr] = useState('');
  const timed = status === 'Present' || status === 'Half day';
  useEffect(() => { if (!timed) { setIn(''); setOut(''); } }, [timed]);
  const save = useMutation({
    mutationFn: (clear: boolean) => api(wsPath(ws.id, '/staff-attendance'), { method: 'PUT', body: clear ? { staffKey: row.key, date, status: null } : { staffKey: row.key, date, status, checkIn: timed ? checkIn : '', checkOut: timed ? checkOut : '', notes } }),
    onSuccess: (_r, clear) => { toast('ok', clear ? 'Mark cleared' : 'Attendance saved'); onSaved(); },
    onError: (e) => setErr(errText(e)),
  });
  return (
    <Modal open onClose={onClose} label="Mark attendance" className="w-[min(480px,96vw)]">
      <form className="space-y-3.5 p-5" onSubmit={(e) => { e.preventDefault(); setErr(''); save.mutate(false); }}>
        <div><h2 className="text-lg font-semibold">{row.name}</h2><p className="text-[13px] text-fg-2">{fdate(date)}</p></div>
        <Field label="Status"><Segmented value={status} onChange={setStatus} options={STAFF_STATUSES.map((s) => ({ value: s, label: s }))} /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Check-in" hint={timed ? <button type="button" className="underline" onClick={() => setIn(now)}>Use {now} (now)</button> : 'Only for Present or Half day'}><Input type="time" value={checkIn} onChange={(e) => setIn(e.target.value)} disabled={!timed} /></Field>
          <Field label="Check-out" hint={timed ? <button type="button" className="underline" onClick={() => setOut(now)}>Use {now} (now)</button> : undefined}><Input type="time" value={checkOut} onChange={(e) => setOut(e.target.value)} disabled={!timed} /></Field>
        </div>
        <Field label="Notes"><Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} maxLength={500} /></Field>
        {err && <p className="text-[13px] text-bad" role="alert">{err}</p>}
        <div className="flex items-center justify-between gap-2">
          <div>{cur && <Button type="button" variant="danger" onClick={() => { setErr(''); save.mutate(true); }} disabled={save.isPending}>Clear mark</Button>}</div>
          <div className="flex gap-2"><Button type="button" onClick={onClose}>Cancel</Button><Button type="submit" variant="primary" loading={save.isPending}>Save</Button></div>
        </div>
      </form>
    </Modal>
  );
}
