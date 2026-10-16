// ⌘K: jump to any page, contact or conversation, switch workspace, change theme. Keyboard first.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, CornerDownLeft, MessageCircle, Moon, Search, User } from 'lucide-react';
import type { Contact, Conversation } from '@core/domain';
import { MODULES } from '@core/registry';
import { api, ws as wsPath } from '../../lib/api';
import { useWs } from '../../lib/workspace';
import { useTheme } from '../../lib/theme';
import { icon } from '../../lib/icons';
import { cn } from '../../lib/cn';
import { Kbd } from '../ui/primitives';
import { Modal } from '../ui/feedback';

interface Item { id: string; group: string; label: string; hint?: string; icon: React.ReactNode; run: () => void }
export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { ws, tt, me } = useWs();
  const { toggle } = useTheme();
  const nav = useNavigate();
  const [q, setQ] = useState('');
  const [i, setI] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const contacts = useQuery({ queryKey: ['contacts', ws.id, ''], queryFn: () => api<Contact[]>(wsPath(ws.id, '/contacts')), enabled: open, staleTime: 30000 });
  const convs = useQuery({ queryKey: ['conversations', ws.id, 'all', ''], queryFn: () => api<Conversation[]>(wsPath(ws.id, '/conversations')), enabled: open, staleTime: 15000 });
  useEffect(() => { if (open) { setQ(''); setI(0); setTimeout(() => input.current?.focus(), 10); } }, [open]);
  const go = (to: string) => () => { onClose(); nav(to); };
  const items = useMemo<Item[]>(() => {
    const needle = q.trim().toLowerCase();
    const match = (s: string) => !needle || s.toLowerCase().includes(needle);
    const pages: Item[] = ws.modules.filter((m) => MODULES[m].page !== null).map((m) => {
      const Icon = icon(MODULES[m].icon);
      const label = tt(MODULES[m].label);
      return { id: `p-${m}`, group: 'Go to', label, hint: MODULES[m].shortcut, icon: <Icon className="h-4 w-4" />, run: go(MODULES[m].page === '/' ? `/w/${ws.id}` : `/w/${ws.id}${MODULES[m].page}`) };
    }).filter((x) => match(x.label));
    const people: Item[] = needle ? (contacts.data || []).filter((c) => match(`${c.name} ${c.phone || ''} ${c.ref || ''}`)).slice(0, 6).map((c) => ({ id: `c-${c.id}`, group: tt('{contact.plural}'), label: c.name, hint: c.phone || undefined, icon: <User className="h-4 w-4" />, run: go(`/w/${ws.id}/contacts/${c.id}`) })) : [];
    const threads: Item[] = needle ? (convs.data || []).filter((c) => match(`${c.contactName} ${c.lastMessagePreview || ''}`)).slice(0, 5).map((c) => ({ id: `t-${c.id}`, group: 'Conversations', label: c.contactName, hint: c.lastMessagePreview || undefined, icon: <MessageCircle className="h-4 w-4" />, run: go(`/w/${ws.id}/inbox/${c.id}`) })) : [];
    const workspaces: Item[] = me.workspaces.filter((w) => w.id !== ws.id && match(`switch ${w.name}`)).map((w) => ({ id: `w-${w.id}`, group: 'Workspaces', label: `Switch to ${w.name}`, icon: <ArrowRight className="h-4 w-4" />, run: go(`/w/${w.id}`) }));
    const actions: Item[] = [{ id: 'theme', group: 'Actions', label: 'Toggle light / dark', icon: <Moon className="h-4 w-4" />, run: () => { toggle(); onClose(); } }].filter((x) => match(x.label));
    return [...pages, ...people, ...threads, ...workspaces, ...actions];
  }, [q, ws, contacts.data, convs.data, me.workspaces]);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => setI(0), [q]);
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setI((x) => Math.min(items.length - 1, x + 1)); }
    if (e.key === 'ArrowUp') { e.preventDefault(); setI((x) => Math.max(0, x - 1)); }
    if (e.key === 'Enter' && items[i]) { e.preventDefault(); items[i].run(); }
  };
  let lastGroup = '';
  return (
    <Modal open={open} onClose={onClose} label="Command palette">
      <div className="flex items-center gap-2.5 border-b border-line px-4">
        <Search className="h-4 w-4 text-muted" />
        <input ref={input} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKey} placeholder={tt('Type a page, {contact.singular|lower} or command…')} className="h-12 flex-1 bg-transparent text-sm outline-none placeholder:text-muted" aria-label="Search" />
        <Kbd>esc</Kbd>
      </div>
      <div className="max-h-[52vh] overflow-y-auto p-2" role="listbox">
        {!items.length && <p className="px-3 py-8 text-center text-sm text-fg-2">Nothing matches “{q}”.</p>}
        {items.map((it, k) => {
          const head = it.group !== lastGroup ? (lastGroup = it.group) : null;
          return (
            <div key={it.id}>
              {head && <div className="label px-2.5 pb-1 pt-2.5">{head}</div>}
              <button role="option" aria-selected={k === i} onMouseEnter={() => setI(k)} onClick={it.run}
                className={cn('flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left text-sm transition-colors', k === i ? 'bg-blue/[0.12] text-fg shadow-[inset_0_0_0_1px_rgb(var(--blue)/0.25)]' : 'text-fg-2')}>
                <span className={k === i ? 'text-blue-bright' : 'text-muted'}>{it.icon}</span>
                <span className="flex-1 truncate">{it.label}</span>
                {it.hint && <span className="max-w-[45%] truncate text-xs text-muted">{it.hint}</span>}
                {k === i && <CornerDownLeft className="h-3.5 w-3.5 text-muted" />}
              </button>
            </div>
          );
        })}
      </div>
      <div className="flex items-center gap-3 border-t border-line px-4 py-2 text-[11px] text-muted"><span><Kbd>↑</Kbd> <Kbd>↓</Kbd> move</span><span><Kbd>↵</Kbd> open</span><span className="ml-auto">Tip: press <Kbd>g</Kbd> then a letter to jump</span></div>
    </Modal>
  );
}
