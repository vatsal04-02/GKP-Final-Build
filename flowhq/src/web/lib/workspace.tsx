// The workspace context: every screen gets its words (terminology), modules, capabilities and formatting from here.
import { createContext, useContext, useMemo, type ReactNode } from 'react';
import type { AutomationKey, MetricKey, Workspace } from '@core/domain';
import { fmt, term, count as countNoun, type TermPath } from '@core/terminology';
import { automationDescription, automationName, METRICS } from '@core/registry';
import type { Fmt } from './format';

export interface Me { user: { email: string; name: string; role: 'admin' | 'staff' }; workspaces: Array<{ id: string; name: string; initials: string; industry: string; logoUrl: string | null }>; demo: boolean; industries: Array<{ key: string; label: string; description: string }> }
interface Value {
  me: Me;
  ws: Workspace;
  f: Fmt;
  t: (path: TermPath | string) => string;          // term('contact.plural')
  tt: (template: string) => string;                // fmt('New {contact.plural}')
  n: (noun: 'contact' | 'booking' | 'service' | 'staff' | 'conversation' | 'workspace', k: number) => string;
  automation: (key: AutomationKey) => { name: string; description: string };
  metric: (key: MetricKey) => { label: string; hint: string };
  has: (module: string) => boolean;
  isAdmin: boolean;
}
const Ctx = createContext<Value | null>(null);
export function WorkspaceProvider({ me, ws, children }: { me: Me; ws: Workspace; children: ReactNode }) {
  const value = useMemo<Value>(() => {
    const T = ws.terminology;
    return {
      me, ws,
      f: { locale: ws.locale, timezone: ws.timezone, currency: ws.currency },
      t: (p) => term(T, p),
      tt: (s) => fmt(s, T),
      n: (noun, k) => countNoun(T, noun, k),
      automation: (key) => ({ name: automationName(key, T), description: automationDescription(key, T) }),
      metric: (key) => ({ label: fmt(METRICS[key].label, T), hint: fmt(METRICS[key].hint, T) }),
      has: (m) => ws.modules.includes(m as never),
      isAdmin: me.user.role === 'admin',
    };
  }, [me, ws]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
export function useWs() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useWs outside WorkspaceProvider');
  return v;
}
