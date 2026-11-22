// The app shell: cream sidebar, green active states, top bar with command palette, theme and account.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { NavLink, useNavigate, useLocation } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Check, ChevronDown, ChevronRight, ChevronsUpDown, Ellipsis, LogOut, Plus, Search, Trash2 } from 'lucide-react';
import { MOBILE_TABS, MODULES, NAV_GROUPS } from '@core/registry';
import { BRAND } from '@core/brand';
import type { ModuleKey } from '@core/domain';
import { useWs } from '../../lib/workspace';
import { icon } from '../../lib/icons';
import { api, ApiError } from '../../lib/api';
import { cn } from '../../lib/cn';
import { Avatar, Badge, Button, Input, Kbd } from '../ui/primitives';
import { Modal, Sheet, useToast } from '../ui/feedback';
import { initials } from '../../lib/format';
import { CommandPalette } from './CommandPalette';

export function Logo({ compact, large, onDark }: { compact?: boolean; large?: boolean; onDark?: boolean }) {
  // The clinic's own artwork: cream lettering on the green sidebar, deep-green lettering on the light pages.
  return <img src={`/brand/gkp-logo-${onDark ? 'dark' : 'light'}.png`} alt={BRAND.name} width={1200} height={694} className={cn('w-auto select-none', large ? 'h-28' : compact ? 'h-9' : 'h-[72px]')} draggable={false} />;
}

export function pagePath(wsId: string, m: ModuleKey) { const p = MODULES[m].page; return p === '/' ? `/w/${wsId}` : `/w/${wsId}${p}`; }

// Admin only: a new workspace is a separate, empty set of data (its own patients, records and settings).
function AddWorkspace({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  useEffect(() => { if (open) { setName(''); setErr(''); } }, [open]);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (name.trim().length < 2) { setErr('Enter a name of at least 2 characters'); return; }
    setBusy(true); setErr('');
    try {
      const w = await api<{ id: string; name: string }>('/workspaces', { method: 'POST', body: { name: name.trim() } });
      await qc.invalidateQueries({ queryKey: ['me'] });
      try { localStorage.setItem('fhq-ws', w.id); } catch { /* ignore */ }
      toast('ok', `${w.name} created`);
      onClose(); nav(`/w/${w.id}`);
    } catch (e2) { setErr(e2 instanceof ApiError ? e2.message : (e2 as Error).message); }
    finally { setBusy(false); }
  };
  return (
    <Modal open={open} onClose={onClose} label="Add workspace" className="max-w-md">
      <form onSubmit={submit} className="space-y-4 p-6">
        <div>
          <h2 className="font-display text-lg font-semibold">Add workspace</h2>
          <p className="mt-1 text-[13px] text-fg-2">A separate workspace with its own empty data: its own records and settings. Nothing is shared with your other workspaces.</p>
        </div>
        <label className="block"><span className="mb-1.5 block text-[12.5px] text-fg-2">Workspace name</span><Input autoFocus value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder="e.g. Branch 2" aria-invalid={!!err} /></label>
        {err && <p className="text-[12.5px] text-bad" role="alert">{err}</p>}
        <div className="modal-actions flex justify-end gap-2"><Button type="button" variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button><Button type="submit" variant="primary" loading={busy}>Create workspace</Button></div>
      </form>
    </Modal>
  );
}

