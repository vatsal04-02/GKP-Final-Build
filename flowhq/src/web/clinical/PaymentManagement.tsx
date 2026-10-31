// Payments: the review queue for UPI payments, the screenshot viewer, approve / reject / refund, and (admins) the switches that open payments to patients.
// A screenshot or an OCR result is never proof of payment: "Paid" is set only here, by a person who has seen the money in the clinic's bank account.
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, ShieldCheck } from 'lucide-react';
import { api, ws as wsPath } from '../lib/api';
import { useWs } from '../lib/workspace';
import { Badge, Button, Card, Input, Segmented, Switch, Textarea } from '../components/ui/primitives';
import { Page } from '../components/layout/Shell';
import { cn } from '../lib/cn';
import { Drawer, ErrorState, SkeletonRows, useToast } from '../components/ui/feedback';
import { Field, useDebounced } from './common';
import { Confirm, problem, when } from './schedule/shared';

interface Row { id: string; booking_reference: string; channel: string; status: string; appointment_status: string | null; patient: { name: string; phone: string }; amount_inr: string; utr: string; utr_source: string; screenshots: number; flags: string[];
  extracted: { amount_inr: string | null; utr: string; txn_at: string | null; payee: string; payer: string; status: string; confidence: string }; verification_method: string; received_inr: string | null; reviewed_by: string; reviewed_at: string | null; review_note: string; refunded_at: string | null; refunded_by: string; expires_at: string | null; created_at: string | null; submitted_at: string | null; appointment: { date: string; start_time: string } | null; refund_due: boolean }
interface ListData { rows: Row[]; counts: Record<string, number>; totals: { collected_inr: string; collected_count: number }; total: number; needs_review: number; refund_due: number }
interface Detail { payment: Row; events: Array<{ at: string; actor: string; action: string; from: string; to: string; outcome: string; detail: string }>; appointment: { status: string; date: string; start_time: string; doctor_name: string | null } | null }
interface PaySettings { enabled: boolean; payee_authorized: boolean; payee_authorization_note: string; fee_inr: string; expiry_minutes: number; review_hold_minutes: number; payee_name: string; open_to_patients: boolean; closed_because: string[]; provider_webhook: boolean }

const LABEL: Record<string, string> = { PENDING_PAYMENT: 'Pending', SCREENSHOT_RECEIVED: 'Screenshot received', REVIEW_REQUIRED: 'Review required', PAID: 'Paid', REJECTED: 'Rejected', REFUNDED: 'Refunded', EXPIRED: 'Expired', CANCELLED: 'Cancelled' };
const TONE: Record<string, 'green' | 'amber' | 'red' | 'neutral' | 'blue'> = { PENDING_PAYMENT: 'neutral', SCREENSHOT_RECEIVED: 'amber', REVIEW_REQUIRED: 'amber', PAID: 'green', REJECTED: 'red', REFUNDED: 'neutral', EXPIRED: 'neutral', CANCELLED: 'neutral' };
const FLAG: Record<string, string> = { amount_mismatch: 'Amount on the screenshot is not the fee', amount_missing: 'No amount could be read', utr_missing: 'No UTR could be read', utr_format: 'UTR is not 12 digits', utr_already_used: 'This UTR is already on another payment', utr_differs_from_patient: 'UTR differs from what the patient typed',
  payee_mismatch: 'Payee on the screenshot is not the clinic\'s payee', status_not_success: 'The screenshot does not say the payment succeeded', time_missing: 'No payment time could be read', time_outside_window: 'Payment time is outside the booking window', low_confidence: 'The reader was not confident',
  duplicate_image: 'This picture was already used for another payment', edited_by_software: 'The picture carries photo-editing software marks', ai_suspects_edit: 'The reader suspects the picture was edited', not_a_payment_screenshot: 'Not a payment screenshot', ocr_unavailable: 'The picture could not be read automatically',
  provider_amount_mismatch: 'Provider amount is not the fee', paid_after_release: 'Money arrived after the held time was released' };
const flagText = (f: string) => FLAG[f] || (f.startsWith('ocr_error') ? 'The picture could not be read automatically' : f);

