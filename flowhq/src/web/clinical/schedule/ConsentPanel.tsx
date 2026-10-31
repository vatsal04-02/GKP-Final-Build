// Reminder consent for one phone: the current answer, whether automated reminders will go out (and why not), the history, and the actions THIS login may do.
// The server decides every write: a Yes needs an explicit grant and evidence, a No any staff member, a correction or revocation an admin.
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BellOff, BellRing, History } from 'lucide-react';
import { api, ws as wsPath } from '../../lib/api';
import { useWs } from '../../lib/workspace';
import { Badge, Button, Input, Select } from '../../components/ui/primitives';
import { Skeleton, useToast } from '../../components/ui/feedback';
import { Field } from '../common';
import { Confirm, problem, when } from './shared';

interface Hist { log_id: string; kind: string; value: string; previous_value: string; at: string | null; source: string; evidence_ref: string; evidence_date: string | null; form_version: string; actor: string; note: string }
interface ConsentState { phone: string; value: 'Yes' | 'No' | 'Unknown'; effective: { allowed: boolean; reason: string }; source: string; evidence_ref: string; evidence_date: string | null; form_version: string; at: string | null; history: Hist[]; can: { record_yes: boolean; record_no: boolean; correct: boolean } }
const YES_SOURCES = ['Told staff in person', 'Told staff by phone', 'Patient replied on WhatsApp (reviewed by staff)', 'Signed registration form'];
const NEEDS_FORM = ['Signed registration form', 'Imported with evidence'];
const WHY: Record<string, string> = { consent_yes: 'Reminder consent was recorded.', consent_no: 'The patient said No.', opted_out: 'The patient has opted out of WhatsApp messages.', consent_unknown: 'No reminder consent has been recorded yet. A patient messaging first, or ticking the website box, does not count.' };
const TONE = { Yes: 'green', No: 'red', Unknown: 'amber' } as const;

