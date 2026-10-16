// Settings show only what really exists: FLOW HQ's own workspace profile (industry, name, logo, words, modules) and the
// backend's own settings, as the backend describes them. Keys, tokens and credentials never reach this page.
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, Bell, Blocks, Building2, CheckCircle2, Clock, Languages, Lock, MessageCircle, Palette, Plug, Sparkles, Users, Workflow, XCircle, CircleDashed, type LucideIcon } from 'lucide-react';
import type { ModuleKey, SettingField, SettingsSection, SettingsView, Workspace } from '@core/domain';
import { INDUSTRIES } from '@core/industries';
import { MODULES } from '@core/registry';
import { EDITABLE_NOUNS, fmt, mergeTerminology, type TerminologyOverrides } from '@core/terminology';
import { api, ws as wsPath } from '../lib/api';
import { useWs } from '../lib/workspace';
import { useTheme } from '../lib/theme';
import { icon } from '../lib/icons';
import { cn } from '../lib/cn';
import { Page } from '../components/layout/Shell';
import { Avatar, Badge, Button, Card, CardHeader, Input, Segmented, Select, Switch, Textarea } from '../components/ui/primitives';
import { ErrorState, SkeletonRows, useToast } from '../components/ui/feedback';

const SECTIONS: Array<{ key: SettingsSection; label: string; icon: LucideIcon }> = [
  { key: 'workspace', label: 'Workspace', icon: Building2 },
  { key: 'branding', label: 'Branding', icon: Palette },
  { key: 'terminology', label: 'Terminology', icon: Languages },
  { key: 'team', label: 'Team', icon: Users },
  { key: 'channels', label: 'Channels', icon: MessageCircle },
  { key: 'ai', label: '{ai.short}', icon: Sparkles },
  { key: 'automations', label: 'Automations', icon: Workflow },
  { key: 'notifications', label: 'Notifications', icon: Bell },
  { key: 'business_hours', label: 'Business hours', icon: Clock },
  { key: 'integrations', label: 'Integrations', icon: Plug },
];
const NOUN_LABEL: Record<(typeof EDITABLE_NOUNS)[number], string> = { contact: 'The people you serve', booking: 'What they book', service: 'What you offer', staff: 'Who serves them', workspace: 'Your business' };