// Admin only. This removes the workspace from FLOW HQ; its data is kept (nothing is erased). The main workspace has no delete button.
function RemoveWorkspace({ target, currentId, mainId, onClose }: { target: { id: string; name: string } | null; currentId: string; mainId: string; onClose: () => void }) {
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  useEffect(() => { setTyped(''); setErr(''); }, [target?.id]);
  if (!target) return null;
  const match = typed.trim().toLowerCase() === target.name.trim().toLowerCase();
  const go = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!match) return;
    setBusy(true); setErr('');
    try {
      await api(`/workspaces/${encodeURIComponent(target.id)}`, { method: 'DELETE' });
      await qc.invalidateQueries({ queryKey: ['me'] });
      toast('ok', `${target.name} deleted`);
      onClose();
      if (currentId === target.id) { try { localStorage.setItem('fhq-ws', mainId); } catch { /* ignore */ } nav(`/w/${mainId}`); }
    } catch (e2) { setErr(e2 instanceof ApiError ? e2.message : (e2 as Error).message); }
    finally { setBusy(false); }
  };
  return (
    <Modal open onClose={onClose} label="Delete workspace" className="max-w-md">
      <form onSubmit={go} className="space-y-4 p-6">
        <div>
          <h2 className="font-display text-lg font-semibold">Delete “{target.name}”?</h2>
          <p className="mt-1 text-[13px] text-fg-2">It disappears from FLOW HQ for everyone. Its data is kept safely and is not erased, so an administrator can bring it back.</p>
        </div>
        <label className="block"><span className="mb-1.5 block text-[12.5px] text-fg-2">Type <b className="font-medium text-fg">{target.name}</b> to confirm</span><Input autoFocus value={typed} onChange={(e) => setTyped(e.target.value)} /></label>
        {err && <p className="text-[12.5px] text-bad" role="alert">{err}</p>}
        <div className="modal-actions flex justify-end gap-2"><Button type="button" variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button><Button type="submit" variant="danger" loading={busy} disabled={!match}>Delete workspace</Button></div>
      </form>
    </Modal>
  );
}

function WorkspaceSwitcher() {
  const { ws, me } = useWs();
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<{ id: string; name: string } | null>(null);
  const nav = useNavigate();
  const mainId = me.workspaces.find((w) => w.protected)?.id || me.workspaces[0]?.id || '';
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); }; document.addEventListener('mousedown', h); return () => document.removeEventListener('mousedown', h); }, []);
  const industryLabel = (k: string) => me.industries.find((i) => i.key === k)?.label || k;
  return (
    <div ref={ref} className="relative">
      <button onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-2.5 rounded-xl border border-white/10 bg-white/[0.07] p-2 text-left text-white transition-colors hover:border-white/20 hover:bg-white/[0.12]" aria-haspopup="listbox" aria-expanded={open}>
        <Avatar text={ws.initials} src={ws.logoUrl} size={34} tone="neutral" />
        <div className="min-w-0 flex-1"><div className="truncate text-[13px] font-semibold">{ws.name}</div><div className="truncate text-[12px] text-side-muted">{industryLabel(ws.industry)}</div></div>
        <ChevronsUpDown className="h-4 w-4 text-side-muted" />
      </button>
      {open && (
        <div role="listbox" className="absolute bottom-full left-0 z-30 mb-2 w-full rounded-xl border border-line bg-elevated p-1 text-fg shadow-pop animate-fade-up">
          <div className="label px-2 pb-1 pt-1.5">Workspaces</div>
          {me.workspaces.map((w) => (
            <div key={w.id} role="option" aria-selected={w.id === ws.id} className="group flex items-center rounded-lg hover:bg-surface-2">
              <button type="button" onClick={() => { setOpen(false); try { localStorage.setItem('fhq-ws', w.id); } catch { /* ignore */ } nav(`/w/${w.id}`); }} className="flex min-w-0 flex-1 items-center gap-2.5 rounded-lg px-2 py-1.5 text-left">
                <Avatar text={w.initials} src={w.logoUrl} size={24} tone={w.id === ws.id ? 'blue' : 'neutral'} />
                <div className="min-w-0 flex-1"><div className="truncate text-[13px]">{w.name}</div><div className="truncate text-[12px] text-muted">{w.protected ? 'Main workspace' : industryLabel(w.industry)}</div></div>
                {w.id === ws.id && <Check className="h-4 w-4 shrink-0 text-blue-bright" />}
              </button>
              {me.canCreateWorkspace && !w.protected && (
                <button type="button" aria-label={`Delete ${w.name}`} title="Delete workspace" onClick={() => { setOpen(false); setRemoving({ id: w.id, name: w.name }); }} className="mr-1 rounded-md p-1.5 text-muted opacity-60 transition hover:bg-bad/10 hover:text-bad hover:opacity-100 focus-visible:opacity-100 group-hover:opacity-100"><Trash2 className="h-3.5 w-3.5" /></button>
              )}
            </div>
          ))}
          {me.canCreateWorkspace && (
            <button type="button" onClick={() => { setOpen(false); setAdding(true); }} className="mt-1 flex w-full items-center gap-2.5 rounded-lg border-t border-line px-2 py-2 text-left text-[13px] font-medium text-blue-bright hover:bg-surface-2">
              <span className="flex h-6 w-6 items-center justify-center rounded-md border border-dashed border-blue/50"><Plus className="h-3.5 w-3.5" /></span>Add workspace
            </button>
          )}
        </div>
      )}
      <AddWorkspace open={adding} onClose={() => setAdding(false)} />
      <RemoveWorkspace target={removing} currentId={ws.id} mainId={mainId} onClose={() => setRemoving(null)} />
    </div>
  );
}

