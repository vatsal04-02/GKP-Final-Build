// Booking settings (admins edit, everyone else sees them) and the audit log (admins). The AI on/off switch itself lives in the control panel at the top.
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ws as wsPath } from '../../lib/api';
import { useWs } from '../../lib/workspace';
import { Badge, Button, Card, Input } from '../../components/ui/primitives';
import { ErrorState, SkeletonRows, useToast } from '../../components/ui/feedback';
import { Field, useDebounced } from '../common';
import { problem, when, type AuditHealth } from './shared';

interface SettingsData { values: Record<string, string>; effective: Record<string, string | number | null>; problems: string[] }
const FIELDS: Array<{ key: string; label: string; hint: string; width?: string }> = [
  { key: 'approved_consent_forms', label: 'Approved consent form versions', hint: 'Comma-separated. A signed form counts as reminder-consent evidence only if its version is listed here. None is approved yet: review the registration form wording first.' },
  { key: 'slot_minutes', label: 'Appointment length (minutes)', hint: 'Default for every doctor; a doctor\'s hours can override it.', width: 'w-32' },
  { key: 'buffer_minutes', label: 'Gap between appointments (minutes)', hint: '0 = back to back.', width: 'w-32' },
  { key: 'capacity', label: 'Patients per time slot', hint: '1 = one patient at a time.', width: 'w-32' },
  { key: 'min_notice_minutes', label: 'Minimum notice for AI bookings (minutes)', hint: 'The AI is never offered a time sooner than this. Staff are not limited.', width: 'w-32' },
  { key: 'cancel_min_notice_minutes', label: 'Patient cancel / change notice (minutes)', hint: '0 = no limit. Applies to the WhatsApp assistant, not to staff.', width: 'w-32' },
  { key: 'max_advance_days', label: 'How far ahead the AI can book (days)', hint: 'Empty = no limit.', width: 'w-32' },
  { key: 'operating_days', label: 'Working days', hint: 'For example Mon-Sat.', width: 'w-48' },
  { key: 'open_windows', label: 'Opening hours', hint: 'For example 09:00-13:00, 16:00-20:00. No time is ever offered outside these hours.' },
  { key: 'timezone', label: 'Time zone', hint: 'The clinic clock, for example Asia/Kolkata.', width: 'w-56' },
];

export function SettingsTab() {
  const { ws, me } = useWs(); const qc = useQueryClient(); const toast = useToast(); const admin = me.user.role === 'admin';
  const q = useQuery({ queryKey: ['sched', ws.id, 'settings'], queryFn: () => api<SettingsData>(wsPath(ws.id, '/schedule/settings')) });
  const [v, setV] = useState<Record<string, string>>({}); const [err, setErr] = useState('');
  useEffect(() => { if (q.data) setV(q.data.values); }, [q.data]);
  const save = useMutation({
    mutationFn: () => api(wsPath(ws.id, '/schedule/settings'), { method: 'PUT', body: { values: Object.fromEntries(FIELDS.filter((f) => (v[f.key] ?? '') !== (q.data!.values[f.key] ?? '')).map((f) => [f.key, v[f.key] ?? ''])) } }),
    onSuccess: () => { setErr(''); void qc.invalidateQueries({ queryKey: ['sched', ws.id] }); toast('ok', 'Settings saved. They apply to the very next booking.'); }, onError: (e) => setErr(problem(e)),
  });
  if (q.isLoading) return <Card><SkeletonRows rows={6} /></Card>;
  if (q.isError) return <Card><ErrorState error={q.error} retry={() => q.refetch()} /></Card>;
  const dirty = FIELDS.some((f) => (v[f.key] ?? '') !== (q.data!.values[f.key] ?? ''));
  return (
    <Card className="p-5">
      {!admin && <p className="mb-4 rounded-lg border border-line bg-surface-2 px-3 py-2 text-[13px] text-fg-2">Only an admin can change these. You can see what they are.</p>}
      {q.data!.problems.length > 0 && <p className="mb-4 rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-[13px] text-warn" role="alert">{q.data!.problems.join('; ')}</p>}
      <form onSubmit={(e) => { e.preventDefault(); setErr(''); save.mutate(); }} className="grid gap-x-6 gap-y-4 lg:grid-cols-2">
        {FIELDS.map((f) => <Field key={f.key} label={f.label} hint={f.hint} className={f.key === 'open_windows' ? 'lg:col-span-2' : ''}><Input className={f.width} value={v[f.key] ?? ''} onChange={(e) => setV((x) => ({ ...x, [f.key]: e.target.value }))} disabled={!admin} /></Field>)}
        {err && <p className="rounded-lg border border-bad/30 bg-bad/10 px-3 py-2 text-[13px] text-bad lg:col-span-2" role="alert">{err}</p>}
        {admin && <div className="flex justify-end gap-2 lg:col-span-2"><Button type="button" variant="ghost" disabled={!dirty} onClick={() => setV(q.data!.values)}>Undo changes</Button><Button type="submit" variant="primary" disabled={!dirty} loading={save.isPending}>Save settings</Button></div>}
      </form>
    </Card>
  );
}