export default function Settings() {
  const { ws, tt, has, isAdmin } = useWs();
  const { section = 'workspace' } = useParams();
  const nav = useNavigate();
  const sections = SECTIONS.filter((s) => s.key !== 'ai' || has('ai'));
  const current = (sections.find((s) => s.key === section) || sections[0]).key;
  const q = useQuery({ queryKey: ['settings', ws.id], queryFn: () => api<SettingsView>(wsPath(ws.id, '/settings')) });
  return (
    <Page title="Settings" subtitle={isAdmin ? 'Changes apply to this workspace only.' : 'You can see these settings; an admin can change them.'}>
      <div className="grid gap-6 lg:grid-cols-[220px_1fr]">
        <nav aria-label="Settings sections" className="lg:sticky lg:top-20 lg:h-fit">
          <div className="lg:hidden"><Select value={current} onChange={(e) => nav(`/w/${ws.id}/settings/${e.target.value}`)} aria-label="Section">{sections.map((s) => <option key={s.key} value={s.key}>{tt(s.label)}</option>)}</Select></div>
          <ul className="hidden space-y-0.5 lg:block">
            {sections.map((s) => (
              <li key={s.key}>
                <Link to={`/w/${ws.id}/settings/${s.key}`} aria-current={current === s.key ? 'page' : undefined} className={cn('flex h-9 items-center gap-2.5 rounded-lg px-2.5 text-[13.5px] transition-colors', current === s.key ? 'bg-blue/[0.12] font-medium text-fg shadow-[inset_0_0_0_1px_rgb(var(--blue)/0.25)]' : 'text-fg-2 hover:bg-surface hover:text-fg')}>
                  <s.icon className={cn('h-4 w-4', current === s.key ? 'text-blue-bright' : 'text-muted')} />{tt(s.label)}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        <div className="min-w-0 space-y-5">
          {q.error ? <Card><ErrorState error={q.error} retry={() => q.refetch()} /></Card> : !q.data ? <Card><SkeletonRows rows={6} /></Card> : <Section section={current} view={q.data} />}
        </div>
      </div>
    </Page>
  );
}

function Section({ section, view }: { section: SettingsSection; view: SettingsView }) {
  const { ws, tt } = useWs();
  const fields = view.fields.filter((f) => f.section === section);
  const backendFields = fields.length ? <FieldsCard title={section === 'workspace' ? tt('{workspace.singular} details') : 'Settings'} subtitle="Stored in your CRM and read by your automations" fields={fields} /> : null;
  switch (section) {
    case 'workspace': return <><ProfileCard /><ModulesCard />{backendFields}</>;
    case 'branding': return <BrandingCard />;
    case 'terminology': return <TerminologyCard />;
    case 'team': return <TeamCard view={view} />;
    case 'channels': return <><Card><CardHeader title="Channels" subtitle="Where conversations come from" /><div className="grid gap-3 p-5 md:grid-cols-2">{view.channels.map((c) => <StatusTile key={c.key} label={c.label} status={c.status} detail={tt(c.detail)} />)}</div></Card>{backendFields}</>;
    case 'ai': return <>{backendFields}<LinkCard to={`/w/${ws.id}/ai`} text={tt('Mode, decisions and knowledge base live on the {ai.short} page')} /></>;
    case 'automations': return <>{backendFields}<LinkCard to={`/w/${ws.id}/automations`} text="Switch automations on or off and see how they run on the Automations page" /></>;
    case 'integrations': return (
      <Card>
        <CardHeader title="Integrations" subtitle="Connected systems, as the server sees them" />
        <div className="grid gap-3 p-5 md:grid-cols-2">{view.integrations.map((i) => <StatusTile key={i.key} label={i.label} status={i.status} detail={tt(i.detail)} />)}</div>
        <p className="flex items-center gap-2 border-t border-line px-5 py-3 text-[12px] text-muted"><Lock className="h-3.5 w-3.5" />Keys and tokens stay on the server. They are never shown, stored in the browser or editable here.</p>
      </Card>
    );
    default: return backendFields || <Card><p className="p-5 text-[13px] text-muted">Nothing to set here for this backend.</p></Card>;
  }
}

function LinkCard({ to, text }: { to: string; text: string }) {
  return <Link to={to} className="card card-hover flex items-center justify-between gap-3 px-5 py-4 text-[13px] text-fg-2 hover:text-fg"><span>{text}</span><ArrowRight className="h-4 w-4 text-blue-bright" /></Link>;
}

function StatusTile({ label, status, detail }: { label: string; status: string; detail: string }) {
  const ok = status === 'connected';
  return (
    <div className="rounded-xl border border-line bg-bg-2 p-4">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[13.5px] font-medium">{label}</span>
        <Badge tone={ok ? 'green' : status === 'error' || status === 'not_connected' ? 'red' : 'neutral'} icon={ok ? <CheckCircle2 className="h-3 w-3" /> : status === 'unknown' ? <CircleDashed className="h-3 w-3" /> : <XCircle className="h-3 w-3" />}>{ok ? 'Connected' : status === 'unknown' ? 'No activity yet' : status === 'error' ? 'Check' : 'Not connected'}</Badge>
      </div>
      <p className="mt-1.5 text-[12.5px] leading-relaxed text-fg-2">{detail}</p>
    </div>
  );
}

// ---------------------------------------------------------------- backend settings
function FieldsCard({ title, subtitle, fields }: { title: string; subtitle?: string; fields: SettingField[] }) {
  const { ws, tt, isAdmin } = useWs();
  const qc = useQueryClient();
  const toast = useToast();
  const initial = useMemo(() => Object.fromEntries(fields.map((f) => [f.key, f.value ?? ''])), [fields]);
  const [vals, setVals] = useState<Record<string, string>>(initial);
  useEffect(() => setVals(initial), [initial]);
  const dirty = Object.keys(vals).filter((k) => vals[k] !== initial[k]);
  const save = useMutation({
    mutationFn: () => api<SettingsView>(wsPath(ws.id, '/settings'), { method: 'PATCH', body: { values: Object.fromEntries(dirty.map((k) => [k, vals[k]])) } }),
    onSuccess: (r) => { qc.setQueryData(['settings', ws.id], r); ['automations', 'ai', 'conversations', 'workspace'].forEach((k) => qc.invalidateQueries({ queryKey: [k, ws.id] })); toast('ok', 'Settings saved'); },
    onError: (e: Error) => toast('bad', e.message),
  });
  const editable = isAdmin && fields.some((f) => f.editable);
  return (
    <Card>
      <CardHeader title={title} subtitle={subtitle} />
      <form className="divide-y divide-line/70 px-5 pb-2 pt-2" onSubmit={(e) => { e.preventDefault(); if (dirty.length) save.mutate(); }}>
        {fields.map((f) => (
          <div key={f.key} className="grid gap-2 py-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)] md:gap-6">
            <div>
              <label htmlFor={`s-${f.key}`} className="text-[13px] font-medium text-fg" title={f.key}>{tt(f.label)}{f.sensitive && <Lock className="ml-1.5 inline h-3 w-3 text-muted" aria-label="private" />}</label>
              {f.help && <p className="mt-0.5 text-[12px] leading-relaxed text-muted">{tt(f.help)}</p>}
            </div>
            <div className="flex items-start">{<FieldInput f={f} value={vals[f.key] ?? ''} onChange={(v) => setVals((s) => ({ ...s, [f.key]: v }))} disabled={!f.editable || !isAdmin} />}</div>
          </div>
        ))}
        {editable && (
          <div className="flex items-center justify-end gap-2 py-3">
            {dirty.length > 0 && <span className="mr-auto text-[12px] text-fg-2">{dirty.length} unsaved change{dirty.length === 1 ? '' : 's'}</span>}
            <Button type="button" variant="ghost" disabled={!dirty.length || save.isPending} onClick={() => setVals(initial)}>Discard</Button>
            <Button type="submit" variant="primary" disabled={!dirty.length} loading={save.isPending}>Save changes</Button>
          </div>
        )}
      </form>
    </Card>
  );
}

function FieldInput({ f, value, onChange, disabled }: { f: SettingField; value: string; onChange: (v: string) => void; disabled: boolean }) {
  const id = `s-${f.key}`;
  if (f.type === 'boolean') return <div className="flex items-center gap-2.5 pt-0.5"><Switch checked={value === 'on'} onChange={(v) => onChange(v ? 'on' : 'off')} disabled={disabled} label={f.label} /><span className="text-[12.5px] text-fg-2">{value === 'on' ? 'On' : 'Off'}</span></div>;
  if (f.type === 'choice') return f.options && f.options.length <= 3
    ? <Segmented value={value} onChange={(v) => !disabled && onChange(v)} options={f.options} />
    : <Select id={id} value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled}>{!value && <option value="">Not set</option>}{(f.options || []).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</Select>;
  if (f.type === 'textarea') return <Textarea id={id} value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled} rows={3} maxLength={2000} placeholder="Not set" />;
  return <Input id={id} value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled} placeholder={f.type === 'time' ? 'HH:MM' : f.type === 'url' ? 'https://' : f.type === 'phone' ? '+country number' : 'Not set'}
    type={f.type === 'url' ? 'url' : f.type === 'phone' ? 'tel' : 'text'} inputMode={f.type === 'number' ? 'numeric' : undefined} maxLength={300} autoComplete="off" />;
}

// ---------------------------------------------------------------- FLOW HQ workspace profile
function useProfile() {
  const { ws } = useWs();
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: (patch: Record<string, unknown>) => api<Workspace>(wsPath(ws.id, '/profile'), { method: 'PATCH', body: patch }),
    onSuccess: (r) => { qc.setQueryData(['workspace', ws.id], r); qc.invalidateQueries({ queryKey: ['me'] }); qc.invalidateQueries({ queryKey: ['automations', ws.id] }); toast('ok', 'Workspace updated'); },
    onError: (e: Error) => toast('bad', e.message),
  });
}