function useOpenGroups() {
  const read = (): Record<string, boolean> => { try { return JSON.parse(localStorage.getItem('fhq-nav') || '{}') as Record<string, boolean>; } catch { return {}; } };
  const [closed, setClosed] = useState<Record<string, boolean>>(read);
  const toggle = (k: string) => setClosed((c) => { const n = { ...c, [k]: !c[k] }; try { localStorage.setItem('fhq-nav', JSON.stringify(n)); } catch { /* private mode */ } return n; });
  return { isOpen: (k: string) => !closed[k], toggle };
}

function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const { ws, tt } = useWs();
  const g = useOpenGroups();
  const on = (m: ModuleKey) => ws.modules.includes(m) && MODULES[m].page !== null;
  const byOrder = (a: ModuleKey, b: ModuleKey) => MODULES[a].order - MODULES[b].order;
  const grouped = new Set<ModuleKey>(NAV_GROUPS.flatMap((x) => x.modules));
  // anything enabled that no section names (a future module) still shows, under System
  const strays = ws.modules.filter((m) => on(m) && m !== 'dashboard' && !grouped.has(m)).sort(byOrder);
  const item = (m: ModuleKey) => <NavItem key={m} to={pagePath(ws.id, m)} label={tt(MODULES[m].label)} iconName={MODULES[m].icon} end={m === 'dashboard'} onNavigate={onNavigate} shortcut={MODULES[m].shortcut} />;
  return (
    <nav className="relative flex h-full flex-col gap-2 overflow-y-auto bg-[radial-gradient(120%_50%_at_0%_0%,rgb(var(--side-1)),rgb(var(--side-2))_70%)] px-3 py-4 text-side-fg [&::-webkit-scrollbar-thumb]:border-transparent [&::-webkit-scrollbar-thumb]:bg-white/15" aria-label="Main">
      <div className="px-2 pb-2 pt-1"><Logo onDark /></div>
      {on('dashboard') && <ul className="mt-1">{item('dashboard')}</ul>}
      {NAV_GROUPS.map((grp) => {
        const mods = [...grp.modules.filter(on), ...(grp.key === 'system' ? strays : [])];   // the section's own order, as listed
        if (!mods.length) return null;
        const open = g.isOpen(grp.key);
        return (
          <div key={grp.key} className="mt-2">
            <button type="button" onClick={() => g.toggle(grp.key)} aria-expanded={open} aria-controls={`nav-${grp.key}`}
              className="flex w-full items-center justify-between rounded-md px-2.5 py-1 text-[11.5px] font-semibold text-side-muted transition-colors hover:text-white">
              <span>{grp.label}</span><ChevronDown className={cn('h-3.5 w-3.5 transition-transform duration-150', !open && '-rotate-90')} />
            </button>
            {open && <ul id={`nav-${grp.key}`} className="mt-0.5 space-y-0.5">{mods.map(item)}</ul>}
          </div>
        );
      })}
      <div className="mt-auto"><WorkspaceSwitcher /></div>
    </nav>
  );
}
function NavItem({ to, label, iconName, end, onNavigate, shortcut }: { to: string; label: string; iconName: string; end?: boolean; onNavigate?: () => void; shortcut?: string }) {
  const Icon = icon(iconName);
  return (
    <li>
      <NavLink to={to} end={end} onClick={onNavigate} title={shortcut ? `${label} (${shortcut})` : label}
        className={({ isActive }) => cn('group relative flex h-10 items-center gap-3 rounded-xl px-3 text-[13.5px] font-medium transition-all duration-150',
          isActive ? 'bg-white/[0.14] text-white shadow-[inset_0_0_0_1px_rgb(255_255_255/0.10),0_6px_16px_-8px_rgb(0_0_0/0.5)]' : 'text-side-fg/80 hover:bg-white/[0.07] hover:text-white')}>
        {({ isActive }) => (<>
          {isActive && <span className="fhq-bar-in absolute -left-3 top-2.5 h-5 w-[3px] rounded-r bg-accent shadow-[0_0_10px_rgb(var(--accent)/0.7)]" />}
          <Icon className={cn('h-[18px] w-[18px] transition-[color,transform] duration-200 group-hover:translate-x-0.5', isActive ? 'text-white' : 'text-side-muted group-hover:text-white')} />
          <span className="truncate">{label}</span>
        </>)}
      </NavLink>
    </li>
  );
}

