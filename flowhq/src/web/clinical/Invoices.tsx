// Invoices and payments. The server decides every total (integer paise); the screen only previews them. A saved invoice is final:
// a mistake is corrected by voiding it (with a reason) and issuing a new one. Payments are added, never edited.
import { useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Printer, Receipt, Search, Trash2 } from 'lucide-react';
import { PAYMENT_METHODS, type Invoice, type InvoiceInput, type PaymentMethod, type PatientProfile } from '@core/clinical';
import { computeTotals, parseRupees, type PaymentStatus } from '@core/money';
import { api, ApiError, ws as wsPath } from '../lib/api';
import { useWs } from '../lib/workspace';
import { cn } from '../lib/cn';
import { Page } from '../components/layout/Shell';
import { Button, Card, CardHeader, Input, Segmented, Select, Textarea } from '../components/ui/primitives';
import { EmptyState, ErrorState, Modal, SkeletonRows, useToast } from '../components/ui/feedback';
import { Field, PatientPicker, PaymentBadge, errText, fdate, newKey, rs, useClinic, useDebounced, useToday, useUnsavedGuard } from './common';
import { DoctorFilter, useDoctorFilter } from './DoctorFilter';

export default function Invoices() {
  const { invoiceNo } = useParams();
  return invoiceNo === 'new' ? <Editor /> : invoiceNo ? <Detail no={invoiceNo} /> : <List />;
}

function List() {
  const { ws } = useWs(); const nav = useNavigate();
  const [q, setQ] = useState(''); const dq = useDebounced(q); const [status, setStatus] = useState<'all' | PaymentStatus>('all'); const doc = useDoctorFilter();
  const list = useQuery({ queryKey: ['invoices', ws.id, dq, status, doc.key], queryFn: () => api<Invoice[]>(wsPath(ws.id, `/invoices?q=${encodeURIComponent(dq)}${status !== 'all' ? `&status=${status}` : ''}${doc.qs}`)) });
  const due = (list.data || []).reduce((t, i) => t + i.balancePaise, 0);
  return (
    <Page title="Invoices & payments" subtitle={list.data ? `${list.data.length} invoice${list.data.length === 1 ? '' : 's'} · ${rs(due)} outstanding` : ' '} wide actions={<Link to={`/w/${ws.id}/invoices/new`}><Button variant="primary" icon={<Plus className="h-4 w-4" />}>New invoice</Button></Link>}>
      <div className="mb-3 flex flex-wrap items-center gap-2.5">
        <div className="w-full max-w-xs"><Input icon={<Search className="h-4 w-4" />} placeholder="Search invoice no., patient or ID" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search invoices" /></div>
        <DoctorFilter f={doc} />
        <Segmented value={status} onChange={setStatus} options={[{ value: 'all', label: 'All' }, { value: 'unpaid', label: 'Unpaid' }, { value: 'partial', label: 'Part paid' }, { value: 'paid', label: 'Paid' }, { value: 'void', label: 'Void' }]} />
      </div>
      <Card className="overflow-hidden">
        {list.isLoading ? <SkeletonRows rows={8} /> : list.error ? <ErrorState error={list.error} retry={() => list.refetch()} /> : !list.data?.length ? <EmptyState icon={<Receipt className="h-5 w-5" />} title="No invoices found" body={q || status !== 'all' ? 'Try clearing the filters.' : 'Create the first invoice for a registered patient.'} /> : (
          <div className="overflow-x-auto"><table className="w-full min-w-[820px] text-left text-[13px]">
            <thead><tr className="border-b border-line bg-sage/40 text-[11.5px] uppercase tracking-wide text-fg-2"><th className="px-4 py-2.5 font-semibold">Invoice</th><th className="px-3 py-2.5 font-semibold">Date</th><th className="px-3 py-2.5 font-semibold">Patient</th><th className="px-3 py-2.5 text-right font-semibold">Total</th><th className="px-3 py-2.5 text-right font-semibold">Paid</th><th className="px-3 py-2.5 text-right font-semibold">Balance</th><th className="px-3 py-2.5 font-semibold">Status</th></tr></thead>
            <tbody>{list.data.map((i) => (
              <tr key={i.invoiceNo} onClick={() => nav(`/w/${ws.id}/invoices/${i.invoiceNo}`)} className="cursor-pointer border-b border-line/60 last:border-0 hover:bg-sage/30">
                <td className="px-4 py-2.5 font-mono text-[12px]">{i.invoiceNo}</td><td className="whitespace-nowrap px-3 py-2.5">{fdate(i.date)}</td>
                <td className="px-3 py-2.5"><span className="font-medium">{i.patientName || '—'}</span><span className="block text-[12px] text-muted">{i.patientId}</span></td>
                <td className="num px-3 py-2.5 text-right">{rs(i.totalPaise)}</td><td className="num px-3 py-2.5 text-right">{rs(i.paidPaise)}</td><td className={cn('num px-3 py-2.5 text-right font-medium', i.balancePaise > 0 && 'text-bad')}>{rs(i.balancePaise)}</td><td className="px-3 py-2.5"><PaymentBadge status={i.paymentStatus} /></td>
              </tr>))}</tbody>
          </table></div>
        )}
      </Card>
    </Page>
  );
}

