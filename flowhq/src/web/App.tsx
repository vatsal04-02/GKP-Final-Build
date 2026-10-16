// Routes are built from the workspace's enabled modules: a disabled module has no page at all.
import { lazy, Suspense, useEffect, type ReactElement } from 'react';
import { Navigate, Route, Routes, useLocation, useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ModuleKey, Workspace } from '@core/domain';
import { BRAND } from '@core/brand';
import { api, ws as wsPath, type ApiError } from './lib/api';
import { WorkspaceProvider, type Me } from './lib/workspace';
import { Shell } from './components/layout/Shell';
import { ErrorState, Skeleton } from './components/ui/feedback';
import { Login } from './pages/Login';
import { CLINICAL_PAGES, PRINT_PAGES } from './clinical/routes';

const Dashboard = lazy(() => import('./pages/Dashboard'));
const Inbox = lazy(() => import('./pages/Inbox'));
const Contacts = lazy(() => import('./pages/Contacts'));
const Bookings = lazy(() => import('./pages/Bookings'));
const Automations = lazy(() => import('./pages/Automations'));
const Tasks = lazy(() => import('./pages/Tasks'));
const Reports = lazy(() => import('./pages/Reports'));
const ActivityPage = lazy(() => import('./pages/Activity'));
const Ai = lazy(() => import('./pages/Ai'));
const Settings = lazy(() => import('./pages/Settings'));
const NotFound = lazy(() => import('./pages/NotFound'));

const PAGES: Array<{ module: ModuleKey; path: string; el: ReactElement }> = [
  { module: 'dashboard', path: '', el: <Dashboard /> },
  { module: 'inbox', path: 'inbox/:conversationId?', el: <Inbox /> },
  { module: 'contacts', path: 'contacts/:contactId?', el: <Contacts /> },
  { module: 'bookings', path: 'bookings', el: <Bookings /> },
  { module: 'automations', path: 'automations', el: <Automations /> },
  { module: 'tasks', path: 'tasks', el: <Tasks /> },
  { module: 'reports', path: 'reports', el: <Reports /> },
  { module: 'activity', path: 'activity', el: <ActivityPage /> },
  { module: 'ai', path: 'ai', el: <Ai /> },
  { module: 'settings', path: 'settings/:section?', el: <Settings /> },
  ...CLINICAL_PAGES,
];

function useMe() { return useQuery({ queryKey: ['me'], queryFn: () => api<Me>('/me'), retry: false, staleTime: 60000 }); }

function Splash() {
  return <div className="flex h-full items-center justify-center bg-bg"><div className="w-64 space-y-3"><Skeleton className="h-3 w-24" /><Skeleton className="h-3 w-full" /><Skeleton className="h-3 w-2/3" /></div></div>;
}

function WorkspaceRoot() {
  const { wsId = '' } = useParams();
  const bare = /\/print\//.test(useLocation().pathname);   // print views are shown without the dashboard around them
  const me = useMe();
  const wsq = useQuery({ queryKey: ['workspace', wsId], queryFn: () => api<Workspace>(wsPath(wsId, '/workspace')), enabled: !!me.data, staleTime: 60000 });
  useEffect(() => { if (wsq.data) { try { localStorage.setItem('fhq-ws', wsq.data.id); } catch { /* ignore */ } document.title = `${wsq.data.name} · ${BRAND.short}`; } }, [wsq.data]);
  if (me.isLoading || wsq.isLoading) return <Splash />;
  if (me.error) return <Navigate to="/login" replace />;
  if (wsq.error) return (wsq.error as ApiError).status === 404 ? <Navigate to="/" replace /> : <ErrorState error={wsq.error} retry={() => wsq.refetch()} className="h-full" />;
  if (!me.data || !wsq.data) return <Splash />;
  const ws = wsq.data;
  return (
    <WorkspaceProvider me={me.data} ws={ws}>
      {(() => {
        const routes = (
          <Suspense fallback={<div className="p-8"><Skeleton className="h-6 w-48" /></div>}>
            <Routes>
              {PAGES.filter((p) => ws.modules.includes(p.module)).map((p) => <Route key={p.module} path={p.path} element={p.el} />)}
              {PRINT_PAGES.filter((p) => ws.modules.includes(p.module)).map((p) => <Route key={p.path} path={p.path} element={p.el} />)}
              <Route path="*" element={<NotFound />} />
            </Routes>
          </Suspense>
        );
        return bare ? routes : <Shell>{routes}</Shell>;
      })()}
    </WorkspaceProvider>
  );
}

function Home() {
  const me = useMe();
  if (me.isLoading) return <Splash />;
  if (me.error || !me.data) return <Navigate to="/login" replace />;
  let last: string | null = null;
  try { last = localStorage.getItem('fhq-ws'); } catch { /* ignore */ }
  const target = me.data.workspaces.find((w) => w.id === last) || me.data.workspaces[0];
  if (!target) return <div className="flex h-full items-center justify-center text-sm text-fg-2">Your account has no workspace yet. Ask an admin to give you access.</div>;
  return <Navigate to={`/w/${target.id}`} replace />;
}

export function App() {
  const nav = useNavigate();
  const qc = useQueryClient();
  useEffect(() => { const h = () => { qc.clear(); nav('/login'); }; window.addEventListener('fhq:signed-out', h); return () => window.removeEventListener('fhq:signed-out', h); }, [nav, qc]);
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/w/:wsId/*" element={<WorkspaceRoot />} />
      <Route path="*" element={<Home />} />
    </Routes>
  );
}
