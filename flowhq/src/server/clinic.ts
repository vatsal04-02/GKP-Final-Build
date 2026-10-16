// Clinic identity for letterheads and invoice rules (public business details, no secrets). Source: config/clinic.json
// ("default" applies to every workspace; "workspaces": { "<slug>": {...} } overrides fields for one). `tax` stays null unless the
// clinic gives a real label and rate, e.g. { "label": "GST", "ratePercent": 5 }: no tax rate is ever assumed.
import { existsSync, readFileSync } from 'node:fs';
import type { ClinicConfig } from './records/service';

const EMPTY: ClinicConfig = { idPrefix: 'GK', name: '', tagline: '', address: '', phones: [], timings: '', runBy: '', clinicians: [], tax: null };
const str = (v: unknown, d = '') => (typeof v === 'string' ? v : d);

function clean(raw: Record<string, unknown>, base: ClinicConfig): ClinicConfig {
  const t = raw.tax as { label?: unknown; ratePercent?: unknown } | null | undefined;
  const rate = typeof t?.ratePercent === 'number' ? t.ratePercent : NaN;
  return {
    idPrefix: /^[A-Z0-9]{1,6}$/.test(str(raw.idPrefix)) ? str(raw.idPrefix) : base.idPrefix,
    name: str(raw.name, base.name), tagline: str(raw.tagline, base.tagline), address: str(raw.address, base.address), timings: str(raw.timings, base.timings), runBy: str(raw.runBy, base.runBy),
    phones: Array.isArray(raw.phones) ? raw.phones.map(String).slice(0, 5) : base.phones,
    clinicians: Array.isArray(raw.clinicians) ? raw.clinicians.slice(0, 6).map((c: Record<string, unknown>) => ({ name: str(c.name), qualifications: str(c.qualifications), regNo: str(c.regNo), mobile: str(c.mobile) })) : base.clinicians,
    tax: 'tax' in raw ? (t && str(t.label) && rate > 0 && rate <= 100 ? { label: str(t.label).slice(0, 20), ratePercent: Math.round(rate * 100) / 100 } : null) : base.tax,
  };
}
export function loadClinicConfig(file: string): (slug: string, workspaceName: string) => ClinicConfig {
  let doc: { default?: Record<string, unknown>; workspaces?: Record<string, Record<string, unknown>> } = {};
  try { if (existsSync(file)) doc = JSON.parse(readFileSync(file, 'utf8')); else console.warn(`FLOW HQ: ${file} not found; letterheads will carry only the workspace name`); }
  catch (e) { throw new Error(`Cannot read clinic config ${file}: ${(e as Error).message}`); }
  const def = clean(doc.default || {}, EMPTY);
  return (slug, name) => { const c = clean(doc.workspaces?.[slug] || {}, def); return { ...c, name: c.name || name }; };
}