function ProfileCard() {
  const { ws, me, isAdmin } = useWs();
  const save = useProfile();
  const [name, setName] = useState(ws.name);
  const [industry, setIndustry] = useState<string>(ws.industry);
  useEffect(() => { setName(ws.name); setIndustry(ws.industry); }, [ws.name, ws.industry]);
  const dirty = name.trim() !== ws.name || industry !== ws.industry;
  const desc = me.industries.find((i) => i.key === industry)?.description;
  return (
    <Card>
      <CardHeader title="Workspace" subtitle="The industry sets the words and the default modules. The design stays the same." />
      <form className="grid gap-4 p-5 md:grid-cols-2" onSubmit={(e) => { e.preventDefault(); save.mutate({ displayName: name, industry }); }}>
        <label className="block"><span className="mb-1.5 block text-[12.5px] text-fg-2">Display name</span><Input value={name} onChange={(e) => setName(e.target.value)} disabled={!isAdmin} maxLength={80} /></label>
        <label className="block"><span className="mb-1.5 block text-[12.5px] text-fg-2">Industry</span>
          <Select value={industry} onChange={(e) => setIndustry(e.target.value)} disabled={!isAdmin}>{me.industries.map((i) => <option key={i.key} value={i.key}>{i.label}</option>)}</Select>
          {desc && <span className="mt-1.5 block text-[12px] text-muted">{desc}</span>}
        </label>
        {isAdmin && <div className="flex justify-end gap-2 md:col-span-2"><Button type="submit" variant="primary" disabled={!dirty || !name.trim()} loading={save.isPending}>Save</Button></div>}
      </form>
    </Card>
  );
}