// ---- Phone and tablet navigation (below lg): a bottom tab bar for the four places used all day, and a "More" sheet for the rest.
type Tab = { to: string; label: string; iconName: string; end?: boolean; module: ModuleKey };

function useTabs(): Tab[] {
  const { ws, tt } = useWs();
  return useMemo(() => {
    const on = (m: ModuleKey) => ws.modules.includes(m) && MODULES[m].page !== null;
    // Home, then the people, the diary and the messages; a workspace without one of them falls back to the closest module it has.
    const out: Tab[] = [];
    for (const s of MOBILE_TABS) { const m = s.find(on); if (m && !out.some((t) => t.module === m)) out.push({ to: pagePath(ws.id, m), label: m === 'dashboard' ? 'Home' : tt(MODULES[m].label), iconName: MODULES[m].icon, end: m === 'dashboard', module: m }); }
    return out;
  }, [ws, tt]);
}

function TabBar({ tabs, moreActive, onMore, hidden }: { tabs: Tab[]; moreActive: boolean; onMore: () => void; hidden: boolean }) {
  // A capsule that floats above the content, as the tab bar does on iPhone. The selected tab is a soft capsule of its own; labels stay (HIG: tab bars).
  const base = 'press flex min-w-0 flex-1 flex-col items-center justify-center gap-0.5 rounded-full text-[11px] leading-4 transition-colors duration-200';
  const tone = (on: boolean) => (on ? 'bg-sage text-blue-bright font-semibold' : 'font-medium text-fg-2');
  return (
    <nav aria-label="Primary" className={cn('pointer-events-none fixed inset-x-0 bottom-0 z-30 px-3 pb-[max(0.625rem,env(safe-area-inset-bottom))] transition-transform duration-300 ease-out lg:hidden print:hidden', hidden && 'translate-y-[150%]')}>
      <div className="pointer-events-auto mx-auto flex h-16 max-w-md items-stretch gap-0.5 rounded-[32px] border border-line/70 bg-surface/90 p-1 shadow-[0_10px_30px_-12px_rgb(38_52_49/0.45)] backdrop-blur-xl">
        {tabs.map((t) => {
          const Icon = icon(t.iconName);
          return (
            <NavLink key={t.module} to={t.to} end={t.end} className={({ isActive }) => cn(base, tone(isActive))}>
              {({ isActive }) => (<><Icon className="h-[22px] w-[22px]" strokeWidth={isActive ? 2.25 : 1.75} /><span className="max-w-full truncate px-0.5">{t.label}</span></>)}
            </NavLink>
          );
        })}
        <button type="button" onClick={onMore} aria-haspopup="dialog" className={cn(base, '!min-h-0', tone(moreActive))}>
          <Ellipsis className="h-[22px] w-[22px]" strokeWidth={moreActive ? 2.25 : 1.75} /><span>More</span>
        </button>
      </div>
    </nav>
  );
}

