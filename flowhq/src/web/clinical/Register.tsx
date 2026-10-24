// The patient register: a clean spreadsheet-style version of the clinic's paper register, plus the patient's record.
import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, Download, Plus, Printer, Search, UserRound } from 'lucide-react';
import { PATIENT_STATUSES, SEXES, type Patient, type PatientList, type PatientProfile, type PatientRow, type VisitStatus } from '@core/clinical';
import { api, ApiError, ws as wsPath } from '../lib/api';
import { useWs } from '../lib/workspace';
import { cn } from '../lib/cn';
import { Page } from '../components/layout/Shell';
import { Badge, Button, Card, Input, Segmented, Select, Textarea } from '../components/ui/primitives';
import { Drawer, EmptyState, ErrorState, Modal, SkeletonRows, useToast } from '../components/ui/feedback';
import { Field, PaymentBadge, errText, fdate, rs, useDebounced, useToday } from './common';

type SortKey = 'serial' | 'name' | 'registered' | 'billed' | 'outstanding' | 'latestVisit' | 'followUp';
const MARK: Record<VisitStatus, { glyph: string; cls: string; label: string }> = { Attended: { glyph: '✓', cls: 'text-ok', label: 'Attended' }, Missed: { glyph: '✗', cls: 'text-bad', label: 'Missed' }, Cancelled: { glyph: '–', cls: 'text-muted', label: 'Cancelled' } };
const DAY = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const mondayOf = (d: string) => addDays(d, -((new Date(`${d}T00:00:00Z`).getUTCDay() + 6) % 7));
const csvCell = (v: unknown) => { let s = String(v ?? ''); if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };   // a leading = + - @ would run as a spreadsheet formula