function PaymentSettings() {
  const { ws } = useWs(); const qc = useQueryClient(); const toast = useToast();
  const q = useQuery({ queryKey: ['sched', ws.id, 'pay-settings'], queryFn: () => api<PaySettings>(wsPath(ws.id, '/schedule/payments/settings')) });
  const [draft, setDraft] = useState<Record<string, string>>({});
  const save = useMutation({ mutationFn: (values: Record<string, string>) => api<PaySettings>(wsPath(ws.id, '/schedule/payments/settings'), { method: 'PUT', body: { values } }), onSuccess: () => { setDraft({}); void qc.invalidateQueries({ queryKey: ['sched', ws.id] }); toast('ok', 'Saved.'); }, onError: (e) => toast('bad', problem(e)) });
  if (q.isLoading) return <Card className="p-5"><SkeletonRows rows={3} /></Card>;
  if (q.isError) return <Card><ErrorState error={q.error} retry={() => q.refetch()} /></Card>;
  const s = q.data!; const v = (k: string, d: string) => (k in draft ? draft[k]! : d); const dirty = Object.keys(draft).length > 0;
  return (
    <Card className="space-y-4 p-5">
      <div className="flex flex-wrap items-center gap-3"><h2 className="text-base font-semibold">Payment settings</h2><Badge tone={s.open_to_patients ? 'green' : 'amber'} icon={s.open_to_patients ? <CheckCircle2 className="h-3.5 w-3.5" /> : <AlertTriangle className="h-3.5 w-3.5" />}>{s.open_to_patients ? 'Open to patients' : 'Closed to patients'}</Badge></div>
      {!s.open_to_patients && <ul className="list-disc pl-5 text-[13px] text-fg-2">{s.closed_because.map((r) => <li key={r}>Not open yet: {r}</li>)}</ul>}
      <p className="max-w-[70ch] text-[13px] text-fg-2">Patients are shown the payment QR only when ALL of these are set. The QR pays <b>{s.payee_name}</b>. Record the clinic's authorization only when the clinic has actually agreed to collect fees into that account.</p>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="flex items-center justify-between gap-3 rounded-lg border border-line px-3 py-2 text-[13.5px]"><span>Payments on</span><Switch checked={(v('payments_enabled', s.enabled ? 'on' : 'off')) === 'on'} label="Payments on" onChange={(x) => setDraft({ ...draft, payments_enabled: x ? 'on' : 'off' })} /></label>
        <label className="flex items-center justify-between gap-3 rounded-lg border border-line px-3 py-2 text-[13.5px]"><span className="inline-flex items-center gap-1.5"><ShieldCheck className="h-4 w-4" />Clinic authorized this payee account</span><Switch checked={(v('payee_authorized', s.payee_authorized ? 'on' : 'off')) === 'on'} label="Clinic authorized this payee account" onChange={(x) => setDraft({ ...draft, payee_authorized: x ? 'on' : 'off' })} /></label>
        <Field label="Appointment fee (₹)" hint="A whole number. There is no default: patients are never asked to pay until you set it."><Input inputMode="numeric" value={v('consultation_fee_inr', s.fee_inr)} onChange={(e) => setDraft({ ...draft, consultation_fee_inr: e.target.value.replace(/\D/g, '') })} /></Field>
        <Field label="Minutes to pay before the held time is released"><Input inputMode="numeric" value={v('payment_expiry_minutes', String(s.expiry_minutes))} onChange={(e) => setDraft({ ...draft, payment_expiry_minutes: e.target.value.replace(/\D/g, '') })} /></Field>
        <Field label="Minutes the time stays held while staff check a screenshot"><Input inputMode="numeric" value={v('payment_review_hold_minutes', String(s.review_hold_minutes))} onChange={(e) => setDraft({ ...draft, payment_review_hold_minutes: e.target.value.replace(/\D/g, '') })} /></Field>
        <Field label="Who at the clinic authorized it, and how" hint="Required when you switch the authorization on (for example: owner, in writing, date)."><Textarea value={v('payee_authorization_note', s.payee_authorization_note)} onChange={(e) => setDraft({ ...draft, payee_authorization_note: e.target.value })} /></Field>
      </div>
      <div className="flex items-center gap-3"><Button variant="primary" disabled={!dirty} loading={save.isPending} onClick={() => save.mutate(draft)}>Save payment settings</Button><span className="text-[12.5px] text-fg-2">{s.provider_webhook ? 'A payment provider is connected.' : 'No bank or payment provider is connected: every payment is confirmed by a person.'}</span></div>
    </Card>
  );
}

