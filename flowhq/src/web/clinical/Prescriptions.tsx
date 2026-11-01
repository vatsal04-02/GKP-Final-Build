// Prescription / treatment sheet: fill, attach photos, save, reopen, print. Everything the clinician writes is stored as typed;
// Suggestions (src/web/clinical/conditions.ts and the clinic's own past prescriptions) only SAVE TYPING: the doctor chooses, reviews and edits; nothing is filled over text already written.
// Nothing here decides a diagnosis or a treatment.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ClipboardList, ImagePlus, Plus, Printer, Search, X } from 'lucide-react';
import type { Prescription, PatientProfile, RxImage } from '@core/clinical';
import { api, apiUpload, ApiError, ws as wsPath } from '../lib/api';
import { useWs } from '../lib/workspace';
import { Page } from '../components/layout/Shell';
import { Badge, Button, Card, CardHeader, Input, Select, Textarea } from '../components/ui/primitives';
import { EmptyState, ErrorState, SkeletonRows, useToast } from '../components/ui/feedback';
import { Field, PatientPicker, errText, fdate, useClinic, useDebounced, useToday, useUnsavedGuard } from './common';
import { DoctorFilter, useDoctorFilter } from './DoctorFilter';
import { PatientForm } from './Register';
import { COMMON_CONDITIONS } from './conditions';

const MAX_BYTES = 5 * 1024 * 1024;

interface Suggestion { diagnosis: string; count: number; lastUsed: string | null; treatmentPlan: string; advice: string }
/** Condition shortcuts under the Diagnosis box: the conditions THIS clinic has treated (most used first, remembered from saved prescriptions), then common ones. Choosing a remembered condition also
 *  offers its last treatment / advice into the boxes that are still EMPTY (never over the doctor's own text). */
function ConditionSuggestions({ f, set }: { f: Form; set: <K extends keyof Form>(k: K, v: Form[K]) => void }) {
  const { ws } = useWs(); const toast = useToast();
  const sugg = useQuery({ queryKey: ['rx-suggestions', ws.id], queryFn: () => api<Suggestion[]>(wsPath(ws.id, '/prescriptions/suggestions')), staleTime: 60000 });
  const typed = f.diagnosis.trim().toLowerCase(); const fits = (t: string) => !typed || t.toLowerCase().includes(typed);
  const learned = (sugg.data || []).filter((s) => fits(s.diagnosis) && s.diagnosis.toLowerCase() !== typed).slice(0, 8);
  const seen = new Set((sugg.data || []).map((s) => s.diagnosis.toLowerCase()));
  const common = COMMON_CONDITIONS.filter((c) => !seen.has(c.toLowerCase()) && fits(c) && c.toLowerCase() !== typed).slice(0, typed ? 6 : 10);
  if (!learned.length && !common.length) return null;
  const setDiagnosis = (d: string) => set('diagnosis', f.diagnosis.trim() && !d.toLowerCase().includes(typed) ? `${f.diagnosis.trim()}; ${d}` : d);
  const pickLearned = (s: Suggestion) => {
    setDiagnosis(s.diagnosis); const filled: string[] = [];
    if (!f.treatmentPlan.trim() && s.treatmentPlan) { set('treatmentPlan', s.treatmentPlan); filled.push('treatment'); }
    if (!f.advice.trim() && s.advice) { set('advice', s.advice); filled.push('advice'); }
    if (filled.length) toast('ok', `Filled the ${filled.join(' and ')} from your last prescription for this condition${s.lastUsed ? ` (${fdate(s.lastUsed)})` : ''}. Please review and edit.`);
  };
  const chip = 'rounded-full border border-line-2 bg-surface px-2.5 py-1 text-[12.5px] text-fg hover:bg-surface-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent';
  return (
    <div className="-mt-1 space-y-2 sm:col-span-2" aria-label="Condition suggestions">
      {learned.length > 0 && <div><div className="label mb-1">Treated at this clinic (tap to use, with the last treatment)</div><div className="flex flex-wrap gap-1.5">{learned.map((s) => <button key={s.diagnosis} type="button" className={chip} onClick={() => pickLearned(s)} title={s.treatmentPlan ? 'Also fills the empty treatment / advice boxes' : undefined}>{s.diagnosis} <span className="text-fg-2">· {s.count}×</span></button>)}</div></div>}
      {common.length > 0 && <div><div className="label mb-1">Common conditions</div><div className="flex flex-wrap gap-1.5">{common.map((c) => <button key={c} type="button" className={chip} onClick={() => setDiagnosis(c)}>{c}</button>)}</div></div>}
    </div>
  );
}
type Form = { patient: { id: string; name: string } | null; rxDate: string; treatingPhysio: string; bp: string; vitals: string; history: string; examination: string; diagnosis: string; treatmentPlan: string; exercises: string; advice: string; followUpOn: string };
type Pending = { key: string; blob: Blob; name: string; url: string; caption: string; state: 'ready' | 'uploading' | 'failed'; error?: string };