// ---------------------------------------------------------------- editor
type Line = { id: number; description: string; qty: string; price: string };
const emptyLine = (id: number): Line => ({ id, description: '', qty: '1', price: '' });

function Editor() {
  const { ws } = useWs(); const nav = useNavigate(); const qc = useQueryClient(); const toast = useToast(); const today = useToday(); const [sp] = useSearchParams();
  const clinic = useClinic(); const tax = clinic.data?.tax || null;
  const preset = sp.get('patient');
  const presetQ = useQuery({ queryKey: ['patient', ws.id, preset], queryFn: () => api<PatientProfile>(wsPath(ws.id, `/patients/${preset}`)), enabled: !!preset });
  const [patient, setPatient] = useState<{ id: string; name: string } | null>(null);
  const [date, setDate] = useState(today); const [lines, setLines] = useState<Line[]>([emptyLine(1)]); const nextId = useRef(2);
  const [discount, setDiscount] = useState(''); const [applyTax, setApplyTax] = useState(false); const [notes, setNotes] = useState('');
  const [payNow, setPayNow] = useState(''); const [method, setMethod] = useState<PaymentMethod>('Cash'); const [ref, setRef] = useState('');
  const [errs, setErrs] = useState<Record<string, string>>({}); const [formErr, setFormErr] = useState('');
  const key = useRef(newKey());                       // one key per form: sending the same form twice can only ever make one invoice
  if (preset && presetQ.data && !patient) setPatient({ id: presetQ.data.patient.patientId, name: presetQ.data.patient.name });
  const dirty = lines.some((l) => l.description || l.price) || !!discount || !!notes || !!payNow;
  useUnsavedGuard(dirty);

  // live preview, from the same function the server uses
  const calc = useMemo(() => {
    const e: Record<string, string> = {}; const ok: Array<{ description: string; qty: number; unitPaise: number }> = [];
    lines.forEach((l, i) => {
      const empty = !l.description.trim() && !l.price.trim() && (l.qty === '1' || !l.qty);
      if (empty && lines.length > 1) return;
      const qty = /^\d{1,4}$/.test(l.qty) ? Number(l.qty) : NaN; const price = l.price.trim() === '' ? NaN : parseRupees(l.price);
      if (!l.description.trim()) e[`d${l.id}`] = 'Describe the service';
      if (!(qty >= 1)) e[`q${l.id}`] = 'Whole number, 1 or more';
      if (price === null || Number.isNaN(price)) e[`p${l.id}`] = 'Enter an amount like 600 or 600.50';
      if (l.description.trim() && qty >= 1 && price !== null && !Number.isNaN(price)) ok.push({ description: l.description.trim(), qty, unitPaise: price });
      void i;
    });
    const d = discount.trim() === '' ? 0 : parseRupees(discount);
    if (d === null) e.discount = 'Enter an amount like 100 or 100.50';
    const rate = applyTax && tax ? Math.round(tax.ratePercent * 100) : 0;
    const t = computeTotals(ok, d ?? 0, rate);
    if (d !== null && d > t.subtotalPaise) e.discount = 'Discount cannot be more than the subtotal';
    const pay = payNow.trim() === '' ? 0 : parseRupees(payNow);
    if (pay === null) e.pay = 'Enter an amount like 500 or 500.50'; else if (pay > t.totalPaise) e.pay = 'More than the invoice total';
    if (t.subtotalPaise <= 0 && !Object.keys(e).length) e.lines = 'The invoice total must be more than zero';
    return { e, t, d: d ?? 0, pay: pay ?? 0, valid: ok.length, rows: lines.length };
  }, [lines, discount, applyTax, tax, payNow]);

  const save = useMutation({
    mutationFn: () => {
      const body: InvoiceInput = { patientId: patient!.id, date, lines: calc.t.lines.map((l) => ({ description: l.description, qty: l.qty, unitPaise: l.unitPaise })), discountPaise: calc.d, applyTax: applyTax && !!tax, notes, idemKey: key.current,
        ...(calc.pay > 0 ? { payment: { amountPaise: calc.pay, method, reference: ref, paidOn: today } } : {}) };
      return api<{ invoice: Invoice; duplicate: boolean; paymentError?: string }>(wsPath(ws.id, '/invoices'), { method: 'POST', body });
    },
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['invoices', ws.id] }); qc.invalidateQueries({ queryKey: ['patient', ws.id] }); qc.invalidateQueries({ queryKey: ['register', ws.id] });
      if (r.paymentError) toast('bad', `Invoice ${r.invoice.invoiceNo} saved, but the payment was not recorded: ${r.paymentError}`); else toast('ok', `Invoice ${r.invoice.invoiceNo} saved`);
      nav(`/w/${ws.id}/invoices/${r.invoice.invoiceNo}`, { replace: true });
    },
    onError: (e) => setFormErr(errText(e)),
  });
  const submit = () => {
    setFormErr('');
    if (!patient) { setFormErr('Choose the patient first'); return; }
    if (Object.keys(calc.e).length) { setErrs(calc.e); setFormErr('Please fix the highlighted fields'); return; }
    setErrs({}); save.mutate();
  };
  const setLine = (id: number, p: Partial<Line>) => setLines((l) => l.map((x) => (x.id === id ? { ...x, ...p } : x)));
  const shown = (k: string) => errs[k];

  return (
    <Page title="New invoice" subtitle="Saved invoices are final. A mistake is corrected by voiding the invoice and issuing a new one." wide actions={<><Link to={`/w/${ws.id}/invoices`}><Button variant="ghost">Cancel</Button></Link><Button variant="primary" loading={save.isPending} onClick={submit}>Save invoice</Button></>}>
      <div className="grid gap-5 lg:grid-cols-[1fr_340px]">
        <Card className="p-5">
          <div className="grid gap-3.5 sm:grid-cols-[1fr_180px]">
            <Field label="Patient" required><PatientPicker value={patient} onChange={setPatient} /></Field>
            <Field label="Invoice date"><Input type="date" value={date} max={today} onChange={(e) => setDate(e.target.value)} /></Field>
          </div>
          <div className="mt-5">
            <div className="label mb-1.5">Services</div>
            <div className="hidden grid-cols-[1fr_72px_120px_110px_32px] gap-2 px-0.5 pb-1 text-[11.5px] font-medium uppercase tracking-wide text-muted sm:grid"><span>Description</span><span>Qty</span><span>Unit price (₹)</span><span className="text-right">Amount</span><span /></div>
            <div className="space-y-2">
              {lines.map((l) => {
                const qty = Number(l.qty); const price = parseRupees(l.price); const amt = qty >= 1 && price !== null ? qty * price : null;
                return (
                  <div key={l.id} className="grid grid-cols-2 items-start gap-2 sm:grid-cols-[1fr_72px_120px_110px_32px]">
                    <div className="col-span-2 sm:col-span-1"><Input value={l.description} onChange={(e) => setLine(l.id, { description: e.target.value })} placeholder="e.g. Physiotherapy session" maxLength={200} aria-label="Service description" aria-invalid={!!shown(`d${l.id}`)} />{shown(`d${l.id}`) && <span className="text-[12px] text-bad">{shown(`d${l.id}`)}</span>}</div>
                    <div><Input value={l.qty} onChange={(e) => setLine(l.id, { qty: e.target.value })} inputMode="numeric" aria-label="Quantity or sessions" aria-invalid={!!shown(`q${l.id}`)} />{shown(`q${l.id}`) && <span className="text-[12px] text-bad">{shown(`q${l.id}`)}</span>}</div>
                    <div><Input value={l.price} onChange={(e) => setLine(l.id, { price: e.target.value })} inputMode="decimal" placeholder="0.00" aria-label="Unit price in rupees" aria-invalid={!!shown(`p${l.id}`)} />{shown(`p${l.id}`) && <span className="text-[12px] text-bad">{shown(`p${l.id}`)}</span>}</div>
                    <div className="num flex h-9 items-center justify-end text-sm">{amt === null ? '—' : rs(amt)}</div>
                    <Button variant="ghost" size="sm" disabled={lines.length === 1} aria-label="Remove this service" onClick={() => setLines((x) => x.filter((y) => y.id !== l.id))}><Trash2 className="h-4 w-4" /></Button>
                  </div>
                );
              })}
            </div>
            {shown('lines') && <p className="mt-1 text-[12.5px] text-bad">{shown('lines')}</p>}
            <Button variant="ghost" size="sm" className="mt-2" icon={<Plus className="h-4 w-4" />} disabled={lines.length >= 30} onClick={() => setLines((x) => [...x, emptyLine(nextId.current++)])}>Add another service</Button>
          </div>
          <div className="mt-5 grid gap-3.5 sm:grid-cols-2">
            <Field label="Discount (₹)" error={shown('discount')}><Input value={discount} onChange={(e) => setDiscount(e.target.value)} inputMode="decimal" placeholder="0.00" /></Field>
            {tax ? <label className="flex items-end gap-2 pb-2 text-sm"><input type="checkbox" checked={applyTax} onChange={(e) => setApplyTax(e.target.checked)} className="h-4 w-4 accent-[rgb(var(--blue))]" /> Add {tax.label} ({tax.ratePercent}%)</label> : <p className="self-end pb-2 text-[12.5px] text-muted">No tax is configured for this clinic, so none is added.</p>}
            <Field label="Notes (printed on the invoice)" className="sm:col-span-2"><Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} maxLength={1000} /></Field>
          </div>
        </Card>
        <div className="space-y-4">
          <Card>
            <CardHeader title="Total" subtitle="Preview · the saved invoice is calculated by the server" />
            <dl className="space-y-1.5 px-5 py-4 text-sm">
              <div className="flex justify-between"><dt className="text-fg-2">Subtotal</dt><dd className="num">{rs(calc.t.subtotalPaise)}</dd></div>
              {calc.d > 0 && <div className="flex justify-between"><dt className="text-fg-2">Discount</dt><dd className="num">− {rs(Math.min(calc.d, calc.t.subtotalPaise))}</dd></div>}
              {calc.t.taxPaise > 0 && tax && <div className="flex justify-between"><dt className="text-fg-2">{tax.label} ({tax.ratePercent}%)</dt><dd className="num">{rs(calc.t.taxPaise)}</dd></div>}
              <div className="flex justify-between border-t border-line pt-2 text-base font-semibold"><dt>Total</dt><dd className="num">{rs(calc.t.totalPaise)}</dd></div>
              <div className="flex justify-between text-fg-2"><dt>Received now</dt><dd className="num">{rs(calc.pay)}</dd></div>
              <div className="flex justify-between font-medium"><dt>Balance due</dt><dd className="num">{rs(Math.max(0, calc.t.totalPaise - calc.pay))}</dd></div>
            </dl>
          </Card>
          <Card>
            <CardHeader title="Payment received now" subtitle="Optional. Leave empty to record payments later." />
            <div className="space-y-3 px-5 py-4">
              <Field label="Amount (₹)" error={shown('pay')}><Input value={payNow} onChange={(e) => setPayNow(e.target.value)} inputMode="decimal" placeholder="0.00" /></Field>
              <Field label="Method"><Select value={method} onChange={(e) => setMethod(e.target.value as PaymentMethod)}>{PAYMENT_METHODS.map((m) => <option key={m}>{m}</option>)}</Select></Field>
              <Field label="Reference" hint="UPI / cheque / transaction no."><Input value={ref} onChange={(e) => setRef(e.target.value)} maxLength={120} /></Field>
            </div>
          </Card>
          {formErr && <p className="rounded-lg border border-bad/40 bg-bad/10 px-3 py-2 text-[13px] text-bad" role="alert">{formErr}</p>}
        </div>
      </div>
    </Page>
  );
}