function ReviewDrawer({ id, onClose, admin }: { id: string | null; onClose: () => void; admin: boolean }) {
  const { ws } = useWs(); const qc = useQueryClient(); const toast = useToast();
  const q = useQuery({ queryKey: ['sched', ws.id, 'payment', id], enabled: !!id, queryFn: () => api<Detail>(wsPath(ws.id, `/schedule/payments/${id}`)) });
  const [amount, setAmount] = useState(''); const [utr, setUtr] = useState(''); const [ok, setOk] = useState(false); const [note, setNote] = useState(''); const [reason, setReason] = useState('');
  const [ask, setAsk] = useState<'reject' | 'refund' | null>(null);
  const done = () => { setAsk(null); void qc.invalidateQueries({ queryKey: ['sched', ws.id] }); };
  const act = useMutation({ mutationFn: (a: { path: string; body: unknown }) => api(wsPath(ws.id, `/schedule/payments/${id}/${a.path}`), { method: 'POST', body: a.body }), onSuccess: (_d, a) => { done(); toast('ok', a.path === 'approve' ? 'Payment recorded as paid and the appointment is confirmed.' : a.path === 'reject' ? 'Rejected.' : 'Refund recorded. Now send the money back from the bank / UPI app.'); }, onError: (e) => { setAsk(null); toast('bad', problem(e)); } });
  const p = q.data?.payment; const a = q.data?.appointment;
  const canApprove = p && ['PENDING_PAYMENT', 'SCREENSHOT_RECEIVED', 'REVIEW_REQUIRED', 'REJECTED'].includes(p.status) && a?.status !== 'Cancelled';
  return (
    <Drawer open={!!id} onClose={onClose} title={p ? `${p.booking_reference} · ₹${p.amount_inr}` : 'Payment'} subtitle={p ? LABEL[p.status] : ''} width={620}>
      {q.isLoading ? <SkeletonRows rows={6} /> : q.isError ? <ErrorState error={q.error} retry={() => q.refetch()} /> : p && (
        <div className="space-y-5 p-5 text-[13.5px]">
          <div className="rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-[12.5px] text-warn">A screenshot is not proof of payment. Mark it paid only after you see the money (with the same UTR) in the clinic's bank account.</div>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1.5"><span className="text-fg-2">Patient</span><span>{p.patient.name} · {p.patient.phone}</span><span className="text-fg-2">Appointment</span><span>{a ? `${a.date} ${a.start_time}${a.doctor_name ? ` · ${a.doctor_name}` : ''} (${a.status})` : '—'}</span><span className="text-fg-2">Booked from</span><span className="capitalize">{p.channel}</span><span className="text-fg-2">Pay before</span><span>{when(p.expires_at)}</span></div>
          {p.refund_due && <div role="alert" className="rounded-lg border border-bad/30 bg-bad/10 px-3 py-2 text-bad">This paid booking was cancelled: a refund is due. {admin ? 'Record it below.' : 'Ask an admin to record the refund.'}</div>}
          {p.screenshots > 0 && <div><div className="label mb-1.5">Screenshot ({p.screenshots})</div><a href={`/api/w/${encodeURIComponent(ws.id)}/schedule/payments/${p.id}/screenshot`} target="_blank" rel="noreferrer"><img src={`/api/w/${encodeURIComponent(ws.id)}/schedule/payments/${p.id}/screenshot`} alt="Payment screenshot sent by the patient" className="max-h-80 rounded-lg border border-line object-contain" /></a></div>}
          <div><div className="label mb-1.5">What the reader found (advisory only)</div>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1.5"><span className="text-fg-2">Amount</span><span>{p.extracted.amount_inr ? `₹${p.extracted.amount_inr}` : '—'} <span className="text-fg-2">(fee ₹{p.amount_inr})</span></span><span className="text-fg-2">UTR</span><span className="font-mono">{p.extracted.utr || '—'}{p.utr && p.utr !== p.extracted.utr ? ` (typed: ${p.utr})` : ''}</span><span className="text-fg-2">Time</span><span>{when(p.extracted.txn_at)}</span><span className="text-fg-2">Payee</span><span>{p.extracted.payee || '—'}</span><span className="text-fg-2">Payer</span><span>{p.extracted.payer || '—'}</span><span className="text-fg-2">Status shown</span><span>{p.extracted.status || '—'}</span></div>
            {p.flags.length ? <ul className="mt-2 space-y-1">{p.flags.map((f) => <li key={f} className="flex items-start gap-1.5 text-bad"><AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />{flagText(f)}</li>)}</ul> : p.screenshots > 0 ? <p className="mt-2 text-ok">No automatic check was triggered. That still does not mean it is paid.</p> : null}
          </div>
          {p.status === 'PAID' && <div className="grid grid-cols-2 gap-x-4 gap-y-1.5"><span className="text-fg-2">Verified by</span><span>{p.reviewed_by} · {when(p.reviewed_at)}</span><span className="text-fg-2">Method</span><span>{p.verification_method === 'provider_webhook' ? 'Payment provider' : 'Staff, from the bank statement'}</span><span className="text-fg-2">Received</span><span>₹{p.received_inr} · UTR <span className="font-mono">{p.utr}</span></span></div>}
          {canApprove && (
            <div className="space-y-3 rounded-lg border border-line p-3"><div className="label">Confirm the money arrived</div>
              <div className="grid gap-3 sm:grid-cols-2"><Field label="Amount received (₹)"><Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder={p.amount_inr} /></Field><Field label="UTR from the bank statement (12 digits)"><Input inputMode="numeric" value={utr} onChange={(e) => setUtr(e.target.value)} placeholder={p.extracted.utr || p.utr || ''} /></Field></div>
              <Field label="Note (optional)"><Input value={note} onChange={(e) => setNote(e.target.value)} /></Field>
              <label className="flex items-start gap-2 text-[13px]"><input type="checkbox" className="mt-1" checked={ok} onChange={(e) => setOk(e.target.checked)} />I have seen this amount and UTR in the clinic's bank account.</label>
              <div className="flex gap-2"><Button variant="primary" disabled={!ok || !amount || !utr} loading={act.isPending} onClick={() => act.mutate({ path: 'approve', body: { received_inr: amount, utr, confirm_receipt: ok, ...(note ? { note } : {}) } })}>Mark paid and confirm appointment</Button>{['SCREENSHOT_RECEIVED', 'REVIEW_REQUIRED', 'PENDING_PAYMENT'].includes(p.status) && <Button variant="danger" onClick={() => { setReason(''); setAsk('reject'); }}>Reject</Button>}</div>
            </div>
          )}
          {p.status === 'PAID' && (admin ? <Button variant="danger" onClick={() => { setReason(''); setAsk('refund'); }}>Record a refund (cancels the appointment)</Button> : <p className="text-[12.5px] text-fg-2">Only an admin can record a refund.</p>)}
          <div><div className="label mb-1.5">History</div><ol className="space-y-1.5 border-l border-line pl-3 text-[12.5px]">{q.data!.events.map((e, i) => <li key={i}><span className="text-fg-2">{when(e.at)}</span> · <b>{e.action.replace(/_/g, ' ')}</b>{e.to && e.to !== e.from ? ` → ${LABEL[e.to] || e.to}` : ''} · {e.actor}{e.outcome !== 'ok' ? ` · ${e.outcome}` : ''}</li>)}</ol></div>
        </div>
      )}
      <Confirm open={!!ask} title={ask === 'refund' ? 'Record a refund?' : 'Reject this payment?'} body={<div className="space-y-2"><p>{ask === 'refund' ? 'The appointment will be cancelled (kept in history). You then send the money back yourself.' : 'The held time stays until it expires; the patient can send a clearer screenshot.'}</p><Field label="Reason"><Input value={reason} onChange={(e) => setReason(e.target.value)} /></Field></div>} confirmLabel={ask === 'refund' ? 'Record refund' : 'Reject'} danger busy={act.isPending} onClose={() => setAsk(null)} onConfirm={() => ask && reason.trim().length >= 3 && act.mutate({ path: ask, body: { reason } })} />
    </Drawer>
  );
}