export function ConsentPanel({ phone, patientId }: { phone: string; patientId?: string }) {
  const { ws } = useWs(); const qc = useQueryClient(); const toast = useToast();
  const q = useQuery({ queryKey: ['sched', ws.id, 'consent', phone], queryFn: () => api<ConsentState>(wsPath(ws.id, `/schedule/consent?phone=${encodeURIComponent(phone)}`)), enabled: !!phone });
  const [mode, setMode] = useState<null | 'yes' | 'correct'>(null); const [confirmNo, setConfirmNo] = useState(false); const [revoking, setRevoking] = useState(false); const [showHist, setShowHist] = useState(false);
  const [f, setF] = useState({ value: 'Yes', source: YES_SOURCES[0]!, ref: '', date: '', form: '', note: '' }); const [err, setErr] = useState('');
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));
  const done = (m: string) => { toast('ok', m); setMode(null); setConfirmNo(false); setRevoking(false); setErr(''); void qc.invalidateQueries({ queryKey: ['sched', ws.id, 'consent'] }); void qc.invalidateQueries({ queryKey: ['sched', ws.id, 'appt'] }); };   // the appointment's reminder outlook depends on consent
  const body = () => ({ phone, value: f.value, source: f.source, evidence_ref: f.ref, evidence_date: f.date || null, form_version: f.form, note: f.note, ...(patientId ? { patient_id: patientId } : {}) });
  const record = useMutation({ mutationFn: () => api(wsPath(ws.id, mode === 'correct' ? '/schedule/consent/correct' : '/schedule/consent'), { method: 'POST', body: body() }), onSuccess: () => done('Consent recorded'), onError: (e) => setErr(problem(e)) });
  const no = useMutation({ mutationFn: () => api(wsPath(ws.id, '/schedule/consent'), { method: 'POST', body: { phone, value: 'No', source: 'Patient withdrew', note: f.note, ...(patientId ? { patient_id: patientId } : {}) } }), onSuccess: () => done('Recorded: no reminders will be sent'), onError: (e) => { setConfirmNo(false); toast('bad', problem(e)); } });
  const revoke = useMutation({ mutationFn: () => api(wsPath(ws.id, '/schedule/consent/revoke'), { method: 'POST', body: { phone, note: f.note } }), onSuccess: () => done('Consent revoked'), onError: (e) => { setRevoking(false); toast('bad', problem(e)); } });
  if (q.isLoading) return <Skeleton className="h-16 w-full" />;
  if (q.isError || !q.data) return <p className="text-[13px] text-fg-2">Reminder consent could not be loaded ({problem(q.error)}).</p>;
  const c = q.data; const needsForm = NEEDS_FORM.includes(f.source);
  return (
    <section aria-label="Reminder consent" className="border-t border-line pt-4">
      <div className="flex flex-wrap items-center gap-2.5"><h4 className="section-title">WhatsApp reminder consent</h4><Badge tone={TONE[c.value]} icon={c.effective.allowed ? <BellRing className="h-3 w-3" /> : <BellOff className="h-3 w-3" />}>{c.value}</Badge></div>
      <p className="mt-1.5 text-[13px] text-fg-2">Automated reminders <b className={c.effective.allowed ? 'text-ok' : 'text-bad'}>{c.effective.allowed ? 'will be sent' : 'will NOT be sent'}</b>. {WHY[c.effective.reason]}</p>
      {c.value !== 'Unknown' && <p className="mt-1 text-[12px] text-muted">{c.source}{c.evidence_ref ? ` · ref ${c.evidence_ref}` : ''}{c.evidence_date ? ` · ${c.evidence_date}` : ''}{c.form_version ? ` · form ${c.form_version}` : ''} · recorded {when(c.at)}</p>}
      <div className="mt-3 flex flex-wrap gap-2">
        {c.can.record_yes ? <Button size="sm" onClick={() => { setMode(mode === 'yes' ? null : 'yes'); setF({ ...f, value: 'Yes', source: YES_SOURCES[0]! }); setErr(''); }}>Record consent (Yes)</Button> : <span className="text-[12px] text-muted">Recording a Yes needs permission from an admin.</span>}
        {c.can.record_no && c.value !== 'No' && <Button size="sm" variant="danger" onClick={() => { setF({ ...f, note: '' }); setConfirmNo(true); }}>Patient said No</Button>}
        {c.can.correct && <><Button size="sm" variant="secondary" onClick={() => { setMode(mode === 'correct' ? null : 'correct'); setF({ ...f, value: c.value === 'Yes' ? 'No' : 'Yes', source: 'Admin correction' }); setErr(''); }}>Correct…</Button>{c.value === 'Yes' && <Button size="sm" variant="ghost" onClick={() => { setF({ ...f, note: '' }); setRevoking(true); }}>Revoke</Button>}</>}
        <Button size="sm" variant="ghost" icon={<History className="h-3.5 w-3.5" />} onClick={() => setShowHist((s) => !s)}>{showHist ? 'Hide history' : `History (${c.history.length})`}</Button>
      </div>
      {mode && (
        <form className="mt-3 space-y-3 rounded-lg border border-line bg-surface-2 p-3" onSubmit={(e) => { e.preventDefault(); setErr(''); record.mutate(); }}>
          <div className="grid gap-3 sm:grid-cols-2">
            {mode === 'correct' && <Field label="New answer"><Select value={f.value} onChange={(e) => set('value', e.target.value)}><option>Yes</option><option>No</option><option>Unknown</option></Select></Field>}
            <Field label="Where did it come from?"><Select value={f.source} onChange={(e) => set('source', e.target.value)}>{(mode === 'correct' ? ['Admin correction', ...YES_SOURCES, 'Patient withdrew'] : YES_SOURCES).map((s) => <option key={s}>{s}</option>)}</Select></Field>
            <Field label="Evidence reference" required={f.value === 'Yes'} hint="Register serial, form id or call note"><Input value={f.ref} maxLength={120} onChange={(e) => set('ref', e.target.value)} /></Field>
            {needsForm && <><Field label="Signature date" required><Input type="date" value={f.date} onChange={(e) => set('date', e.target.value)} /></Field><Field label="Form version" required hint="Must be an approved form"><Input value={f.form} maxLength={60} onChange={(e) => set('form', e.target.value)} /></Field></>}
            {mode === 'correct' && <Field label="Why (required)" className="sm:col-span-2"><Input value={f.note} maxLength={300} onChange={(e) => set('note', e.target.value)} /></Field>}
          </div>
          {err && <p className="rounded-lg border border-bad/30 bg-bad/10 px-3 py-2 text-[13px] text-bad" role="alert">{err}</p>}
          <div className="flex justify-end gap-2"><Button type="button" variant="ghost" onClick={() => setMode(null)}>Cancel</Button><Button type="submit" variant="primary" loading={record.isPending}>Save</Button></div>
        </form>
      )}
      {showHist && (c.history.length ? (
        <ol className="mt-3 space-y-2 border-l border-line pl-4">{c.history.map((h) => (
          <li key={h.log_id} className="relative text-[13px]"><span className="absolute -left-[20px] top-1.5 h-1.5 w-1.5 rounded-full bg-fg-2/60" /><span className="font-medium">{h.previous_value} → {h.value}</span> <span className="text-fg-2">({h.kind}, {h.source}{h.evidence_ref ? `, ref ${h.evidence_ref}` : ''})</span>
            <div className="text-[12px] text-muted">{h.actor} · {when(h.at)}{h.note ? ` · ${h.note}` : ''}</div></li>))}</ol>
      ) : <p className="mt-3 text-[13px] text-fg-2">Nothing has ever been recorded for this number.</p>)}
      <Confirm open={confirmNo} title="Record that the patient said No?" danger confirmLabel="Record No" busy={no.isPending} onClose={() => setConfirmNo(false)} onConfirm={() => no.mutate()} body={<>No automated reminders will be sent to this number. This takes effect immediately and is kept in the history.</>} />
      <Confirm open={revoking} title="Revoke this consent?" danger confirmLabel="Revoke" busy={revoke.isPending} onClose={() => setRevoking(false)} onConfirm={() => f.note.trim().length >= 5 ? revoke.mutate() : toast('bad', 'Write why (at least 5 characters) first.')}
        body={<><p>The answer becomes No and reminders stop. The earlier Yes stays in the history.</p><div className="mt-3"><Field label="Why (required)"><Input value={f.note} maxLength={300} onChange={(e) => set('note', e.target.value)} /></Field></div></>} />
    </section>
  );
}