// ---------------------------------------------------------------- one invoice: view, record payment, print, void
function Detail({ no }: { no: string }) {
  const { ws, isAdmin } = useWs(); const qc = useQueryClient(); const toast = useToast(); const today = useToday();
  const q = useQuery({ queryKey: ['invoice', ws.id, no], queryFn: () => api<Invoice>(wsPath(ws.id, `/invoices/${no}`)) });
  const [pay, setPay] = useState(false); const [void_, setVoid] = useState<{ kind: 'invoice' | 'payment'; id: string } | null>(null);
  const refresh = () => { qc.invalidateQueries({ queryKey: ['invoice', ws.id, no] }); qc.invalidateQueries({ queryKey: ['invoices', ws.id] }); qc.invalidateQueries({ queryKey: ['patient', ws.id] }); qc.invalidateQueries({ queryKey: ['register', ws.id] }); };
  if (q.isLoading) return <Page title={`Invoice ${no}`}><SkeletonRows rows={6} /></Page>;
  if (q.error || !q.data) return <Page title={`Invoice ${no}`}><ErrorState error={q.error || new Error('Not found')} retry={() => q.refetch()} /></Page>;
  const i = q.data;
  return (
    <Page title={`Invoice ${i.invoiceNo}`} subtitle={<span className="flex flex-wrap items-center gap-2"><PaymentBadge status={i.paymentStatus} /><span>{fdate(i.date)} ·{' '}<Link className="underline" to={`/w/${ws.id}/patients/${i.patientId}`}>{i.patientName || i.patientId}</Link></span></span>}
      actions={<><Link to={`/w/${ws.id}/invoices`}><Button variant="ghost">All invoices</Button></Link>
        <Button icon={<Printer className="h-4 w-4" />} onClick={() => window.open(`/w/${ws.id}/print/invoice/${i.invoiceNo}`, '_blank', 'noopener')}>Print invoice</Button>
        {i.status === 'issued' && i.balancePaise > 0 && <Button variant="primary" onClick={() => setPay(true)}>Record payment</Button>}</>}>
      <div className="grid gap-5 lg:grid-cols-[1fr_340px]">
        <Card className="overflow-hidden">
          <table className="w-full text-[13px]"><thead><tr className="border-b border-line bg-sage/40 text-[11.5px] uppercase tracking-wide text-fg-2"><th className="px-4 py-2.5 text-left font-semibold">Service</th><th className="px-3 py-2.5 text-right font-semibold">Qty</th><th className="px-3 py-2.5 text-right font-semibold">Unit price</th><th className="px-4 py-2.5 text-right font-semibold">Amount</th></tr></thead>
            <tbody>{i.lines.map((l) => <tr key={l.lineNo} className="border-b border-line/60"><td className="px-4 py-2.5">{l.description}</td><td className="num px-3 py-2.5 text-right">{l.qty}</td><td className="num px-3 py-2.5 text-right">{rs(l.unitPaise)}</td><td className="num px-4 py-2.5 text-right">{rs(l.totalPaise)}</td></tr>)}</tbody></table>
          {i.notes && <p className="border-t border-line px-4 py-3 text-[13px] text-fg-2"><b className="font-medium text-fg">Notes:</b> {i.notes}</p>}
        </Card>
        <div className="space-y-4">
          <Card><dl className="space-y-1.5 px-5 py-4 text-sm">
            <div className="flex justify-between"><dt className="text-fg-2">Subtotal</dt><dd className="num">{rs(i.subtotalPaise)}</dd></div>
            {i.discountPaise > 0 && <div className="flex justify-between"><dt className="text-fg-2">Discount</dt><dd className="num">− {rs(i.discountPaise)}</dd></div>}
            {i.taxPaise > 0 && <div className="flex justify-between"><dt className="text-fg-2">{i.taxLabel} ({i.taxRateBp / 100}%)</dt><dd className="num">{rs(i.taxPaise)}</dd></div>}
            <div className="flex justify-between border-t border-line pt-2 text-base font-semibold"><dt>Total</dt><dd className="num">{rs(i.totalPaise)}</dd></div>
            <div className="flex justify-between text-fg-2"><dt>Paid</dt><dd className="num">{rs(i.paidPaise)}</dd></div>
            <div className={cn('flex justify-between font-medium', i.balancePaise > 0 && 'text-bad')}><dt>Balance due</dt><dd className="num">{rs(i.balancePaise)}</dd></div>
          </dl></Card>
          <Card><CardHeader title="Payments" />
            <div className="px-5 py-3">{i.payments.length ? <ul className="divide-y divide-line/60 text-[13px]">{i.payments.map((p) => (
              <li key={p.paymentId} className={cn('flex items-start justify-between gap-2 py-2', p.voided && 'text-muted')}>
                <div><div className={cn(p.voided && 'line-through')}>{fdate(p.paidOn)} · {p.method}{p.reference ? ` · ${p.reference}` : ''}</div><div className="text-[11.5px] text-muted">{p.paymentId} · by {p.createdBy}{p.voided ? ` · voided: ${p.voidReason}` : ''}</div></div>
                <div className="text-right"><div className={cn('num', p.voided && 'line-through')}>{rs(p.amountPaise)}</div>{isAdmin && !p.voided && i.status === 'issued' && <button className="text-[11.5px] text-muted underline hover:text-bad" onClick={() => setVoid({ kind: 'payment', id: p.paymentId })}>Void</button>}</div>
              </li>))}</ul> : <p className="text-sm text-fg-2">No payments recorded.</p>}</div></Card>
          {isAdmin && i.status === 'issued' && <Button variant="danger" className="w-full" onClick={() => setVoid({ kind: 'invoice', id: i.invoiceNo })}>Void this invoice</Button>}
          {i.status === 'void' && <p className="rounded-lg border border-line bg-surface-2 px-3 py-2 text-[13px]">Voided: {i.voidReason}</p>}
        </div>
      </div>
      <PayDialog open={pay} onClose={() => setPay(false)} invoice={i} today={today} onDone={() => { setPay(false); refresh(); toast('ok', 'Payment recorded'); }} />
      <VoidDialog target={void_} onClose={() => setVoid(null)} onDone={() => { setVoid(null); refresh(); toast('ok', 'Voided'); }} />
    </Page>
  );
}

