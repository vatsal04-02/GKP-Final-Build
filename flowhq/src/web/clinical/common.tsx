// Shared pieces for the clinical screens (register, prescriptions, invoices, attendance).
import { cloneElement, isValidElement, useEffect, useId, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Search, X } from 'lucide-react';
import type { ClinicProfile, PatientList } from '@core/clinical';
import type { PaymentStatus } from '@core/money';
import { api, ApiError, ws as wsPath } from '../lib/api';
import { useWs } from '../lib/workspace';
import { Badge, Input, type Tone } from '../components/ui/primitives';

export { formatRupees as rs } from '@core/money';
export const fdate = (d: string | null | undefined) => (d ? `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}` : '—');
export const errText = (e: unknown) => (e instanceof ApiError ? e.message : e instanceof Error ? e.message : 'Something went wrong');
export const newKey = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `k-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);

// today's date (YYYY-MM-DD) in the workspace's time zone
export function useToday() { const { ws } = useWs(); return new Date().toLocaleDateString('en-CA', { timeZone: ws.timezone }); }
export function useClinic() {
  const { ws } = useWs();
  return useQuery({ queryKey: ['clinic', ws.id], queryFn: () => api<ClinicProfile>(wsPath(ws.id, '/clinic')), staleTime: 300000 });
}
export function useDebounced<T>(v: T, ms = 250): T { const [x, setX] = useState(v); useEffect(() => { const t = setTimeout(() => setX(v), ms); return () => clearTimeout(t); }, [v, ms]); return x; }

export function Field({ label, children, hint, error, className, required }: { label: string; children: ReactNode; hint?: ReactNode; error?: string; className?: string; required?: boolean }) {
  // the label is tied to its control by id (not wrapped around it), so the accessible name is only the label text
  const id = useId();
  return (
    <div className={className}>
      <label htmlFor={id} className="mb-1 block text-[12.5px] font-medium text-fg-2">{label}{required && <span className="text-bad"> *</span>}</label>
      {isValidElement(children) ? cloneElement(children as ReactElement<{ id?: string }>, { id }) : children}
      {error ? <span className="mt-1 block text-[12px] text-bad" role="alert">{error}</span> : hint ? <span className="mt-1 block text-[12px] text-muted">{hint}</span> : null}
    </div>
  );
}

const PAY_TONE: Record<PaymentStatus, Tone> = { paid: 'green', partial: 'amber', unpaid: 'red', void: 'neutral' };
const PAY_LABEL: Record<PaymentStatus, string> = { paid: 'Paid', partial: 'Part paid', unpaid: 'Unpaid', void: 'Void' };
export const PaymentBadge = ({ status }: { status: PaymentStatus }) => <Badge tone={PAY_TONE[status]}>{PAY_LABEL[status]}</Badge>;

// Search-as-you-type patient chooser (the stable Patient ID is what gets saved).
export function PatientPicker({ value, onChange, disabled }: { value: { id: string; name: string } | null; onChange: (p: { id: string; name: string } | null) => void; disabled?: boolean }) {
  const { ws } = useWs();
  const [q, setQ] = useState(''); const [open, setOpen] = useState(false); const box = useRef<HTMLDivElement>(null);
  const dq = useDebounced(q);
  const list = useQuery({ queryKey: ['picker', ws.id, dq], queryFn: () => api<PatientList>(wsPath(ws.id, `/patients?q=${encodeURIComponent(dq)}&pageSize=8&sort=name`)), enabled: open && !value });
  useEffect(() => { const h = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); }; document.addEventListener('mousedown', h); return () => document.removeEventListener('mousedown', h); }, []);
  if (value) return (
    <div className="flex h-9 items-center justify-between gap-2 rounded-lg border border-line bg-surface px-3 text-sm">
      <span className="truncate"><span className="font-medium">{value.name}</span> <span className="text-muted">· {value.id}</span></span>
      {!disabled && <button type="button" onClick={() => onChange(null)} className="rounded p-0.5 text-muted hover:text-fg" aria-label="Choose a different patient"><X className="h-4 w-4" /></button>}
    </div>
  );
  return (
    <div ref={box} className="relative">
      <Input icon={<Search className="h-4 w-4" />} placeholder="Search name, phone or patient ID" value={q} onChange={(e) => { setQ(e.target.value); setOpen(true); }} onFocus={() => setOpen(true)} role="combobox" aria-expanded={open} aria-label="Patient" />
      {open && (
        <ul role="listbox" className="absolute z-30 mt-1 max-h-64 w-full overflow-auto rounded-xl border border-line bg-elevated p-1 shadow-pop">
          {list.isLoading ? <li className="px-3 py-2 text-[13px] text-muted">Searching…</li> : !list.data?.rows.length ? <li className="px-3 py-2 text-[13px] text-muted">No registered patient found</li> :
            list.data.rows.map((p) => (
              <li key={p.patientId}><button type="button" role="option" aria-selected={false} onClick={() => { onChange({ id: p.patientId, name: p.name }); setOpen(false); setQ(''); }} className="flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2 text-left text-[13px] hover:bg-surface-2">
                <span className="truncate font-medium">{p.name}</span><span className="shrink-0 text-muted">{p.patientId}{p.phone ? ` · ${p.phone}` : ''}</span></button></li>
            ))}
        </ul>
      )}
    </div>
  );
}

// Warn before leaving a form with unsaved changes.
export function useUnsavedGuard(dirty: boolean) {
  useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', h); return () => window.removeEventListener('beforeunload', h);
  }, [dirty]);
}