const CARDS: Array<{ key: string; label: string; tone: string; filter: string }> = [
  { key: 'SCREENSHOT_RECEIVED', label: 'Awaiting verification', tone: 'text-warn', filter: 'SCREENSHOT_RECEIVED' },
  { key: 'REVIEW_REQUIRED', label: 'Review required', tone: 'text-warn', filter: 'REVIEW_REQUIRED' },
  { key: 'REJECTED', label: 'Rejected', tone: 'text-bad', filter: 'REJECTED' },
  { key: 'CANCELLED', label: 'Cancelled', tone: '', filter: 'CANCELLED' },
];
const FILTER_OPTIONS = [{ v: 'ALL', l: 'All' }, { v: 'PENDING_PAYMENT', l: 'Pending' }, { v: 'SCREENSHOT_RECEIVED', l: 'Screenshot received' }, { v: 'REVIEW_REQUIRED', l: 'Review required' }, { v: 'PAID', l: 'Paid' }, { v: 'REJECTED', l: 'Rejected' }, { v: 'CANCELLED', l: 'Cancelled' }];

function Stat({ label, value, tone, onClick, active }: { label: string; value: string; tone?: string; onClick?: () => void; active?: boolean }) {
  return <button type="button" onClick={onClick} aria-pressed={active} className={cn('bg-surface px-5 py-3.5 text-left transition-colors hover:bg-surface-2', active && 'bg-surface-2')}><div className={cn('num-display text-[28px] leading-none', tone)}>{value}</div><div className="label mt-1.5">{label}</div></button>;
}

