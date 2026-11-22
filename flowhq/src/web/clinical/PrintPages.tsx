// Stand-alone print views (no dashboard chrome): opened in a new tab by "Print Prescription" / "Print Invoice".
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Printer } from 'lucide-react';
import type { Invoice, PatientProfile, Prescription } from '@core/clinical';
import { api, ws as wsPath } from '../lib/api';
import { useWs } from '../lib/workspace';
import { Button } from '../components/ui/primitives';
import { ErrorState, Skeleton } from '../components/ui/feedback';
import { InvoiceDocument, PrescriptionDocument } from './documents';
import { useClinic } from './common';

// One sheet of paper: if the content is taller than an A4 page (less the 10mm print margins), shrink it just enough to fit on ONE page.
const PAGE_MM = 268;   // 297mm - 2 x 10mm margins = 277mm of paper, less a little slack. A normal prescription is shorter than this and is NOT shrunk; only a long one is shrunk, just enough to fit
const SHEET_W_MM = 190;   // the width the sheet is laid out at when printed (A4 less the margins)
function useFitOnePage(wrap: React.RefObject<HTMLDivElement>, on: boolean) {
  useEffect(() => {
    if (!on) return;
    const mm = (px: number) => px * 25.4 / 96;
    const fit = () => {
      const el = wrap.current?.firstElementChild as HTMLElement | null; if (!el) return;
      el.style.zoom = ''; el.style.minHeight = '0';
      // Measure the sheet the way it PRINTS: 190mm wide (A4 less the margins), no screen padding, border or shadow. The screen layout is
      // narrower, so measuring it would give the wrong height.
      const keep = { width: el.style.width, maxWidth: el.style.maxWidth, padding: el.style.padding, border: el.style.border, overflowWrap: el.style.overflowWrap };
      Object.assign(el.style, { width: `${SHEET_W_MM}mm`, maxWidth: 'none', padding: '0', border: '0', overflowWrap: 'normal' });
      const h = mm(el.getBoundingClientRect().height);
      Object.assign(el.style, keep);
      const z = h > PAGE_MM ? Math.max(0.5, PAGE_MM / h) : 1;
      if (z < 1) el.style.zoom = String(z);
      el.style.minHeight = `${PAGE_MM / z}mm`;   // the footer sits at the foot of the page
    };
    const reset = () => { const el = wrap.current?.firstElementChild as HTMLElement | null; if (el) { el.style.zoom = ''; el.style.minHeight = ''; } };
    window.addEventListener('beforeprint', fit); window.addEventListener('afterprint', reset);
    return () => { window.removeEventListener('beforeprint', fit); window.removeEventListener('afterprint', reset); };
  }, [wrap, on]);
}

function Frame({ title, back, children, ready, fit }: { title: string; back: string; children: ReactNode; ready: boolean; fit?: boolean }) {
  const [sp] = useSearchParams(); const wrap = useRef<HTMLDivElement>(null); const [imgs, setImgs] = useState(false);
  useEffect(() => {   // wait for photos so they are on the paper
    if (!ready) return;
    const all = Array.from(wrap.current?.querySelectorAll('img') || []);
    let live = true;
    Promise.all(all.map((i) => (i.complete ? Promise.resolve() : new Promise<void>((r) => { i.onload = i.onerror = () => r(); })))).then(() => live && setImgs(true));
    return () => { live = false; };
  }, [ready]);
  useFitOnePage(wrap, !!fit);
  useEffect(() => { document.title = title; }, [title]);
  useEffect(() => { if (imgs && sp.get('auto') === '1') window.print(); }, [imgs, sp]);
  return (
    <div className="min-h-full bg-bg-2 py-4 print:bg-white print:py-0">
      <div className="no-print mx-auto mb-3 flex max-w-[210mm] items-center justify-between gap-3 px-3">
        <Link to={back} className="text-sm text-fg-2 hover:underline">← Back to the CRM</Link>
        <Button variant="primary" icon={<Printer className="h-4 w-4" />} onClick={() => window.print()} disabled={!imgs}>{imgs ? 'Print' : 'Loading photos…'}</Button>
      </div>
      <div ref={wrap}>{children}</div>
    </div>
  );
}
const Loading = () => <div className="mx-auto max-w-[210mm] space-y-3 p-8"><Skeleton className="h-6 w-1/2" /><Skeleton className="h-4 w-full" /><Skeleton className="h-4 w-2/3" /></div>;

export function PrintPrescription() {
  const { ws } = useWs(); const { rxId = '' } = useParams();
  const clinic = useClinic();
  const rx = useQuery({ queryKey: ['rx', ws.id, rxId], queryFn: () => api<Prescription>(wsPath(ws.id, `/prescriptions/${rxId}`)) });
  const pt = useQuery({ queryKey: ['patient', ws.id, rx.data?.patientId], queryFn: () => api<PatientProfile>(wsPath(ws.id, `/patients/${rx.data!.patientId}`)), enabled: !!rx.data });
  const err = rx.error || pt.error || clinic.error;
  const ready = !!(rx.data && pt.data && clinic.data);
  return (
    <Frame fit title={`Prescription ${rxId}`} back={`/w/${ws.id}/prescriptions/${rxId}`} ready={ready}>
      {err ? <ErrorState error={err} /> : !ready ? <Loading /> : <PrescriptionDocument clinic={clinic.data!} rx={rx.data!} patient={pt.data!.patient} imageUrl={(id) => `/api${wsPath(ws.id, `/prescriptions/${rxId}/images/${id}`)}`} />}
    </Frame>
  );
}

export function PrintInvoice() {
  const { ws } = useWs(); const { invoiceNo = '' } = useParams();
  const clinic = useClinic();
  const inv = useQuery({ queryKey: ['invoice', ws.id, invoiceNo], queryFn: () => api<Invoice>(wsPath(ws.id, `/invoices/${invoiceNo}`)) });
  const pt = useQuery({ queryKey: ['patient', ws.id, inv.data?.patientId], queryFn: () => api<PatientProfile>(wsPath(ws.id, `/patients/${inv.data!.patientId}`)), enabled: !!inv.data });
  const err = inv.error || pt.error || clinic.error;
  const ready = !!(inv.data && pt.data && clinic.data);
  return (
    <Frame title={`Invoice ${invoiceNo}`} back={`/w/${ws.id}/invoices/${invoiceNo}`} ready={ready}>
      {err ? <ErrorState error={err} /> : !ready ? <Loading /> : <InvoiceDocument clinic={clinic.data!} inv={inv.data!} patient={pt.data!.patient} />}
    </Frame>
  );
}