function MoreSheet({ open, onClose, tabs, onSearch, onSignOut }: { open: boolean; onClose: () => void; tabs: Tab[]; onSearch: () => void; onSignOut: () => void }) {
  const { ws, me, tt } = useWs();
  const nav = useNavigate();
  const [adding, setAdding] = useState(false);
  const inTabs = new Set(tabs.map((t) => t.module));
  const on = (m: ModuleKey) => ws.modules.includes(m) && MODULES[m].page !== null && !inTabs.has(m) && m !== 'dashboard';
  const grouped = new Set<ModuleKey>(NAV_GROUPS.flatMap((x) => x.modules));
  const strays = ws.modules.filter((m) => on(m) && !grouped.has(m)).sort((a, b) => MODULES[a].order - MODULES[b].order);
  const groups = NAV_GROUPS.map((g) => ({ key: g.key, label: g.label, mods: [...g.modules.filter(on), ...(g.key === 'system' ? strays : [])] })).filter((g) => g.mods.length);
  const industryLabel = (k: string) => me.industries.find((i) => i.key === k)?.label || k;
  const row = 'press row-tap flex h-[52px] w-full items-center gap-3.5 px-4 text-left text-[15px] font-medium text-fg';
  return (
    <>
      <Sheet open={open} onClose={onClose} title={ws.name} subtitle={`${me.user.name} · ${me.user.role === 'admin' ? 'Administrator' : 'Staff'}${ws.demo ? ' · Demo data' : ''}`}>
        <button type="button" onClick={() => { onClose(); onSearch(); }} className="press mb-4 flex h-12 w-full items-center gap-2.5 rounded-xl border border-line bg-surface px-3.5 text-left text-[15px] text-muted"><Search className="h-[18px] w-[18px]" />{tt('Search {contact.plural|lower}, pages…')}</button>
        {groups.map((g) => (
          <section key={g.key} className="mb-4">
            <h3 className="label mb-1.5 px-1">{g.label}</h3>
            <ul className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-surface">
              {g.mods.map((m) => {
                const Icon = icon(MODULES[m].icon);
                return (
                  <li key={m}>
                    <NavLink to={pagePath(ws.id, m)} onClick={onClose} className={({ isActive }) => cn(row, isActive && 'bg-sage/50')}>
                      <Icon className="h-5 w-5 shrink-0 text-blue-bright" strokeWidth={1.75} /><span className="flex-1 truncate">{tt(MODULES[m].label)}</span><ChevronRight className="h-4 w-4 shrink-0 text-muted" />
                    </NavLink>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
        {(me.workspaces.length > 1 || me.canCreateWorkspace) && (
          <section className="mb-4">
            <h3 className="label mb-1.5 px-1">Workspace</h3>
            <ul className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-surface">
              {me.workspaces.map((w) => (
                <li key={w.id}>
                  <button type="button" className={cn(row, 'h-[56px]')} onClick={() => { onClose(); try { localStorage.setItem('fhq-ws', w.id); } catch { /* ignore */ } nav(`/w/${w.id}`); }}>
                    <Avatar text={w.initials} src={w.logoUrl} size={32} tone={w.id === ws.id ? 'blue' : 'neutral'} />
                    <span className="min-w-0 flex-1"><span className="block truncate">{w.name}</span><span className="block truncate text-[12.5px] font-normal text-muted">{w.protected ? 'Main workspace' : industryLabel(w.industry)}</span></span>
                    {w.id === ws.id && <Check className="h-4 w-4 shrink-0 text-blue-bright" />}
                  </button>
                </li>
              ))}
              {me.canCreateWorkspace && <li><button type="button" className={cn(row, 'text-blue-bright')} onClick={() => { onClose(); setAdding(true); }}><Plus className="h-5 w-5" />Add workspace</button></li>}
            </ul>
          </section>
        )}
        <ul className="overflow-hidden rounded-2xl border border-line bg-surface"><li><button type="button" className={cn(row, 'text-bad')} onClick={() => { onClose(); onSignOut(); }}><LogOut className="h-5 w-5" strokeWidth={1.75} />Sign out</button></li></ul>
      </Sheet>
      <AddWorkspace open={adding} onClose={() => setAdding(false)} />
    </>
  );
}

export function Shell({ children }: { children: ReactNode }) {
  const { ws, me, tt } = useWs();
  const [palette, setPalette] = useState(false);
  const [more, setMore] = useState(false);
  const [typing, setTyping] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const nav = useNavigate();
  const loc = useLocation();
  const qc = useQueryClient();
  const tabs = useTabs();
  useEffect(() => { setMore(false); setScrolled(false); }, [loc.pathname]);
  // The tab bar steps out of the way while a text field has the keyboard, so it never sits on top of what is being typed.
  useEffect(() => {
    const isText = (el: EventTarget | null) => { const t = el as HTMLElement | null; if (!t?.tagName) return false; if (t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable) return true; return t.tagName === 'INPUT' && !['checkbox', 'radio', 'button', 'submit', 'file', 'range'].includes((t as HTMLInputElement).type); };
    const inn = (e: FocusEvent) => setTyping(isText(e.target));
    const out = () => setTyping(false);
    document.addEventListener('focusin', inn); document.addEventListener('focusout', out);
    return () => { document.removeEventListener('focusin', inn); document.removeEventListener('focusout', out); };
  }, []);
  const inThread = /\/inbox\/[^/]+/.test(loc.pathname);
  const barHidden = typing || inThread;
  useEffect(() => { document.documentElement.style.setProperty('--tabbar-h', barHidden ? '0px' : '80px'); }, [barHidden]);
  const moreActive = !tabs.some((t) => loc.pathname === t.to || (!t.end && loc.pathname.startsWith(`${t.to}/`)));
  // keyboard: ⌘K / Ctrl+K palette, "g" + key to jump to a page
  const shortcuts = useMemo(() => Object.fromEntries(ws.modules.filter((m) => MODULES[m].shortcut && MODULES[m].page !== null).map((m) => [MODULES[m].shortcut!.split(' ')[1], pagePath(ws.id, m)])), [ws]);
  useEffect(() => {
    let g = 0;
    const onKey = (e: KeyboardEvent) => {
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test((e.target as HTMLElement).tagName) || (e.target as HTMLElement).isContentEditable;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPalette((p) => !p); return; }
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'g') { g = Date.now(); return; }
      if (Date.now() - g < 1200 && shortcuts[e.key]) { e.preventDefault(); g = 0; nav(shortcuts[e.key]); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [nav, shortcuts]);
  const signOut = async () => { await api('/auth/logout', { method: 'POST' }).catch(() => null); qc.clear(); nav('/login'); };
  return (
    <div className="flex h-full print:block print:h-auto">
      <aside className="hidden w-[248px] shrink-0 lg:block print:hidden"><Sidebar /></aside>
      <div className="relative flex min-w-0 flex-1 flex-col print:block">
        {/* Soft leaf imprint behind the page, top right. Decorative only. */}
        <div aria-hidden="true" className="pointer-events-none absolute right-0 top-14 z-0 hidden h-[460px] w-[370px] bg-[url('/brand/leaf.svg')] bg-contain bg-right-top bg-no-repeat opacity-70 lg:block print:hidden" />
        {/* Phone and tablet: a slim bar with the clinic mark, search and the account. */}
        <header className={cn('safe-t z-20 shrink-0 border-b bg-bg transition-colors duration-200 lg:hidden print:hidden', scrolled ? 'border-line' : 'border-transparent')}>
          <div className="flex h-[52px] items-center gap-1 px-4">
            <Logo compact />
            <div className="ml-auto flex items-center gap-1">
              <button type="button" onClick={() => setPalette(true)} aria-label="Search" className="press flex h-11 w-11 items-center justify-center rounded-full text-fg hover:bg-surface"><Search className="h-5 w-5" /></button>
              <button type="button" onClick={() => setMore(true)} aria-label="Account and menu" className="press -mr-1 flex h-11 w-11 items-center justify-center rounded-full"><span className="flex h-8 w-8 items-center justify-center rounded-full bg-blue text-[12.5px] font-semibold text-white">{initials(me.user.name)}</span></button>
            </div>
          </div>
        </header>
        <header className="sticky top-0 z-20 hidden h-14 shrink-0 items-center gap-3 border-b border-line bg-bg/80 px-6 backdrop-blur-xl lg:flex print:hidden">
          <button onClick={() => setPalette(true)} aria-label="Search and commands" className="group flex h-9 min-w-0 max-w-md flex-1 items-center gap-2.5 rounded-lg border border-line bg-surface/70 px-3 text-left text-[13px] text-muted transition-colors hover:border-line-2 hover:text-fg-2">
            <Search className="h-4 w-4" />
            <span className="flex-1 truncate">{tt('Search {contact.plural|lower}, conversations, pages…')}</span>
            <span className="hidden items-center gap-1 sm:flex"><Kbd>⌘</Kbd><Kbd>K</Kbd></span>
          </button>
          <div className="ml-auto flex shrink-0 items-center gap-1 sm:gap-2">
            {ws.demo && <Badge tone="blue" className="hidden sm:inline-flex">Demo data</Badge>}
            <div className="hidden items-center gap-2 border-l border-line pl-3 sm:flex">
              <Avatar text={initials(me.user.name)} size={28} />
              <div className="leading-tight"><div className="text-[13px] font-medium">{me.user.name}</div><div className="text-[12px] capitalize text-muted">{me.user.role}</div></div>
            </div>
            <button onClick={signOut} className="rounded-lg p-2 text-fg-2 transition-colors hover:bg-surface hover:text-fg" aria-label="Sign out"><LogOut className="h-[18px] w-[18px]" /></button>
          </div>
        </header>
        <main onScroll={(e) => { const s = e.currentTarget.scrollTop > 6; if (s !== scrolled) setScrolled(s); }} className="relative z-10 min-h-0 flex-1 overflow-y-auto overscroll-y-contain pb-[calc(var(--tabbar-h)+env(safe-area-inset-bottom))] transition-[padding] duration-300 lg:pb-0 print:overflow-visible print:pb-0">{children}</main>
      </div>
      <TabBar tabs={tabs} moreActive={moreActive} onMore={() => setMore(true)} hidden={barHidden} />
      <MoreSheet open={more} onClose={() => setMore(false)} tabs={tabs} onSearch={() => setPalette(true)} onSignOut={signOut} />
      <CommandPalette open={palette} onClose={() => setPalette(false)} />
    </div>
  );
}

// A bar pinned just above the tab bar on a phone, for the one action a long form is for (Save). Hidden from tablets up.
export function StickyBar({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('sticky bottom-[calc(var(--tabbar-h)+env(safe-area-inset-bottom))] z-20 -mx-4 mt-5 flex items-center gap-3 border-t border-line bg-bg px-4 py-3 md:hidden print:hidden', className)}>{children}</div>;
}

// The page frame: a title row, then the content. On a phone the title is smaller, the actions fill the width and the margins are 16px.
export function Page({ title, subtitle, actions, children, wide, className, compactActions }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; children: ReactNode; wide?: boolean; className?: string; compactActions?: boolean }) {
  return (
    <div className={cn('mx-auto w-full animate-fade-up px-4 pb-8 pt-4 md:px-8 md:pb-12 md:pt-6', wide ? 'max-w-[1680px]' : 'max-w-[1400px]', className)}>
      <div className={cn('mb-4 flex justify-between gap-x-4 gap-y-3 md:mb-6', compactActions ? 'items-start md:flex-wrap md:items-end' : 'flex-wrap items-end')}>
        <div className="min-w-0"><h1 className="text-[28px] font-bold leading-[1.1] tracking-[-0.025em] md:text-[26px] md:font-semibold md:tracking-tight">{title}</h1>{subtitle && <p className="mt-1.5 text-[14.5px] text-fg-2 md:mt-1 md:text-sm">{subtitle}</p>}</div>
        {actions && <div className={cn('flex items-center gap-2 md:w-auto', compactActions ? 'shrink-0 pt-0.5 md:pt-0' : 'w-full flex-wrap')}>{actions}</div>}
      </div>
      {children}
    </div>
  );
}