export default function PaymentManagement() {
  const { ws, me } = useWs(); const admin = me.user.role === 'admin'; const [filter, setFilter] = useState('ALL'); const [text, setText] = useState(''); const dq = useDebounced(text); const [open, setOpen] = useState<string | null>(null);
  const blocked = !!me.user.clinician && !admin;   // a doctor's own login: payment records are front desk / admin only (the server refuses it too)
  const q = useQuery({ queryKey: ['sched', ws.id, 'payments', filter, dq], enabled: !blocked, queryFn: () => api<ListData>(wsPath(ws.id, `/schedule/payments?limit=300${filter === 'ALL' ? '' : `&status=${filter}`}${dq ? `&q=${encodeURIComponent(dq)}` : ''}`)), refetchInterval: 20000 });
  const all = useQuery({ queryKey: ['sched', ws.id, 'payments-totals'], enabled: !blocked, queryFn: () => api<ListData>(wsPath(ws.id, '/schedule/payments?limit=1')), refetchInterval: 20000 });
  const counts = all.data?.counts || {};
  if (blocked) return <Page title="Payment Management" subtitle="Payment records are limited to the front desk and admins."><Card className="p-5 text-[13.5px] text-fg-2">Your login is a doctor's login, so payment records are not shown. Ask the front desk or an admin.</Card></Page>;
  return (
    <Page wide title="Payment Management" subtitle="UPI payments for appointments. A screenshot is not proof of payment: mark a payment paid only after the money has reached the clinic's bank account.">
      <div className="space-y-5">
        <Card className="overflow-hidden"><div className="grid grid-cols-2 gap-px overflow-hidden bg-line sm:grid-cols-3 lg:grid-cols-5">
          <Stat label={`Total collected${all.data ? ` (${all.data.totals.collected_count} paid)` : ''}`} value={all.data ? `₹${all.data.totals.collected_inr}` : '–'} tone="text-ok" onClick={() => setFilter('PAID')} active={filter === 'PAID'} />
          {CARDS.map((c) => <Stat key={c.key} label={c.label} value={String(counts[c.key] || 0)} tone={counts[c.key] ? c.tone : undefined} onClick={() => setFilter(c.filter)} active={filter === c.filter} />)}
        </div></Card>
        {all.data && all.data.refund_due > 0 && <div role="alert" className="rounded-lg border border-bad/30 bg-bad/10 px-3 py-2 text-[13px] text-bad">{all.data.refund_due} paid booking{all.data.refund_due === 1 ? ' was' : 's were'} cancelled: a refund is due.</div>}
        <div className="flex flex-wrap items-center gap-3">
          <Segmented variant="tabs" value={filter} onChange={setFilter} options={FILTER_OPTIONS.map((f) => ({ value: f.v, label: f.l, ...(f.v === 'ALL' ? {} : { count: counts[f.v] || 0 }) }))} />
          <div className="ml-auto w-full max-w-xs sm:w-72"><Input placeholder="Search reference, name, number or UTR" value={text} onChange={(e) => setText(e.target.value)} aria-label="Search payments" /></div>
        </div>
        {q.isLoading ? <Card><SkeletonRows rows={6} /></Card> : q.isError ? <Card><ErrorState error={q.error} retry={() => q.refetch()} /></Card> : (
          <Card className="overflow-hidden"><div className="max-h-[calc(100vh-26rem)] min-h-40 overflow-auto"><table className="w-full min-w-[980px] border-separate border-spacing-0 text-[13px]">
            <thead><tr>{['Booking reference', 'Patient', 'Contact', 'Appointment', 'Amount', 'Payment status', 'UTR', 'Submitted', 'Actions'].map((x) => <th key={x} className="sticky top-0 z-[2] whitespace-nowrap border-b border-line-2 bg-[rgb(235_242_238)] px-3 py-2.5 text-left text-[12.5px] font-semibold">{x}</th>)}</tr></thead>
            <tbody>{q.data!.rows.map((r) => (
              <tr key={r.id} className="cursor-pointer even:bg-surface-2/60 hover:bg-surface-2" onClick={() => setOpen(r.id)}>
                <td className="border-b border-line/60 px-3 py-2 font-mono text-[12px]">{r.booking_reference}</td><td className="border-b border-line/60 px-3 py-2">{r.patient.name}</td><td className="whitespace-nowrap border-b border-line/60 px-3 py-2">{r.patient.phone}</td>
                <td className="whitespace-nowrap border-b border-line/60 px-3 py-2">{r.appointment ? `${r.appointment.date} · ${r.appointment.start_time}` : '—'}{r.appointment_status && r.appointment_status !== 'Pending confirmation' ? <div className="text-[12px] text-fg-2">{r.appointment_status}</div> : null}</td>
                <td className="border-b border-line/60 px-3 py-2">₹{r.amount_inr}</td>
                <td className="border-b border-line/60 px-3 py-2"><Badge tone={TONE[r.status] || 'neutral'}>{LABEL[r.status] || r.status}</Badge>{r.flags.length > 0 && <span className="ml-1.5 text-[12px] text-bad">{r.flags.length} flag{r.flags.length === 1 ? '' : 's'}</span>}{r.refund_due && <span className="ml-1.5 text-[12px] font-semibold text-bad">refund due</span>}</td>
                <td className="border-b border-line/60 px-3 py-2 font-mono text-[12px]">{r.utr || '—'}</td><td className="whitespace-nowrap border-b border-line/60 px-3 py-2 text-fg-2">{when(r.submitted_at)}</td>
                <td className="border-b border-line/60 px-3 py-2"><Button size="sm" onClick={(e) => { e.stopPropagation(); setOpen(r.id); }}>{['SCREENSHOT_RECEIVED', 'REVIEW_REQUIRED', 'PENDING_PAYMENT', 'REJECTED'].includes(r.status) ? 'Review' : 'View'}</Button></td>
              </tr>))}</tbody>
          </table></div>{!q.data!.rows.length && <p className="p-5 text-[13px] text-fg-2">No payments {filter === 'ALL' && !dq ? 'yet.' : 'match this filter.'}</p>}</Card>
        )}
        {admin && <PaymentSettings />}
      </div>
      <ReviewDrawer id={open} onClose={() => setOpen(null)} admin={admin} />
    </Page>
  );
}