function PayDialog({ open, onClose, invoice, today, onDone }: { open: boolean; onClose: () => void; invoice: Invoice; today: string; onDone: () => void }) {
  const { ws } = useWs();
  const [amount, setAmount] = useState(''); const [method, setMethod] = useState<PaymentMethod>('Cash'); const [ref, setRef] = useState(''); const [on, setOn] = useState(today); const [err, setErr] = useState('');
  const key = useRef(newKey());
  const m = useMutation({
    mutationFn: (paise: number) => api<Invoice>(wsPath(ws.id, `/invoices/${invoice.invoiceNo}/payments`), { method: 'POST', body: { amountPaise: paise, method, reference: ref, paidOn: on, idemKey: key.current } }),
    onSuccess: () => { key.current = newKey(); setAmount(''); setRef(''); onDone(); },
    onError: (e) => setErr(errText(e)),
  });
  const go = () => {
    setErr(''); const p = parseRupees(amount);
    if (p === null || p <= 0) { setErr('Enter an amount like 500 or 500.50'); return; }
    if (p > invoice.balancePaise) { setErr(`The balance due is only ${rs(invoice.balancePaise)}`); return; }
    m.mutate(p);
  };
  return (
    <Modal open={open} onClose={onClose} label="Record payment" className="w-[min(440px,96vw)]">
      <form className="space-y-3.5 p-5" onSubmit={(e) => { e.preventDefault(); go(); }}>
        <h2 className="text-lg font-semibold">Record payment</h2><p className="text-[13px] text-fg-2">Balance due on {invoice.invoiceNo}: <b className="num">{rs(invoice.balancePaise)}</b></p>
        <Field label="Amount received (₹)"><Input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" autoFocus placeholder={(invoice.balancePaise / 100).toFixed(2)} /></Field>
        <div className="grid grid-cols-2 gap-3"><Field label="Method"><Select value={method} onChange={(e) => setMethod(e.target.value as PaymentMethod)}>{PAYMENT_METHODS.map((x) => <option key={x}>{x}</option>)}</Select></Field><Field label="Date"><Input type="date" value={on} max={today} onChange={(e) => setOn(e.target.value)} /></Field></div>
        <Field label="Reference" hint="UPI / cheque / transaction no."><Input value={ref} onChange={(e) => setRef(e.target.value)} maxLength={120} /></Field>
        {err && <p className="text-[13px] text-bad" role="alert">{err}</p>}
        <div className="flex justify-end gap-2"><Button type="button" onClick={onClose}>Cancel</Button><Button type="submit" variant="primary" loading={m.isPending}>Record payment</Button></div>
      </form>
    </Modal>
  );
}

