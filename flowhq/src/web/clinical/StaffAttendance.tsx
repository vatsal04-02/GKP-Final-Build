// Staff attendance: the clinic's own people (doctors, front desk, anyone added by name), Monday to Sunday. Not the patients' sheet (that is Attendance.tsx).
// A day is only Present, Absent, Half day or Leave (plus a note). Every mark is saved to the clinic's Grist (Staff_Attendance) and logged in the audit log.
import { useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, KeyRound, Lock, UserCheck, UserPlus } from 'lucide-react';
import { STAFF_STATUSES, type StaffMonth, type StaffStatus, type StaffWeek } from '@core/clinical';
import { api, ws as wsPath } from '../lib/api';
import { useWs } from '../lib/workspace';
import { cn } from '../lib/cn';
import { Page } from '../components/layout/Shell';
import { Button, Card, Input, Segmented, Textarea } from '../components/ui/primitives';
import { EmptyState, ErrorState, Modal, SkeletonRows, useToast } from '../components/ui/feedback';
import { Field, errText, fdate, useToday } from './common';

const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const mondayOf = (d: string) => addDays(d, -((new Date(`${d}T00:00:00Z`).getUTCDay() + 6) % 7));
const addMonths = (m: string, n: number) => { const t = Number(m.slice(0, 4)) * 12 + Number(m.slice(5)) - 1 + n; return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`; };
const monthLabel = (m: string) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const LOOK: Record<StaffStatus, { glyph: string; cls: string }> = {
  Present: { glyph: 'P', cls: 'bg-ok/10 text-ok' },
  Absent: { glyph: 'A', cls: 'bg-bad/10 text-bad' },
  'Half day': { glyph: 'H', cls: 'bg-warn/15 text-warn' },
  Leave: { glyph: 'L', cls: 'bg-sage text-blue-bright' },
};
type Row = StaffWeek['rows'][number];
type Target = { row: Row; date: string };

export default function StaffAttendance() {
  const { ws } = useWs();
  const qc = useQueryClient(); const today = useToday();
  const [week, setWeek] = useState(() => mondayOf(today)); const [tab, setTab] = useState<'week' | 'month'>('week'); const [month, setMonth] = useState(() => today.slice(0, 7));
  const [target, setTarget] = useState<Target | null>(null); const [adding, setAdding] = useState(false); const [removing, setRemoving] = useState<Row | null>(null); const [settingPw, setSettingPw] = useState(false);
  const data = useQuery({ queryKey: ['staff-att', ws.id, 'week', week], queryFn: () => api<StaffWeek>(wsPath(ws.id, `/staff-attendance?week=${week}`)), placeholderData: keepPreviousData });
  const sum = useQuery({ queryKey: ['staff-att', ws.id, 'month', month], queryFn: () => api<StaffMonth>(wsPath(ws.id, `/staff-attendance/month?month=${month}`)), enabled: tab === 'month', placeholderData: keepPreviousData });
  const refresh = () => qc.invalidateQueries({ queryKey: ['staff-att', ws.id] });
  const w = data.data; const rows = w?.rows || [];
  const count = (d: string) => rows.filter((r) => { const s = r.cells[d]?.status; return s === 'Present' || s === 'Half day'; }).length;
  const nav = tab === 'week'
    ? <div className="flex items-center gap-1"><Button size="sm" variant="ghost" onClick={() => setWeek(addDays(week, -7))} aria-label="Previous week"><ChevronLeft className="h-4 w-4" /></Button><span className="min-w-[150px] text-center text-sm font-medium">{fdate(week)} – {fdate(addDays(week, 6))}</span><Button size="sm" variant="ghost" onClick={() => setWeek(addDays(week, 7))} aria-label="Next week"><ChevronRight className="h-4 w-4" /></Button><Button size="sm" onClick={() => setWeek(mondayOf(today))}>This week</Button></div>
    : <div className="flex items-center gap-1"><Button size="sm" variant="ghost" onClick={() => setMonth(addMonths(month, -1))} aria-label="Previous month"><ChevronLeft className="h-4 w-4" /></Button><span className="min-w-[150px] text-center text-sm font-medium">{monthLabel(month)}</span><Button size="sm" variant="ghost" onClick={() => setMonth(addMonths(month, 1))} aria-label="Next month" disabled={month >= today.slice(0, 7)}><ChevronRight className="h-4 w-4" /></Button><Button size="sm" onClick={() => setMonth(today.slice(0, 7))}>This month</Button></div>;

  return (
    <Page title="Staff attendance" subtitle="Mark each person Present, Absent, Half day or Leave. Every change is saved to the clinic's records and logged." wide actions={nav}>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-3">
          <Segmented value={tab} onChange={setTab} options={[{ value: 'week', label: 'Week' }, { value: 'month', label: 'Month summary' }]} />
          {w?.canManageTeam && <Button size="sm" icon={<UserPlus className="h-4 w-4" />} onClick={() => setAdding(true)}>Add staff</Button>}
          {w?.canSetLockPassword && <Button size="sm" icon={<KeyRound className="h-4 w-4" />} onClick={() => setSettingPw(true)}>{w.lockPasswordSet ? 'Change edit password' : 'Set edit password'}</Button>}
        </div>
        <div className="flex flex-wrap items-center gap-1.5 text-[12px] text-fg-2">{STAFF_STATUSES.map((s) => <span key={s} className="inline-flex items-center gap-1"><span className={cn('inline-flex h-5 w-5 items-center justify-center rounded text-[11px] font-semibold', LOOK[s].cls)}>{LOOK[s].glyph}</span>{s}</span>)}</div>
      </div>

      {w && !w.lockPasswordSet && <p className="mb-3 flex items-start gap-2 rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-[13px] text-fg-2" role="status"><Lock className="mt-0.5 h-4 w-4 shrink-0 text-warn" /><span>A marked day is locked, and no edit password has been set yet, so nobody can change a mark. {w.canSetLockPassword ? 'Use "Set edit password" above so mistakes can be corrected.' : 'Ask the admin to set the attendance edit password.'}</span></p>}
      {tab === 'week' ? (
        <Card className="overflow-hidden">
          {data.isLoading ? <SkeletonRows rows={6} /> : data.error ? <ErrorState error={data.error} retry={() => data.refetch()} /> : !rows.length ? <EmptyState icon={<UserCheck className="h-5 w-5" />} title="No staff to show" body="People with a FLOW HQ login and the doctors in the clinic details appear here automatically. Use Add staff for anyone else." /> : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[760px] border-collapse text-[13px]">
                <thead><tr>
                  <th className="border-b border-r border-line/70 bg-sage/40 px-3 py-2 text-left text-[12.5px] font-semibold text-fg-2">Staff</th>
                  {w!.days.map((d, i) => <th key={d} className={cn('w-[84px] border-b border-r border-line/70 bg-sage/40 px-1 py-2 text-center text-[11.5px] font-semibold text-fg-2 last:border-r-0', d === today && 'text-accent-strong')}>{NAMES[i]}<div className="text-[11.5px] font-normal text-muted">{d.slice(8)}/{d.slice(5, 7)}</div></th>)}
                </tr></thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.key} className={r.isMe ? 'bg-sage/15' : undefined}>
                      <td className="border-b border-r border-line/60 px-3 py-1.5">
                        <div className="flex items-center justify-between gap-2">
                          <span className="min-w-0 truncate"><span className="font-medium">{r.name}</span>{r.isMe && <span className="ml-1.5 text-[11.5px] text-muted">(you)</span>}</span>
                          {r.removable && w!.canManageTeam && <button type="button" onClick={() => setRemoving(r)} className="shrink-0 text-[12px] text-muted underline hover:text-bad" aria-label={`Remove ${r.name} from the list`}>Remove</button>}
                        </div>
                        {r.former && <div className="text-[12px] text-muted">No longer on the team list</div>}
                      </td>
                      {w!.days.map((d) => {
                        const c = r.cells[d]; const future = d > w!.today;
                        return (
                          <td key={d} className="border-b border-r border-line/60 p-1 text-center last:border-r-0">
                            <button type="button" disabled={future} onClick={() => setTarget({ row: r, date: d })} aria-label={`${r.name}, ${fdate(d)}: ${c ? `${c.status}, locked` : 'not marked'}`} title={c?.notes || undefined}
                              className={cn('relative h-10 w-full rounded-lg text-base font-semibold transition-colors', c ? LOOK[c.status].cls : 'text-line-2 hover:bg-sage/40', future && 'cursor-not-allowed opacity-40')}>
                              {c ? LOOK[c.status].glyph : '·'}
                              {c && <Lock className="absolute bottom-0.5 right-0.5 h-2.5 w-2.5 opacity-60" aria-hidden />}
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
              <table className="w-full min-w-[520px] border-collapse text-[13px]">
                <thead><tr className="bg-sage/40 text-[12.5px] font-semibold text-fg-2">
                  <th className="border-b border-line/70 px-3 py-2 text-left">Staff</th>
                  {['Present', 'Half day', 'Absent', 'Leave'].map((h) => <th key={h} className="border-b border-line/70 px-3 py-2 text-right">{h}</th>)}
                </tr></thead>
                <tbody>
                  {sum.data.rows.map((r) => (
                    <tr key={r.key}><td className="border-b border-line/60 px-3 py-2 font-medium">{r.name}</td>
                      <td className="num border-b border-line/60 px-3 py-2 text-right">{r.present}</td><td className="num border-b border-line/60 px-3 py-2 text-right">{r.halfDay}</td>
                      <td className="num border-b border-line/60 px-3 py-2 text-right">{r.absent}</td><td className="num border-b border-line/60 px-3 py-2 text-right">{r.leave}</td></tr>
                  ))}
                </tbody>
              </table>
              <p className="px-3 py-2 text-[12px] text-muted">Days marked in this month. A day nobody marked is not counted.</p>
            </div>
          )}
        </Card>
      )}
      {target && w && <MarkDialog target={target} lockSet={w.lockPasswordSet} canSetPassword={w.canSetLockPassword} onSetPassword={() => { setTarget(null); setSettingPw(true); }} onClose={() => setTarget(null)} onSaved={() => { refresh(); setTarget(null); }} />}
      {settingPw && w && <PasswordDialog changing={w.lockPasswordSet} onClose={() => setSettingPw(false)} onSaved={() => { refresh(); setSettingPw(false); }} />}
      {adding && <AddDialog onClose={() => setAdding(false)} onSaved={() => { refresh(); setAdding(false); }} />}
      {removing && <RemoveDialog row={removing} onClose={() => setRemoving(null)} onDone={() => { refresh(); setRemoving(null); }} />}
    </Page>
  );
}

function MarkDialog({ target, lockSet, canSetPassword, onSetPassword, onClose, onSaved }: { target: Target; lockSet: boolean; canSetPassword: boolean; onSetPassword: () => void; onClose: () => void; onSaved: () => void }) {
  const { ws } = useWs(); const toast = useToast();
  const { row, date } = target; const cur = row.cells[date];
  const [status, setStatus] = useState<StaffStatus>(cur?.status || 'Present'); const [notes, setNotes] = useState(cur?.notes || ''); const [pw, setPw] = useState(''); const [err, setErr] = useState('');
  const marked = !!cur;                                   // a marked day is locked: changing or clearing it needs the edit password (the server enforces this)
  const save = useMutation({
    mutationFn: (clear: boolean) => api(wsPath(ws.id, '/staff-attendance'), { method: 'PUT', body: { staffKey: row.key, date, status: clear ? null : status, ...(clear ? {} : { notes }), ...(marked ? { editPassword: pw } : {}) } }),
    onSuccess: (_r, clear) => { toast('ok', clear ? 'Mark cleared' : 'Attendance saved'); onSaved(); },
    onError: (e) => setErr(errText(e)),
  });
  const go = (clear: boolean) => { setErr(''); if (marked && !pw) { setErr('Enter the attendance edit password'); return; } save.mutate(clear); };
  if (marked && !lockSet) return (
    <Modal open onClose={onClose} label="Marked day is locked" className="w-[min(460px,96vw)]">
      <div className="space-y-3.5 p-5">
        <div><h2 className="flex items-center gap-2 text-lg font-semibold"><Lock className="h-4 w-4" />{row.name}</h2><p className="text-[13px] text-fg-2">{fdate(date)} · marked <b>{cur!.status}</b></p></div>
        <p className="text-[13px] text-fg-2">This day is already marked, so it is locked. No attendance edit password has been set yet, so it cannot be changed.{canSetPassword ? ' Set one now to be able to correct marks.' : ' Ask the admin to set the attendance edit password.'}</p>
        <div className="flex justify-end gap-2"><Button type="button" onClick={onClose}>Close</Button>{canSetPassword && <Button type="button" variant="primary" onClick={onSetPassword}>Set edit password</Button>}</div>
      </div>
    </Modal>
  );
  return (
    <Modal open onClose={onClose} label="Mark attendance" className="w-[min(460px,96vw)]">
      <form className="space-y-3.5 p-5" onSubmit={(e) => { e.preventDefault(); go(false); }}>
        <div><h2 className="text-lg font-semibold">{row.name}</h2><p className="text-[13px] text-fg-2">{fdate(date)}</p></div>
        {marked && <p className="flex items-start gap-2 rounded-lg bg-warn/10 px-3 py-2 text-[13px] text-fg-2"><Lock className="mt-0.5 h-4 w-4 shrink-0 text-warn" /><span>This day is already marked <b>{cur!.status}</b> and is locked. Enter the attendance edit password to change or clear it.</span></p>}
        <Field label="Status"><Segmented value={status} onChange={setStatus} options={STAFF_STATUSES.map((s) => ({ value: s, label: s }))} /></Field>
        <Field label="Note (optional)"><Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} maxLength={500} /></Field>
        {marked && <Field label="Attendance edit password" required><Input type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="off" autoFocus /></Field>}
        {err && <p className="text-[13px] text-bad" role="alert">{err}</p>}
        <div className="flex items-center justify-between gap-2">
          <div>{marked && <Button type="button" variant="danger" onClick={() => go(true)} disabled={save.isPending}>Clear mark</Button>}</div>
          <div className="flex gap-2"><Button type="button" onClick={onClose}>Cancel</Button><Button type="submit" variant="primary" loading={save.isPending}>{marked ? 'Unlock and save' : 'Save'}</Button></div>
        </div>
      </form>
    </Modal>
  );
}

function PasswordDialog({ changing, onClose, onSaved }: { changing: boolean; onClose: () => void; onSaved: () => void }) {
  const { ws } = useWs(); const toast = useToast();
  const [cur, setCur] = useState(''); const [pw, setPw] = useState(''); const [again, setAgain] = useState(''); const [err, setErr] = useState('');
  const save = useMutation({
    mutationFn: () => api(wsPath(ws.id, '/staff-attendance/edit-password'), { method: 'PUT', body: { password: pw, ...(changing ? { currentPassword: cur } : {}) } }),
    onSuccess: () => { toast('ok', changing ? 'Edit password changed' : 'Edit password set'); onSaved(); },
    onError: (e) => setErr(errText(e)),
  });
  return (
    <Modal open onClose={onClose} label="Attendance edit password" className="w-[min(440px,96vw)]">
      <form className="space-y-3.5 p-5" onSubmit={(e) => { e.preventDefault(); setErr(''); if (changing && !cur) { setErr('Enter the current edit password'); return; } if (pw.length < 8) { setErr('Use at least 8 characters'); return; } if (pw !== again) { setErr('The two passwords are not the same'); return; } save.mutate(); }}>
        <div><h2 className="text-lg font-semibold">{changing ? 'Change edit password' : 'Set edit password'}</h2><p className="text-[13px] text-fg-2">Once a day is marked it is locked. This password is needed to change or clear a mark. Only you and the people you tell will know it. It is stored only as a hash, never as text.</p></div>
        {changing && <Field label="Current edit password" required><Input type="password" value={cur} onChange={(e) => setCur(e.target.value)} autoComplete="off" autoFocus /></Field>}
        <Field label="New password" required hint="At least 8 characters"><Input type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password" autoFocus={!changing} /></Field>
        <Field label="Type it again" required><Input type="password" value={again} onChange={(e) => setAgain(e.target.value)} autoComplete="new-password" /></Field>
        {err && <p className="text-[13px] text-bad" role="alert">{err}</p>}
        <div className="flex justify-end gap-2"><Button type="button" onClick={onClose}>Cancel</Button><Button type="submit" variant="primary" loading={save.isPending}>{changing ? 'Change password' : 'Set password'}</Button></div>
      </form>
    </Modal>
  );
}

function AddDialog({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const { ws } = useWs(); const toast = useToast();
  const [name, setName] = useState(''); const [err, setErr] = useState('');
  const add = useMutation({
    mutationFn: () => api<{ member: { name: string }; reactivated: boolean }>(wsPath(ws.id, '/staff-attendance/members'), { method: 'POST', body: { name } }),
    onSuccess: (r) => { toast('ok', r.reactivated ? `${r.member.name} is back on the list` : `${r.member.name} added`); onSaved(); },
    onError: (e) => setErr(errText(e)),
  });
  return (
    <Modal open onClose={onClose} label="Add staff" className="w-[min(440px,96vw)]">
      <form className="space-y-3.5 p-5" onSubmit={(e) => { e.preventDefault(); setErr(''); if (!name.trim()) { setErr('Enter the name'); return; } add.mutate(); }}>
        <div><h2 className="text-lg font-semibold">Add staff</h2><p className="text-[13px] text-fg-2">For people who do not have a FLOW HQ login, such as a receptionist or helper.</p></div>
        <Field label="Name" required><Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoFocus placeholder="e.g. Priya Sharma" /></Field>
        {err && <p className="text-[13px] text-bad" role="alert">{err}</p>}
        <div className="flex justify-end gap-2"><Button type="button" onClick={onClose}>Cancel</Button><Button type="submit" variant="primary" loading={add.isPending}>Add</Button></div>
      </form>
    </Modal>
  );
}

function RemoveDialog({ row, onClose, onDone }: { row: Row; onClose: () => void; onDone: () => void }) {
  const { ws } = useWs(); const toast = useToast(); const [err, setErr] = useState('');
  const rm = useMutation({
    mutationFn: () => api(wsPath(ws.id, `/staff-attendance/members/${encodeURIComponent(row.key)}`), { method: 'DELETE' }),
    onSuccess: () => { toast('ok', `${row.name} removed from the list`); onDone(); },
    onError: (e) => setErr(errText(e)),
  });
  return (
    <Modal open onClose={onClose} label="Remove from the list" className="w-[min(440px,96vw)]">
      <div className="space-y-3.5 p-5">
        <h2 className="text-lg font-semibold">Remove {row.name}?</h2>
        <p className="text-[13px] text-fg-2">They will no longer be listed. Their past attendance stays saved and still shows in the weeks it covers. Adding the same name again brings them back.</p>
        {err && <p className="text-[13px] text-bad" role="alert">{err}</p>}
        <div className="flex justify-end gap-2"><Button type="button" onClick={onClose}>Keep</Button><Button type="button" variant="danger" loading={rm.isPending} onClick={() => { setErr(''); rm.mutate(); }}>Remove</Button></div>
      </div>
    </Modal>
  );
}