const dataUrl = (b: Blob) => new Promise<string>((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = () => rej(new Error('Could not preview this photo')); r.readAsDataURL(b); });   // data: (not blob:) keeps the strict image policy

// Resize in the browser before upload: keeps files small, and re-encoding drops EXIF data (such as GPS location).
async function prepare(file: File): Promise<Blob> {
  if (!/^image\/(jpeg|png)$/.test(file.type)) throw new Error('Only JPEG or PNG photos can be attached');
  if (file.size > 25 * 1024 * 1024) throw new Error('This photo is too large (over 25 MB)');
  const bmp = await createImageBitmap(file).catch(() => { throw new Error('This file could not be read as an image'); });
  const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(bmp.width * scale)); c.height = Math.max(1, Math.round(bmp.height * scale));
  c.getContext('2d')!.drawImage(bmp, 0, 0, c.width, c.height); bmp.close();
  const blob = (t: string, q?: number) => new Promise<Blob | null>((r) => c.toBlob(r, t, q));
  let out = file.type === 'image/png' ? await blob('image/png') : null;
  if (!out || out.size > MAX_BYTES) out = await blob('image/jpeg', 0.85);
  if (!out || out.size > MAX_BYTES) throw new Error('This photo is still larger than 5 MB after resizing');
  return out;
}

export default function Prescriptions() {
  const { rxId } = useParams();
  return rxId ? <Editor rxId={rxId} /> : <List />;
}

function List() {
  const { ws } = useWs(); const nav = useNavigate();
  const [q, setQ] = useState(''); const dq = useDebounced(q); const doc = useDoctorFilter();
  const list = useQuery({ queryKey: ['rx-list', ws.id, dq, doc.key], queryFn: () => api<Prescription[]>(wsPath(ws.id, `/prescriptions?q=${encodeURIComponent(dq)}${doc.qs}`)) });
  return (
    <Page title="Prescriptions" subtitle={doc.own ? `Your treatment sheets, ${doc.own}` : 'Treatment sheets written by the clinicians'} wide actions={<Link to={`/w/${ws.id}/prescriptions/new`}><Button variant="primary" icon={<Plus className="h-4 w-4" />}>New prescription</Button></Link>}>
      <div className="mb-3 flex flex-wrap items-center gap-2.5"><div className="w-full max-w-xs"><Input icon={<Search className="h-4 w-4" />} placeholder="Search patient, ID or diagnosis" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search prescriptions" /></div><DoctorFilter f={doc} /></div>
      <Card className="overflow-hidden">
        {list.isLoading ? <SkeletonRows rows={8} /> : list.error ? <ErrorState error={list.error} retry={() => list.refetch()} /> : !list.data?.length ? <EmptyState icon={<ClipboardList className="h-5 w-5" />} title="No prescriptions yet" body={q ? 'Try a different search.' : 'Create the first treatment sheet from here or from a patient’s record.'} /> : (
          <div className="overflow-x-auto"><table className="w-full min-w-[760px] text-left text-[13px]">
            <thead><tr className="border-b border-line bg-sage/40 text-[12.5px] text-fg-2"><th className="px-4 py-2.5 font-semibold">Rx</th><th className="px-3 py-2.5 font-semibold">Date</th><th className="px-3 py-2.5 font-semibold">Patient</th><th className="px-3 py-2.5 font-semibold">Diagnosis</th><th className="px-3 py-2.5 font-semibold">Physiotherapist</th><th className="px-3 py-2.5 font-semibold">Photos</th></tr></thead>
            <tbody>{list.data.map((r) => (
              <tr key={r.rxId} onClick={() => nav(`/w/${ws.id}/prescriptions/${r.rxId}`)} className="cursor-pointer border-b border-line/60 last:border-0 hover:bg-sage/30">
                <td className="px-4 py-2.5 font-mono text-[12px]">{r.rxId}</td><td className="px-3 py-2.5 whitespace-nowrap">{fdate(r.rxDate)}</td>
                <td className="px-3 py-2.5"><span className="font-medium">{r.patientName || '—'}</span><span className="block text-[12px] text-muted">{r.patientId}</span></td>
                <td className="max-w-[320px] truncate px-3 py-2.5">{r.diagnosis || '—'}</td><td className="px-3 py-2.5">{r.treatingPhysio || '—'}</td><td className="px-3 py-2.5">{r.images.length || '—'}</td>
              </tr>))}</tbody>
          </table></div>
        )}
      </Card>
    </Page>
  );
}