function VoidDialog({ target, onClose, onDone }: { target: { kind: 'invoice' | 'payment'; id: string } | null; onClose: () => void; onDone: () => void }) {
  const { ws } = useWs(); const [reason, setReason] = useState(''); const [err, setErr] = useState('');
  const m = useMutation({
    mutationFn: () => api(wsPath(ws.id, target!.kind === 'invoice' ? `/invoices/${target!.id}/void` : `/payments/${target!.id}/void`), { method: 'POST', body: { reason } }),
    onSuccess: () => { setReason(''); onDone(); }, onError: (e) => setErr(e instanceof ApiError && e.code === 'has_payments' ? 'This invoice has payments. Void its payments first, then void the invoice.' : errText(e)),
  });
  return (
    <Modal open={!!target} onClose={onClose} label="Void" className="w-[min(440px,96vw)]">
      <form className="space-y-3.5 p-5" onSubmit={(e) => { e.preventDefault(); setErr(''); if (reason.trim().length < 3) { setErr('Give a reason'); return; } m.mutate(); }}>
        <h2 className="text-lg font-semibold">Void {target?.kind} {target?.id}</h2>
        <p className="text-[13px] text-fg-2">The record stays in the history, marked void. This cannot be undone.</p>
        <Field label="Reason" required><Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} maxLength={300} autoFocus /></Field>
        {err && <p className="text-[13px] text-bad" role="alert">{err}</p>}
        <div className="flex justify-end gap-2"><Button type="button" onClick={onClose}>Keep it</Button><Button type="submit" variant="danger" loading={m.isPending}>Void</Button></div>
      </form>
    </Modal>
  );
}