export default function Register() {
  const { ws } = useWs();
  const { patientId } = useParams();
  const nav = useNavigate();
  const today = useToday();
  const toast = useToast();
  const [q, setQ] = useState(''); const dq = useDebounced(q);
  const [status, setStatus] = useState(''); const [followUp, setFollowUp] = useState(false); const [owing, setOwing] = useState(false);
  const [sort, setSort] = useState<SortKey>('serial'); const [dir, setDir] = useState<'asc' | 'desc'>('asc'); const [page, setPage] = useState(1);
  const [weekOn, setWeekOn] = useState(false); const [week, setWeek] = useState(() => mondayOf(today));
  const [sp] = useSearchParams(); const [creating, setCreating] = useState(sp.get('new') === '1');   // the dashboard's "Register patient" opens the form straight away
  const [exporting, setExporting] = useState(false);
  const qs = (extra = '') => `/patients?q=${encodeURIComponent(dq)}${status ? `&status=${status}` : ''}${followUp ? '&followUp=1' : ''}${owing ? '&owing=1' : ''}&sort=${sort}&dir=${dir}${weekOn ? `&week=${week}` : ''}${extra}`;
  const list = useQuery({ queryKey: ['register', ws.id, dq, status, followUp, owing, sort, dir, page, weekOn ? week : ''], queryFn: () => api<PatientList>(wsPath(ws.id, qs(`&page=${page}&pageSize=50`))), placeholderData: keepPreviousData });
  const reset = () => setPage(1);
  const sortBy = (k: SortKey) => { if (sort === k) setDir((d) => (d === 'asc' ? 'desc' : 'asc')); else { setSort(k); setDir('asc'); } reset(); };
  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(week, i)), [week]);

  const exportCsv = async () => {
    setExporting(true);
    try {
      const rows: PatientRow[] = []; let p = 1;
      for (;;) { const r = await api<PatientList>(wsPath(ws.id, qs(`&page=${p}&pageSize=200`).replace(/&week=[^&]*/, ''))); rows.push(...r.rows); if (rows.length >= r.total || !r.rows.length) break; p++; }
      const head = ['S.No', 'Patient ID', 'Name', 'Address', 'Contact', 'Referred by', 'Occupation', 'Complaint', 'Registered', 'Billed (INR)', 'Paid (INR)', 'Balance (INR)', 'Last visit', 'Follow-up', 'Status'];
      const body = rows.map((r) => [r.serialNo, r.patientId, r.name, r.address, r.phone, r.referredBy, r.occupation, r.mainComplaint, r.registeredOn, (r.billedPaise / 100).toFixed(2), (r.paidPaise / 100).toFixed(2), (r.outstandingPaise / 100).toFixed(2), r.latestVisit, r.followUpOn, r.status]);
      const blob = new Blob([[head, ...body].map((r) => r.map(csvCell).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' });
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `patient-register-${today}.csv`; a.click(); URL.revokeObjectURL(a.href);
    } catch (e) { toast('bad', `Export failed: ${errText(e)}`); } finally { setExporting(false); }
  };

  const th = (label: string, k?: SortKey, cls = '') => (
    <th className={cn('whitespace-nowrap border-b border-r border-line/70 bg-sage/40 px-2.5 py-2 text-left text-[11.5px] font-semibold uppercase tracking-wide text-fg-2 last:border-r-0', cls)} aria-sort={k && sort === k ? (dir === 'asc' ? 'ascending' : 'descending') : undefined}>
      {k ? <button type="button" onClick={() => sortBy(k)} className="inline-flex items-center gap-1 hover:text-fg">{label}{sort === k && (dir === 'asc' ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />)}</button> : label}
    </th>
  );
  const td = 'border-b border-r border-line/60 px-2.5 py-2 align-top last:border-r-0';
  const pages = list.data ? Math.max(1, Math.ceil(list.data.total / list.data.pageSize)) : 1;

  return (
    <Page title="Patient register" subtitle={list.data ? `${list.data.total} patient${list.data.total === 1 ? '' : 's'}` : ' '} wide
      actions={<><Button variant="secondary" icon={<Download className="h-4 w-4" />} onClick={exportCsv} loading={exporting} className="print:hidden">Export CSV</Button><Button variant="secondary" icon={<Printer className="h-4 w-4" />} onClick={() => window.print()} className="print:hidden">Print page</Button><Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setCreating(true)} className="print:hidden">Add patient</Button></>}>
      <div className="mb-3 flex flex-wrap items-center gap-2.5 print:hidden">
        <div className="w-full max-w-xs"><Input icon={<Search className="h-4 w-4" />} placeholder="Search name, phone, patient ID or complaint" value={q} onChange={(e) => { setQ(e.target.value); reset(); }} aria-label="Search patients" /></div>
        <Segmented value={status || 'all'} onChange={(v) => { setStatus(v === 'all' ? '' : v); reset(); }} options={[{ value: 'all', label: 'All' }, ...PATIENT_STATUSES.map((s) => ({ value: s as string, label: s }))]} />
        <Button variant={followUp ? 'subtle' : 'secondary'} aria-pressed={followUp} onClick={() => { setFollowUp((v) => !v); reset(); }}>Follow-up due</Button>
        <Button variant={owing ? 'subtle' : 'secondary'} aria-pressed={owing} onClick={() => { setOwing((v) => !v); reset(); }}>Balance due</Button>
        <Button variant={weekOn ? 'subtle' : 'secondary'} aria-pressed={weekOn} onClick={() => setWeekOn((v) => !v)}>Weekly attendance</Button>
        {weekOn && <div className="flex items-center gap-1"><Button size="sm" variant="ghost" onClick={() => setWeek(addDays(week, -7))} aria-label="Previous week"><ChevronLeft className="h-4 w-4" /></Button><span className="min-w-[132px] text-center text-[13px] text-fg-2">{fdate(week)} – {fdate(addDays(week, 6))}</span><Button size="sm" variant="ghost" onClick={() => setWeek(addDays(week, 7))} aria-label="Next week"><ChevronRight className="h-4 w-4" /></Button></div>}
      </div>

      <Card className="overflow-hidden">
        {list.isLoading ? <SkeletonRows rows={10} /> : list.error ? <ErrorState error={list.error} retry={() => list.refetch()} /> : !list.data?.rows.length ? (
          <EmptyState icon={<UserRound className="h-5 w-5" />} title="No patients found" body={q || status || followUp || owing ? 'Try clearing the search or filters.' : 'Register the first patient to start the register.'} action={!q && !status ? <Button variant="primary" onClick={() => setCreating(true)} icon={<Plus className="h-4 w-4" />}>Add patient</Button> : undefined} />
        ) : (
          <div className="overflow-x-auto">
            <table className={cn('w-full border-collapse text-[13px]', weekOn ? 'min-w-[1500px]' : 'min-w-[1280px]')}>
              <thead><tr>
                {th('S.No', 'serial', 'w-14')}{th('Patient ID', undefined, 'w-[104px]')}{th('Name', 'name', 'min-w-[170px]')}{th('Address & contact', undefined, 'min-w-[210px]')}{th('Referred by')}{th('Occupation')}{th('Disorder / complaint')}{th('Registered', 'registered')}
                {th('Billed', 'billed', 'text-right')}{th('Paid', undefined, 'text-right')}{th('Balance', 'outstanding', 'text-right')}{th('Last visit', 'latestVisit')}{th('Follow-up', 'followUp')}{th('Status')}
                {weekOn && days.map((d, i) => <th key={d} title={fdate(d)} className="w-9 border-b border-r border-line/70 bg-sage/40 px-1 py-2 text-center text-[11.5px] font-semibold text-fg-2">{DAY[i]}<div className="text-[9.5px] font-normal text-muted">{d.slice(8)}</div></th>)}
              </tr></thead>
              <tbody>
                {list.data.rows.map((p) => (
                  <tr key={p.patientId} onClick={() => nav(`/w/${ws.id}/patients/${p.patientId}`)} className={cn('cursor-pointer transition-colors hover:bg-sage/30', p.patientId === patientId && 'bg-sage/50')}>
                    <td className={cn(td, 'num text-muted')}>{p.serialNo}</td>
                    <td className={cn(td, 'whitespace-nowrap font-mono text-[12px]')}>{p.patientId}</td>
                    <td className={cn(td, 'font-medium')}><Link to={`/w/${ws.id}/patients/${p.patientId}`} onClick={(e) => e.stopPropagation()} className="text-fg hover:underline">{p.name}</Link>{(p.age || p.sex) && <div className="text-[12px] font-normal text-muted">{[p.age, p.sex].filter(Boolean).join(' · ')}</div>}</td>
                    <td className={cn(td, 'max-w-[220px]')}><div className="truncate">{p.address || '—'}</div><div className="text-[12px] text-muted">{p.phone || '—'}</div></td>
                    <td className={cn(td, 'max-w-[140px] truncate')}>{p.referredBy || '—'}</td>
                    <td className={cn(td, 'max-w-[130px] truncate')}>{p.occupation || '—'}</td>
                    <td className={cn(td, 'max-w-[220px]')}><div className="line-clamp-2">{p.mainComplaint || '—'}</div></td>
                    <td className={cn(td, 'whitespace-nowrap')}>{fdate(p.registeredOn)}</td>
                    <td className={cn(td, 'num whitespace-nowrap text-right')}>{rs(p.billedPaise)}</td>
                    <td className={cn(td, 'num whitespace-nowrap text-right')}>{rs(p.paidPaise)}</td>
                    <td className={cn(td, 'num whitespace-nowrap text-right font-medium', p.outstandingPaise > 0 && 'text-bad')}>{rs(p.outstandingPaise)}</td>
                    <td className={cn(td, 'whitespace-nowrap')}>{fdate(p.latestVisit)}</td>
                    <td className={cn(td, 'whitespace-nowrap', p.followUpOn && p.followUpOn <= today && p.status === 'Active' && 'font-medium text-warn')}>{fdate(p.followUpOn)}</td>
                    <td className={td}><Badge tone={p.status === 'Active' ? 'green' : 'neutral'}>{p.status}</Badge></td>
                    {weekOn && days.map((d) => { const s = p.attendance?.[d]; return <td key={d} className={cn(td, 'text-center text-[15px] font-semibold', s && MARK[s].cls)} title={s ? MARK[s].label : undefined}>{s ? MARK[s].glyph : ''}</td>; })}
                  </tr>
                ))}
              </tbody>
              <tfoot><tr className="bg-sage/30 font-semibold">
                <td className="px-2.5 py-2" colSpan={8}>Totals for {list.data.total} patient{list.data.total === 1 ? '' : 's'} in this view</td>
                <td className="num px-2.5 py-2 text-right">{rs(list.data.totals.billedPaise)}</td><td className="num px-2.5 py-2 text-right">{rs(list.data.totals.paidPaise)}</td><td className="num px-2.5 py-2 text-right">{rs(list.data.totals.outstandingPaise)}</td><td colSpan={weekOn ? 10 : 3} />
              </tr></tfoot>
            </table>
          </div>
        )}
      </Card>
      {list.data && pages > 1 && (
        <div className="mt-3 flex items-center justify-between text-[13px] text-fg-2 print:hidden">
          <span>Page {list.data.page} of {pages}</span>
          <div className="flex gap-2"><Button size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Previous</Button><Button size="sm" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>Next</Button></div>
        </div>
      )}

      <PatientForm open={creating} onClose={() => setCreating(false)} onSaved={(p) => { setCreating(false); nav(`/w/${ws.id}/patients/${p.patientId}`); }} />
      <Drawer open={!!patientId} onClose={() => nav(`/w/${ws.id}/patients`)} title="Patient record" width={720}>{patientId && <Profile id={patientId} />}</Drawer>
    </Page>
  );
}

// ---------------------------------------------------------------- add / edit
const blank = { name: '', phone: '', age: '', sex: '' as Patient['sex'], address: '', referredBy: '', occupation: '', mainComplaint: '', registeredOn: '', status: 'Active' as Patient['status'], followUpOn: '', notes: '' };
export function PatientForm({ open, onClose, onSaved, patient }: { open: boolean; onClose: () => void; onSaved: (p: PatientRow) => void; patient?: PatientRow }) {
  const { ws } = useWs();
  const qc = useQueryClient(); const toast = useToast();
  const init = useMemo(() => (patient ? { ...blank, ...patient, registeredOn: patient.registeredOn || '', followUpOn: patient.followUpOn || '' } : blank), [patient, open]);   // eslint-disable-line react-hooks/exhaustive-deps
  const [f, setF] = useState(init);
  const [dups, setDups] = useState<Array<{ patientId: string; name: string; phone: string }>>([]);
  const [err, setErr] = useState<{ field?: string; text: string } | null>(null);
  const [seen, setSeen] = useState(open);
  if (open !== seen) { setSeen(open); if (open) { setF(init); setDups([]); setErr(null); } }
  const set = <K extends keyof typeof blank>(k: K, v: (typeof blank)[K]) => setF((x) => ({ ...x, [k]: v }));
  const save = useMutation({
    mutationFn: (confirmDuplicate: boolean) => {
      const body = { name: f.name, phone: f.phone, age: f.age, sex: f.sex, address: f.address, referredBy: f.referredBy, occupation: f.occupation, mainComplaint: f.mainComplaint, registeredOn: f.registeredOn || null, status: f.status, followUpOn: f.followUpOn || null, notes: f.notes, ...(confirmDuplicate ? { confirmDuplicate: true } : {}) };
      return patient ? api<PatientRow>(wsPath(ws.id, `/patients/${patient.patientId}`), { method: 'PATCH', body }) : api<PatientRow>(wsPath(ws.id, '/patients'), { method: 'POST', body });
    },
    onSuccess: (p) => { qc.invalidateQueries({ queryKey: ['register', ws.id] }); qc.invalidateQueries({ queryKey: ['patient', ws.id] }); toast('ok', patient ? 'Patient details saved' : `Patient registered as ${p.patientId}`); onSaved(p); },
    onError: (e) => {
      if (e instanceof ApiError && e.code === 'possible_duplicate') { setDups(((e.data?.matches as typeof dups) || [])); setErr(null); return; }
      setErr({ field: e instanceof ApiError && e.code === 'invalid_phone' ? 'phone' : undefined, text: errText(e) });
    },
  });
  return (
    <Modal open={open} onClose={onClose} label={patient ? 'Edit patient' : 'Add patient'} className="w-[min(680px,96vw)]">
      <form onSubmit={(e) => { e.preventDefault(); setErr(null); setDups([]); if (!f.name.trim()) { setErr({ field: 'name', text: 'Enter the patient’s name' }); return; } save.mutate(false); }} className="max-h-[80vh] overflow-y-auto p-5">
        <h2 className="mb-4 text-lg font-semibold">{patient ? `Edit ${patient.name}` : 'Add patient'}</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Patient name" required error={err?.field === 'name' ? err.text : undefined} className="sm:col-span-2"><Input value={f.name} onChange={(e) => set('name', e.target.value)} autoFocus maxLength={120} /></Field>
          <Field label="Mobile number" error={err?.field === 'phone' ? err.text : undefined} hint="10-digit Indian mobile"><Input value={f.phone} onChange={(e) => set('phone', e.target.value)} inputMode="tel" maxLength={30} /></Field>
          <div className="grid grid-cols-2 gap-3"><Field label="Age"><Input value={f.age} onChange={(e) => set('age', e.target.value)} maxLength={20} /></Field>
            <Field label="Sex"><Select value={f.sex} onChange={(e) => set('sex', e.target.value as Patient['sex'])}><option value="">—</option>{SEXES.map((s) => <option key={s}>{s}</option>)}</Select></Field></div>
          <Field label="Address" className="sm:col-span-2"><Input value={f.address} onChange={(e) => set('address', e.target.value)} maxLength={400} /></Field>
          <Field label="Referred by (doctor)"><Input value={f.referredBy} onChange={(e) => set('referredBy', e.target.value)} maxLength={120} /></Field>
          <Field label="Occupation"><Input value={f.occupation} onChange={(e) => set('occupation', e.target.value)} maxLength={120} /></Field>
          <Field label="Disorder / main complaint" className="sm:col-span-2" hint="As recorded by the clinician"><Textarea value={f.mainComplaint} onChange={(e) => set('mainComplaint', e.target.value)} rows={2} maxLength={500} /></Field>
          <Field label="Registration date"><Input type="date" value={f.registeredOn} onChange={(e) => set('registeredOn', e.target.value)} /></Field>
          <Field label="Next follow-up"><Input type="date" value={f.followUpOn} onChange={(e) => set('followUpOn', e.target.value)} /></Field>
          <Field label="Status"><Select value={f.status} onChange={(e) => set('status', e.target.value as Patient['status'])}>{PATIENT_STATUSES.map((s) => <option key={s}>{s}</option>)}</Select></Field>
          <Field label="Notes" className="sm:col-span-2"><Textarea value={f.notes} onChange={(e) => set('notes', e.target.value)} rows={2} maxLength={2000} /></Field>
        </div>
        {dups.length > 0 && (
          <div className="mt-4 rounded-xl border border-warn/40 bg-warn/10 p-3 text-[13px]" role="alert">
            <div className="font-medium text-warn">This may be a patient who is already registered:</div>
            <ul className="mt-1.5 space-y-0.5">{dups.map((d) => <li key={d.patientId}><Link className="underline" to={`/w/${ws.id}/patients/${d.patientId}`} onClick={onClose}>{d.name}</Link> · {d.patientId}{d.phone ? ` · ${d.phone}` : ''}</li>)}</ul>
            <Button type="button" size="sm" className="mt-2" loading={save.isPending} onClick={() => save.mutate(true)}>{patient ? 'Save anyway' : 'Register as a new patient anyway'}</Button>
          </div>
        )}
        {err && !err.field && <p className="mt-3 text-[13px] text-bad" role="alert">{err.text}</p>}
        <div className="mt-5 flex justify-end gap-2"><Button type="button" onClick={onClose}>Cancel</Button><Button type="submit" variant="primary" loading={save.isPending}>{patient ? 'Save changes' : 'Register patient'}</Button></div>
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------- the patient's record
function Profile({ id }: { id: string }) {
  const { ws } = useWs();
  const qc = useQueryClient(); const toast = useToast(); const today = useToday();
  const [tab, setTab] = useState<'overview' | 'rx' | 'billing' | 'visits'>('overview'); const [editing, setEditing] = useState(false);
  const q = useQuery({ queryKey: ['patient', ws.id, id], queryFn: () => api<PatientProfile>(wsPath(ws.id, `/patients/${id}`)) });
  const mark = useMutation({
    mutationFn: (status: VisitStatus) => api(wsPath(ws.id, '/visits'), { method: 'PUT', body: { patientId: id, date: today, status } }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['patient', ws.id, id] }); qc.invalidateQueries({ queryKey: ['register', ws.id] }); toast('ok', 'Attendance saved'); },
    onError: (e) => toast('bad', errText(e)),
  });
  if (q.isLoading) return <div className="p-5"><SkeletonRows rows={6} /></div>;
  if (q.error || !q.data) return <ErrorState error={q.error || new Error('Not found')} retry={() => q.refetch()} />;
  const { patient: p, prescriptions, invoices, payments, visits } = q.data;
  const row = (k: string, v: string) => <div><dt className="text-[11.5px] uppercase tracking-wide text-muted">{k}</dt><dd className="mt-0.5 text-[13.5px]">{v || '—'}</dd></div>;
  return (
    <div className="p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div><h3 className="font-display text-xl font-semibold">{p.name}</h3><div className="mt-0.5 text-[13px] text-muted">{p.patientId} · Serial {p.serialNo} · {p.phone || 'no phone'}</div></div>
        <div className="flex gap-2"><Button size="sm" onClick={() => setEditing(true)}>Edit details</Button><Link to={`/w/${ws.id}/prescriptions/new?patient=${p.patientId}`}><Button size="sm" variant="primary">New prescription</Button></Link><Link to={`/w/${ws.id}/invoices/new?patient=${p.patientId}`}><Button size="sm" variant="primary">New invoice</Button></Link></div>
      </div>
      <div className="mt-4 grid grid-cols-3 gap-2.5">
        {([['Billed', p.billedPaise, ''], ['Paid', p.paidPaise, ''], ['Balance due', p.outstandingPaise, p.outstandingPaise > 0 ? 'text-bad' : '']] as const).map(([k, v, c]) => <Card key={k} className="px-3.5 py-3"><div className="text-[11.5px] uppercase tracking-wide text-muted">{k}</div><div className={cn('num mt-1 text-lg font-semibold', c)}>{rs(v)}</div></Card>)}
      </div>
      <div className="mt-5"><Segmented value={tab} onChange={setTab} options={[{ value: 'overview', label: 'Details' }, { value: 'rx', label: 'Prescriptions', count: prescriptions.length }, { value: 'billing', label: 'Invoices & payments', count: invoices.length }, { value: 'visits', label: 'Attendance', count: visits.length }]} /></div>
      <div className="mt-4">
        {tab === 'overview' && <dl className="grid gap-x-6 gap-y-3.5 sm:grid-cols-2">{row('Age / sex', [p.age, p.sex].filter(Boolean).join(' · '))}{row('Status', p.status)}{row('Address', p.address)}{row('Referred by', p.referredBy)}{row('Occupation', p.occupation)}{row('Registered', fdate(p.registeredOn))}{row('Disorder / complaint', p.mainComplaint)}{row('Latest visit', fdate(p.latestVisit))}{row('Next follow-up', fdate(p.followUpOn))}{row('Notes', p.notes)}</dl>}
        {tab === 'rx' && (prescriptions.length ? <ul className="divide-y divide-line/70 rounded-xl border border-line">{prescriptions.map((r) => <li key={r.rxId}><Link to={`/w/${ws.id}/prescriptions/${r.rxId}`} className="flex items-center justify-between gap-3 px-3.5 py-2.5 hover:bg-surface-2"><span><span className="font-medium">{r.rxId}</span> · {fdate(r.rxDate)}<span className="block text-[12.5px] text-muted">{r.diagnosis || 'No diagnosis recorded'}</span></span><span className="text-[12px] text-muted">{r.images.length ? `${r.images.length} photo${r.images.length > 1 ? 's' : ''} · ` : ''}v{r.version}</span></Link></li>)}</ul> : <p className="text-sm text-fg-2">No prescriptions yet.</p>)}
        {tab === 'billing' && (invoices.length ? (
          <div className="space-y-4">
            <ul className="divide-y divide-line/70 rounded-xl border border-line">{invoices.map((i) => <li key={i.invoiceNo}><Link to={`/w/${ws.id}/invoices/${i.invoiceNo}`} className="flex items-center justify-between gap-3 px-3.5 py-2.5 hover:bg-surface-2"><span><span className="font-medium">{i.invoiceNo}</span> · {fdate(i.date)}<span className="block text-[12.5px] text-muted">{i.lines.map((l) => l.description).join(', ')}</span></span><span className="flex items-center gap-2"><span className="num text-[13px]">{rs(i.totalPaise)}</span><PaymentBadge status={i.paymentStatus} /></span></Link></li>)}</ul>
            <div><div className="label mb-1.5">Payment history</div>{payments.length ? <table className="w-full text-[13px]"><tbody>{payments.map((x) => <tr key={x.paymentId} className={cn('border-b border-line/60', x.voided && 'text-muted line-through')}><td className="py-1.5">{fdate(x.paidOn)}</td><td>{x.method}{x.reference ? ` · ${x.reference}` : ''}</td><td className="text-fg-2">{x.invoiceNo}</td><td className="num text-right">{rs(x.amountPaise)}</td></tr>)}</tbody></table> : <p className="text-sm text-fg-2">No payments recorded.</p>}</div>
          </div>) : <p className="text-sm text-fg-2">No invoices yet.</p>)}
        {tab === 'visits' && (
          <div>
            <div className="mb-3 flex flex-wrap items-center gap-2 text-[13px]"><span className="text-fg-2">Today ({fdate(today)}):</span>{(['Attended', 'Missed', 'Cancelled'] as const).map((s) => <Button key={s} size="sm" disabled={mark.isPending} onClick={() => mark.mutate(s)}>{s}</Button>)}</div>
            {visits.length ? <ul className="divide-y divide-line/70 rounded-xl border border-line">{visits.map((v) => <li key={v.date} className="flex items-center justify-between px-3.5 py-2 text-[13px]"><span>{fdate(v.date)}{v.notes ? <span className="text-muted"> · {v.notes}</span> : null}</span><span className={MARK[v.status].cls}>{MARK[v.status].glyph} {v.status}</span></li>)}</ul> : <p className="text-sm text-fg-2">No visits recorded.</p>}
            <p className="mt-2 text-[12px] text-muted">The Attendance page shows the whole week, Monday to Sunday.</p>
          </div>
        )}
      </div>
      <PatientForm open={editing} patient={p} onClose={() => setEditing(false)} onSaved={() => setEditing(false)} />
    </div>
  );
}