const blankForm = (today: string, patient: Form['patient'] = null): Form => ({ patient, rxDate: today, treatingPhysio: '', bp: '', vitals: '', history: '', examination: '', diagnosis: '', treatmentPlan: '', exercises: '', advice: '', followUpOn: '' });
const fromRx = (r: Prescription): Form => ({ patient: { id: r.patientId, name: r.patientName }, rxDate: r.rxDate || '', treatingPhysio: r.treatingPhysio, bp: r.bp, vitals: r.vitals, history: r.history, examination: r.examination, diagnosis: r.diagnosis, treatmentPlan: [r.treatmentPlan, r.exercises].filter(Boolean).join('\n\n'), exercises: '', advice: r.advice, followUpOn: r.followUpOn || '' });

function Editor({ rxId }: { rxId: string }) {
  const { ws, me } = useWs(); const nav = useNavigate(); const qc = useQueryClient(); const toast = useToast(); const today = useToday();
  const [sp] = useSearchParams();
  const isNew = rxId === 'new';
  const clinic = useClinic();
  const saved = useQuery({ queryKey: ['rx', ws.id, rxId], queryFn: () => api<Prescription & { versions: number[] }>(wsPath(ws.id, `/prescriptions/${rxId}`)), enabled: !isNew });
  const presetPatient = sp.get('patient');
  const preset = useQuery({ queryKey: ['patient', ws.id, presetPatient], queryFn: () => api<PatientProfile>(wsPath(ws.id, `/patients/${presetPatient}`)), enabled: isNew && !!presetPatient });
  const [f, setF] = useState<Form>(() => blankForm(today));
  const [base, setBase] = useState<string>(() => JSON.stringify(blankForm(today)));
  const [version, setVersion] = useState<number | undefined>();
  const [pending, setPending] = useState<Pending[]>([]);
  const [photoErr, setPhotoErr] = useState(''); const [newPatient, setNewPatient] = useState(false); const [conflict, setConflict] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const loaded = useRef('');
  useEffect(() => {   // load the saved sheet into the form once per version
    const d = saved.data; if (!d) return;
    const tag = `${d.rxId}@${d.version}`; if (loaded.current === tag) return;
    loaded.current = tag; const x = fromRx(d); setF(x); setBase(JSON.stringify(x)); setVersion(d.version); setConflict(false);
  }, [saved.data]);
  useEffect(() => { if (isNew && preset.data && !f.patient) { const x = blankForm(today, { id: preset.data.patient.patientId, name: preset.data.patient.name }); setF(x); setBase(JSON.stringify(x)); } }, [preset.data]);   // eslint-disable-line react-hooks/exhaustive-deps

  const dirty = JSON.stringify(f) !== base || pending.length > 0;
  useUnsavedGuard(dirty);
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((x) => ({ ...x, [k]: v }));
  const patientInfo = useQuery({ queryKey: ['patient', ws.id, f.patient?.id], queryFn: () => api<PatientProfile>(wsPath(ws.id, `/patients/${f.patient!.id}`)), enabled: !!f.patient });
  const imageUrl = (id: string) => `/api${wsPath(ws.id, `/prescriptions/${rxId}/images/${id}`)}`;

  const addFiles = async (files: FileList | null) => {
    setPhotoErr('');
    for (const fl of Array.from(files || [])) {
      try { const blob = await prepare(fl); const url = await dataUrl(blob); setPending((p) => [...p, { key: `${Date.now()}-${Math.random()}`, blob, name: fl.name, url, caption: '', state: 'ready' }]); }
      catch (e) { setPhotoErr(`${fl.name}: ${errText(e)}`); }
    }
    if (file.current) file.current.value = '';
  };
  const uploadAll = async (id: string): Promise<number> => {
    let failed = 0;
    for (const p of pending.filter((x) => x.state !== 'uploading')) {
      setPending((l) => l.map((x) => (x.key === p.key ? { ...x, state: 'uploading', error: undefined } : x)));
      try {
        const fd = new FormData(); fd.append('file', new File([p.blob], p.name, { type: p.blob.type })); fd.append('caption', p.caption);
        await apiUpload<RxImage>(wsPath(ws.id, `/prescriptions/${id}/images`), fd);
        setPending((l) => l.filter((x) => x.key !== p.key));
      } catch (e) { failed++; setPending((l) => l.map((x) => (x.key === p.key ? { ...x, state: 'failed', error: errText(e) } : x))); }
    }
    return failed;
  };

  const save = useMutation({
    mutationFn: async () => {
      if (!f.patient) throw new Error('Choose the patient first');
      const body = { patientId: f.patient.id, rxDate: f.rxDate || null, treatingPhysio: f.treatingPhysio, bp: f.bp, vitals: f.vitals, history: f.history, examination: f.examination, diagnosis: f.diagnosis, treatmentPlan: f.treatmentPlan, exercises: '', advice: f.advice, followUpOn: f.followUpOn || null };
      const dirtyForm = JSON.stringify(f) !== base;
      let rx: Prescription | null = null;
      if (isNew) rx = await api<Prescription>(wsPath(ws.id, '/prescriptions'), { method: 'POST', body });
      else if (dirtyForm) rx = await api<Prescription>(wsPath(ws.id, `/prescriptions/${rxId}`), { method: 'PUT', body: { ...body, baseVersion: version } });
      const id = rx?.rxId || rxId;
      const failed = await uploadAll(id);
      return { rx, id, failed };
    },
    onSuccess: ({ rx, id, failed }) => {
      qc.invalidateQueries({ queryKey: ['rx-list', ws.id] }); qc.invalidateQueries({ queryKey: ['rx', ws.id, id] }); qc.invalidateQueries({ queryKey: ['patient', ws.id] });
      if (rx) { setBase(JSON.stringify(f)); setVersion(rx.version); loaded.current = `${rx.rxId}@${rx.version}`; }
      if (failed) toast('bad', `${rx ? 'Prescription saved' : 'Saved'}, but ${failed} photo${failed > 1 ? 's were' : ' was'} not saved. Use Retry on the photo.`);
      else toast('ok', rx ? `Prescription ${rx.rxId} saved` : 'Photos saved');
      if (isNew && rx) nav(`/w/${ws.id}/prescriptions/${rx.rxId}`, { replace: true });
    },
    onError: (e) => { if (e instanceof ApiError && e.code === 'stale') setConflict(true); toast('bad', errText(e)); },
  });
  const removeSaved = useMutation({
    mutationFn: (imageId: string) => api(wsPath(ws.id, `/prescriptions/${rxId}/images/${imageId}`), { method: 'DELETE' }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['rx', ws.id, rxId] }); qc.invalidateQueries({ queryKey: ['rx-list', ws.id] }); toast('ok', 'Photo removed'); },
    onError: (e) => toast('bad', errText(e)),
  });

  const physios = clinic.data?.clinicians || [];
  const savedImages = saved.data?.images || [];
  const canPrint = !isNew && !dirty && !!saved.data;
  const info = useMemo(() => patientInfo.data?.patient, [patientInfo.data]);
  if (!isNew && saved.isLoading) return <Page title="Prescription"><SkeletonRows rows={8} /></Page>;
  if (!isNew && saved.error) return <Page title="Prescription"><ErrorState error={saved.error} retry={() => saved.refetch()} /></Page>;

  return (
    <Page title={isNew ? 'New prescription' : `Prescription ${rxId}`} subtitle={isNew ? 'Treatment sheet' : `Version ${version ?? ''} · last saved ${saved.data?.createdAt ? new Date(saved.data.createdAt).toLocaleString('en-IN', { timeZone: ws.timezone, dateStyle: 'medium', timeStyle: 'short' }) : ''} by ${saved.data?.createdBy || '—'}`}
      actions={<><Link to={`/w/${ws.id}/prescriptions`}><Button variant="ghost">Back to list</Button></Link>
        <Button icon={<Printer className="h-4 w-4" />} disabled={!canPrint} title={canPrint ? undefined : isNew ? 'Save the prescription first' : 'Save your changes first so the printout matches the saved record'} onClick={() => nav(`/w/${ws.id}/print/prescription/${rxId}?auto=1`)}>Print Prescription</Button>
        <Button variant="primary" loading={save.isPending} disabled={!dirty || !f.patient} onClick={() => save.mutate()}>{isNew ? 'Save prescription' : 'Save changes'}</Button></>}>
      {conflict && <div role="alert" className="mb-4 rounded-xl border border-warn/40 bg-warn/10 p-3 text-[13px]">Someone else saved a newer version of this prescription. <button className="font-medium underline" onClick={() => { loaded.current = ''; qc.invalidateQueries({ queryKey: ['rx', ws.id, rxId] }).then(() => saved.refetch()); }}>Reload it</button> and apply your edit again (what you typed here will be replaced).</div>}
      <div className="grid gap-5 lg:grid-cols-[1fr_340px]">
        <Card className="p-5">
          <div className="grid gap-3.5 sm:grid-cols-2">
            <Field label="Patient" required className="sm:col-span-2" hint={isNew ? <button type="button" className="underline" onClick={() => setNewPatient(true)}>Not registered yet? Add a new patient</button> : undefined}>
              <PatientPicker value={f.patient} onChange={(p) => set('patient', p)} disabled={!isNew} />
            </Field>
            {info && <div className="sm:col-span-2 -mt-1 flex flex-wrap gap-x-4 gap-y-1 text-[12.5px] text-fg-2"><span>Patient ID: <b className="font-medium text-fg">{info.patientId}</b></span>{info.age && <span>Age: {info.age}</span>}{info.sex && <span>Sex: {info.sex}</span>}{info.phone && <span>{info.phone}</span>}</div>}
            <Field label="Date"><Input type="date" value={f.rxDate} onChange={(e) => set('rxDate', e.target.value)} /></Field>
            <Field label="Treating physiotherapist" required={!me.user.clinician && physios.length > 0}>
              {me.user.clinician || !physios.length
                ? <Input list="physios" value={me.user.clinician || f.treatingPhysio} onChange={(e) => set('treatingPhysio', e.target.value)} maxLength={120} readOnly={!!me.user.clinician} title={me.user.clinician ? 'Your name goes on every prescription you write' : undefined} />
                : <Select value={f.treatingPhysio} onChange={(e) => set('treatingPhysio', e.target.value)}>
                    <option value="">Choose the doctor</option>
                    {physios.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
                    {f.treatingPhysio && !physios.some((c) => c.name === f.treatingPhysio) && <option value={f.treatingPhysio}>{f.treatingPhysio} (not in the clinic list)</option>}
                  </Select>}
            </Field>
            <datalist id="physios">{physios.map((c) => <option key={c.name} value={c.name} />)}</datalist>
            <Field label="Blood pressure"><Input value={f.bp} onChange={(e) => set('bp', e.target.value)} placeholder="e.g. 120/80" maxLength={40} /></Field>
            <Field label="Other vitals"><Input value={f.vitals} onChange={(e) => set('vitals', e.target.value)} maxLength={300} /></Field>
            <Field label="Clinical history" className="sm:col-span-2"><Textarea value={f.history} onChange={(e) => set('history', e.target.value)} rows={3} maxLength={4000} /></Field>
            <Field label="O/E: clinical examination findings" className="sm:col-span-2"><Textarea value={f.examination} onChange={(e) => set('examination', e.target.value)} rows={3} maxLength={4000} /></Field>
            <Field label="Diagnosis" className="sm:col-span-2" hint="Entered by the clinician. Tap a suggestion below to save typing; nothing is saved until you save the prescription."><Textarea value={f.diagnosis} onChange={(e) => set('diagnosis', e.target.value)} rows={2} maxLength={2000} /></Field>
            <ConditionSuggestions f={f} set={set} />
            <Field label="Physiotherapy treatment, exercises & instructions" className="sm:col-span-2"><Textarea value={f.treatmentPlan} onChange={(e) => set('treatmentPlan', e.target.value)} rows={4} maxLength={4000} /></Field>
            <Field label="Advice" className="sm:col-span-2"><Textarea value={f.advice} onChange={(e) => set('advice', e.target.value)} rows={3} maxLength={4000} /></Field>
            <Field label="Follow-up date"><Input type="date" value={f.followUpOn} onChange={(e) => set('followUpOn', e.target.value)} /></Field>
          </div>
        </Card>

        <div className="space-y-4">
          <Card>
            <CardHeader title="Clinical photographs" subtitle="Optional · JPEG or PNG, up to 5 MB each" icon={<ImagePlus className="h-4 w-4" />} />
            <div className="space-y-3 p-5 pt-3">
              <input ref={file} type="file" accept="image/jpeg,image/png" multiple className="hidden" onChange={(e) => addFiles(e.target.files)} />
              <Button variant="secondary" icon={<ImagePlus className="h-4 w-4" />} onClick={() => file.current?.click()}>Add photo</Button>
              {photoErr && <p className="text-[12.5px] text-bad" role="alert">{photoErr}</p>}
              {isNew && !f.patient && pending.length > 0 && <p className="text-[12.5px] text-muted">Photos are saved with the prescription once you choose a patient and save.</p>}
              <ul className="grid grid-cols-2 gap-2.5">
                {savedImages.map((im) => (
                  <li key={im.imageId} className="relative overflow-hidden rounded-lg border border-line bg-surface-2">
                    <img src={imageUrl(im.imageId)} alt={im.caption || 'Saved clinical photograph'} className="aspect-square w-full object-cover" loading="lazy" />
                    <div className="flex items-center justify-between gap-1 px-2 py-1.5 text-[11.5px]"><Badge tone="green">Saved</Badge><button type="button" className="text-muted hover:text-bad" onClick={() => { if (window.confirm('Remove this photo from the prescription?')) removeSaved.mutate(im.imageId); }} disabled={removeSaved.isPending}>Remove</button></div>
                  </li>
                ))}
                {pending.map((p) => (
                  <li key={p.key} className="relative overflow-hidden rounded-lg border border-dashed border-line-2 bg-surface-2">
                    <img src={p.url} alt="Photo preview" className="aspect-square w-full object-cover" />
                    <div className="space-y-1 px-2 py-1.5 text-[11.5px]">
                      <div className="flex items-center justify-between gap-1">{p.state === 'uploading' ? <Badge tone="blue">Saving…</Badge> : p.state === 'failed' ? <Badge tone="red">Not saved</Badge> : <Badge tone="amber">Not saved yet</Badge>}
                        <button type="button" className="text-muted hover:text-bad" aria-label="Remove this photo before saving" onClick={() => setPending((l) => l.filter((x) => x.key !== p.key))} disabled={p.state === 'uploading'}><X className="h-3.5 w-3.5" /></button></div>
                      {p.error && <div className="text-bad">{p.error}</div>}
                      {p.state === 'failed' && !isNew && <button type="button" className="font-medium underline" onClick={() => save.mutate()}>Retry</button>}
                    </div>
                  </li>
                ))}
              </ul>
              {!savedImages.length && !pending.length && <p className="text-[12.5px] text-muted">No photographs attached.</p>}
            </div>
          </Card>
          <p className="px-1 text-[12px] leading-relaxed text-muted">Prescriptions are stored as typed and every save keeps the earlier version. Photos are stored in the clinic’s own records and are only shown to signed-in staff.</p>
        </div>
      </div>
      <PatientForm open={newPatient} onClose={() => setNewPatient(false)} onSaved={(p) => { setNewPatient(false); set('patient', { id: p.patientId, name: p.name }); }} />
    </Page>
  );
}