function ModulesCard() {
  const { ws, tt, isAdmin } = useWs();
  const save = useProfile();
  const defaults = INDUSTRIES[ws.industry].modules;
  const optional = (Object.values(MODULES).filter((m) => !m.core)).sort((a, b) => a.order - b.order);
  const toggle = (m: ModuleKey, on: boolean) => {
    const want = new Set(ws.modules.filter((x) => !MODULES[x].core));
    if (on) want.add(m); else want.delete(m);
    save.mutate({ modules: { enable: [...want].filter((x) => !defaults.includes(x)), disable: defaults.filter((x) => !want.has(x)) } });
  };
  return (
    <Card>
      <CardHeader title="Modules" subtitle="Turn parts of FLOW HQ on or off. Only what the connected backend can power can be switched on." icon={<Blocks className="h-4 w-4" />} />
      <ul className="grid gap-px overflow-hidden p-5 sm:grid-cols-2 xl:grid-cols-3">
        {optional.map((m) => {
          const supported = ws.backend.modules.includes(m.key);
          const on = ws.modules.includes(m.key);
          const Icon = icon(m.icon);
          return (
            <li key={m.key} className={cn('flex items-center gap-3 rounded-lg px-2 py-2.5', !supported && 'opacity-50')}>
              <span className={cn('flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border', on ? 'border-blue/30 bg-blue/10 text-blue-bright' : 'border-line bg-surface-2 text-muted')}><Icon className="h-4 w-4" /></span>
              <div className="min-w-0 flex-1"><div className="truncate text-[13px] font-medium">{tt(m.label)}</div><div className="truncate text-[11.5px] text-muted">{!supported ? 'Not available with this backend' : m.page ? 'Page and automations' : 'Automations and numbers'}</div></div>
              <Switch checked={on && supported} onChange={(v) => toggle(m.key, v)} disabled={!supported || !isAdmin || save.isPending} label={tt(m.label)} />
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

function BrandingCard() {
  const { ws, isAdmin } = useWs();
  const { theme, toggle } = useTheme();
  const save = useProfile();
  const [logo, setLogo] = useState(ws.logoUrl || '');
  useEffect(() => setLogo(ws.logoUrl || ''), [ws.logoUrl]);
  const valid = !logo || /^https:\/\/[^\s<>"']+$/i.test(logo);
  return (
    <>
      <Card>
        <CardHeader title="Logo" subtitle="Shown in the workspace switcher. Use an https image link." />
        <form className="flex flex-wrap items-end gap-4 p-5" onSubmit={(e) => { e.preventDefault(); save.mutate({ logoUrl: logo }); }}>
          <Avatar text={ws.initials} src={valid && logo ? logo : null} size={56} tone="blue" />
          <label className="block min-w-[240px] flex-1"><span className="mb-1.5 block text-[12.5px] text-fg-2">Logo URL</span><Input value={logo} onChange={(e) => setLogo(e.target.value)} disabled={!isAdmin} placeholder="https://" maxLength={500} aria-invalid={!valid} /></label>
          {isAdmin && <Button type="submit" variant="primary" disabled={!valid || logo === (ws.logoUrl || '')} loading={save.isPending}>Save</Button>}
        </form>
      </Card>
      <Card>
        <CardHeader title="Appearance" subtitle="Saved on this device only" />
        <div className="flex items-center justify-between gap-3 p-5">
          <span className="text-[13px] text-fg-2">Theme</span>
          <Segmented value={theme} onChange={(v) => v !== theme && toggle()} options={[{ value: 'dark', label: 'Dark' }, { value: 'light', label: 'Light' }]} />
        </div>
      </Card>
    </>
  );
}

function TerminologyCard() {
  const { ws, isAdmin } = useWs();
  const save = useProfile();
  const base = INDUSTRIES[ws.industry].terminology;
  const init = () => ({ ...Object.fromEntries(EDITABLE_NOUNS.flatMap((n) => [[`${n}.singular`, ws.terminology[n].singular], [`${n}.plural`, ws.terminology[n].plural]])), 'ai.name': ws.terminology.ai.name }) as Record<string, string>;
  const [v, setV] = useState<Record<string, string>>(init);
  useEffect(() => setV(init()), [ws.terminology]); // eslint-disable-line react-hooks/exhaustive-deps
  const overrides = (vals: Record<string, string>): TerminologyOverrides => {
    const out: Record<string, Record<string, string>> = {};
    for (const n of EDITABLE_NOUNS) for (const k of ['singular', 'plural'] as const) {
      const val = (vals[`${n}.${k}`] || '').trim();
      if (val && val !== base[n][k]) (out[n] ||= {})[k] = val;
    }
    const ai = (vals['ai.name'] || '').trim();
    if (ai && ai !== base.ai.name) out.ai = { name: ai };
    return out as TerminologyOverrides;
  };
  const preview = mergeTerminology(base, overrides(v));
  const dirty = JSON.stringify(overrides(v)) !== JSON.stringify(overrides(init()));
  const custom = Object.keys(overrides(init())).length > 0;
  return (
    <Card>
      <CardHeader title="Terminology" subtitle={`Starts from the ${INDUSTRIES[ws.industry].label} profile. Rename any word: every page, metric and automation follows.`} />
      <form className="p-5" onSubmit={(e) => { e.preventDefault(); save.mutate({ terminology: overrides(v) }); }}>
        <div className="grid gap-x-6 gap-y-4 md:grid-cols-2">
          {EDITABLE_NOUNS.map((n) => (
            <fieldset key={n} className="rounded-xl border border-line bg-bg-2 p-4">
              <legend className="px-1 text-[12px] text-muted">{NOUN_LABEL[n]}</legend>
              <div className="grid grid-cols-2 gap-3">
                <label><span className="mb-1 block text-[11.5px] text-fg-2">Singular</span><Input value={v[`${n}.singular`]} placeholder={base[n].singular} onChange={(e) => setV((s) => ({ ...s, [`${n}.singular`]: e.target.value }))} disabled={!isAdmin} maxLength={40} /></label>
                <label><span className="mb-1 block text-[11.5px] text-fg-2">Plural</span><Input value={v[`${n}.plural`]} placeholder={base[n].plural} onChange={(e) => setV((s) => ({ ...s, [`${n}.plural`]: e.target.value }))} disabled={!isAdmin} maxLength={40} /></label>
              </div>
            </fieldset>
          ))}
          <fieldset className="rounded-xl border border-blue/25 bg-blue/[0.05] p-4">
            <legend className="flex items-center gap-1 px-1 text-[12px] text-blue-soft"><Sparkles className="h-3 w-3" />Assistant name</legend>
            <Input value={v['ai.name']} placeholder={base.ai.name} onChange={(e) => setV((s) => ({ ...s, 'ai.name': e.target.value }))} disabled={!isAdmin} maxLength={40} />
          </fieldset>
        </div>
        <div className="mt-5 rounded-xl border border-line bg-bg-2 p-4 text-[13px] text-fg-2">
          <div className="label mb-2">Preview</div>
          <p>{fmt('3 new {contact.plural|lower} today. 2 have {booking.singular|a} tomorrow with a {staff.singular|lower}; the {ai.name} answered the rest.', preview)}</p>
        </div>
        {isAdmin && (
          <div className="mt-4 flex justify-end gap-2">
            {custom && <Button type="button" variant="ghost" onClick={() => save.mutate({ terminology: {} })} disabled={save.isPending}>Reset to the industry words</Button>}
            <Button type="submit" variant="primary" disabled={!dirty} loading={save.isPending}>Save words</Button>
          </div>
        )}
      </form>
    </Card>
  );
}

function TeamCard({ view }: { view: SettingsView }) {
  const { tt } = useWs();
  return (
    <>
      <Card>
        <CardHeader title="People with access" subtitle="Accounts are managed by your FLOW HQ administrator" />
        <ul className="divide-y divide-line/70 px-5 pb-2 pt-2">
          {view.team.users.map((u) => (
            <li key={u.email} className="flex items-center gap-3 py-3">
              <Avatar text={u.name.split(' ').map((w) => w[0]).join('').slice(0, 2).toUpperCase()} size={32} />
              <div className="min-w-0 flex-1"><div className="truncate text-[13px] font-medium">{u.name}</div><div className="truncate text-[12px] text-muted">{u.email}</div></div>
              <Badge tone={u.role === 'admin' ? 'blue' : 'neutral'}>{u.role === 'admin' ? 'Admin' : 'Staff'}</Badge>
            </li>
          ))}
        </ul>
      </Card>
      <Card>
        <CardHeader title={tt('Names in your data')} subtitle={tt('{staff.plural} and owners as they appear on {contact.plural|lower}, {booking.plural|lower} and replies')} />
        <div className="flex flex-wrap gap-2 p-5">{view.team.namesInData.length ? view.team.namesInData.map((n) => <Badge key={n}>{n}</Badge>) : <span className="text-[13px] text-muted">None yet</span>}</div>
      </Card>
    </>
  );
}