interface AuditData { rows: Array<{ at: string | null; actor: string; source: string; action: string; record: string; outcome: string; reason: string; detail: string }>; total: number; health: AuditHealth }
const ACTION: Record<string, string> = { create: 'Booked', reschedule: 'Moved', cancel: 'Cancelled', status: 'Status changed', booking_enabled: 'AI booking switch', setting: 'Setting changed', doctor: 'Doctor changed', schedule: 'Hours changed', block: 'Leave / block' };
export function AuditTab() {
  const { ws } = useWs(); const [text, setText] = useState(''); const dq = useDebounced(text);
  const q = useQuery({ queryKey: ['sched', ws.id, 'audit', dq], queryFn: () => api<AuditData>(wsPath(ws.id, `/schedule/audit?limit=200${dq ? `&q=${encodeURIComponent(dq)}` : ''}`)), refetchInterval: 30000 });
  if (q.isLoading) return <Card><SkeletonRows rows={8} /></Card>;
  if (q.isError) return <Card><ErrorState error={q.error} retry={() => q.refetch()} /></Card>;
  const h = q.data!.health;
  return (
    <div className="space-y-3">
      <p className="rounded-lg border border-line bg-surface px-3 py-2 text-[12.5px] text-fg-2">Change log: {h.durable ? 'kept durably on disk' : 'NOT durable (test setup)'}, {h.waiting_to_flush + h.open_intents} waiting to be written, {h.failed_since_start} write problem{h.failed_since_start === 1 ? '' : 's'} since the server started{h.rejected_for_audit > 0 ? `, ${h.rejected_for_audit} change(s) refused because it could not be saved` : ''}.</p>
      {h.level !== 'ok' && <div className="rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-[13px] text-warn" role="alert">{h.reasons.join('; ')}{h.last_failure_at ? ` (last problem ${when(h.last_failure_at)})` : ''}. Bookings already saved are safe.</div>}
      <div className="max-w-xs"><Input placeholder="Search who, what or reference" value={text} onChange={(e) => setText(e.target.value)} aria-label="Search the history" /></div>
      <Card className="overflow-hidden"><div className="max-h-[calc(100vh-24rem)] overflow-auto"><table className="w-full min-w-[780px] border-separate border-spacing-0 text-[13px]">
        <thead><tr>{['When', 'Who', 'What', 'Record', 'Result', 'Detail'].map((x) => <th key={x} className="sticky top-0 z-[2] whitespace-nowrap border-b border-line-2 bg-[rgb(235_242_238)] px-3 py-2.5 text-left text-[12.5px] font-semibold text-fg-2">{x}</th>)}</tr></thead>
        <tbody>{q.data!.rows.map((r, i) => (
          <tr key={i} className="even:bg-surface-2/60"><td className="whitespace-nowrap border-b border-line/60 px-3 py-2">{when(r.at)}</td><td className="border-b border-line/60 px-3 py-2">{r.source === 'API' ? 'WhatsApp assistant' : r.actor}<div className="text-[12px] text-muted">{r.source}</div></td>
            <td className="border-b border-line/60 px-3 py-2">{ACTION[r.action] || r.action}</td><td className="border-b border-line/60 px-3 py-2 font-mono text-[12px] text-fg-2">{r.record}</td>
            <td className="border-b border-line/60 px-3 py-2"><Badge tone={r.outcome === 'ok' ? 'green' : 'red'}>{r.outcome === 'ok' ? r.reason : `refused: ${r.reason}`}</Badge></td><td className="max-w-[18rem] truncate border-b border-line/60 px-3 py-2 font-mono text-[11.5px] text-muted" title={r.detail}>{r.detail}</td></tr>))}</tbody>
      </table></div></Card>
      {!q.data!.rows.length && <p className="text-[13px] text-fg-2">Nothing recorded yet.</p>}
    </div>
  );
}
