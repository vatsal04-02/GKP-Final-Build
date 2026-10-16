// FLOW HQ's own per-workspace profile: industry, terminology overrides, enabled modules, logo. This is presentation config,
// kept by FLOW HQ (config/workspaces.json), not by the backend: the backend has no such fields and none were invented there.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { IndustryKey, MetricKey, ModuleKey } from '../core/domain';
import { isIndustry } from '../core/industries';
import { MODULES, METRICS } from '../core/registry';
import type { TerminologyOverrides } from '../core/terminology';

export interface WorkspaceProfile {
  industry: IndustryKey;
  displayName?: string;
  logoUrl?: string;
  terminology?: TerminologyOverrides;
  modules?: { enable?: ModuleKey[]; disable?: ModuleKey[] };
  dashboardMetrics?: MetricKey[];
}
interface FileShape { workspaces: Record<string, WorkspaceProfile> }

export class ProfileStore {
  private data: FileShape = { workspaces: {} };
  constructor(private file: string | null, private defaultIndustry: IndustryKey, seed?: Record<string, WorkspaceProfile>) {
    if (file && existsSync(file)) this.data = JSON.parse(readFileSync(file, 'utf8')) as FileShape;
    if (!this.data.workspaces) this.data.workspaces = {};
    if (seed) for (const [k, v] of Object.entries(seed)) if (!this.data.workspaces[k]) this.data.workspaces[k] = v;
  }
  get(id: string): WorkspaceProfile { const p = this.data.workspaces[id]; return { ...(p || {}), industry: p && isIndustry(p.industry) ? p.industry : this.defaultIndustry }; }
  update(id: string, patch: Partial<WorkspaceProfile>): WorkspaceProfile {
    const cur = this.get(id);
    const next: WorkspaceProfile = { ...cur };
    if (patch.industry !== undefined) { if (!isIndustry(patch.industry)) throw new Error('unknown industry'); next.industry = patch.industry; }
    if (patch.displayName !== undefined) next.displayName = String(patch.displayName).trim().slice(0, 80) || undefined;
    if (patch.logoUrl !== undefined) { const v = String(patch.logoUrl).trim(); if (v && !/^https:\/\/[^\s<>"']+$/i.test(v)) throw new Error('logo must be an https URL'); next.logoUrl = v || undefined; }
    if (patch.terminology !== undefined) next.terminology = sanitizeTerms(patch.terminology);
    if (patch.modules !== undefined) next.modules = { enable: (patch.modules.enable || []).filter((m) => m in MODULES), disable: (patch.modules.disable || []).filter((m) => m in MODULES && !MODULES[m].core) };
    if (patch.dashboardMetrics !== undefined) next.dashboardMetrics = patch.dashboardMetrics.filter((m) => m in METRICS);
    this.data.workspaces[id] = next;
    this.save();
    return next;
  }
  private save() {
    if (!this.file) return;
    mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(this.data, null, 2)}\n`);
    renameSync(tmp, this.file);
  }
}

// Only the renameable nouns, short plain strings.
function sanitizeTerms(t: TerminologyOverrides): TerminologyOverrides {
  const out: Record<string, { singular?: string; plural?: string }> = {};
  for (const noun of ['contact', 'booking', 'service', 'staff', 'workspace'] as const) {
    const v = (t as Record<string, { singular?: string; plural?: string } | undefined>)[noun];
    if (!v) continue;
    const clean = (s?: string) => (s ? String(s).replace(/[<>{}]/g, '').trim().slice(0, 40) : undefined);
    const entry = { singular: clean(v.singular), plural: clean(v.plural) };
    if (entry.singular || entry.plural) out[noun] = entry;
  }
  const ai = (t as { ai?: { name?: string } }).ai;
  const res = out as TerminologyOverrides;
  if (ai && ai.name) (res as { ai?: { name: string } }).ai = { name: String(ai.name).replace(/[<>{}]/g, '').trim().slice(0, 40) };
  return res;
}
