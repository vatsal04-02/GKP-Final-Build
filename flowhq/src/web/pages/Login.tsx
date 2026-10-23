import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowRight, Lock, Mail } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { BRAND } from '@core/brand';
import { Logo } from '../components/layout/Shell';
import { Button, Input } from '../components/ui/primitives';

export function Login() {
  const nav = useNavigate();
  const qc = useQueryClient();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [demo, setDemo] = useState(false);
  useEffect(() => { api<{ demo: boolean }>('/health').then((h) => setDemo(!!h.demo)).catch(() => null); document.title = `Sign in · ${BRAND.short}`; }, []);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setError('');
    try { await api('/auth/login', { method: 'POST', body: { email, password } }); qc.clear(); nav('/'); }
    catch (err) { setError(err instanceof ApiError ? err.message : 'Could not sign in'); }
    finally { setBusy(false); }
  };
  return (
    <div className="relative flex min-h-full items-center justify-center overflow-hidden bg-bg px-4">
      <div className="bg-grid pointer-events-none absolute inset-0 opacity-40 [mask-image:radial-gradient(ellipse_at_center,black_20%,transparent_70%)]" />
      <div className="pointer-events-none absolute left-1/2 top-1/3 h-[420px] w-[620px] -translate-x-1/2 -translate-y-1/2"><div className="fhq-glow h-full w-full rounded-full bg-blue/20 blur-[120px]" /></div>
      <div className="relative w-full max-w-[380px]">
        <div className="fhq-scale-in mb-8 flex flex-col items-center gap-3 text-center">
          <Logo large />
          <p className="text-sm text-fg-2">The automation OS for your business</p>
        </div>
        <form onSubmit={submit} className="card fhq-scale-in space-y-4 p-6 shadow-pop" style={{ '--d': '120ms' } as React.CSSProperties}>
          <div><label htmlFor="email" className="mb-1.5 block text-[13px] font-medium text-fg-2">Email</label><Input id="email" type="email" autoComplete="username" required icon={<Mail className="h-4 w-4" />} value={email} onChange={(e) => setEmail(e.target.value)} /></div>
          <div><label htmlFor="password" className="mb-1.5 block text-[13px] font-medium text-fg-2">Password</label><Input id="password" type="password" autoComplete="current-password" required icon={<Lock className="h-4 w-4" />} value={password} onChange={(e) => setPassword(e.target.value)} /></div>
          {error && <p className="rounded-lg border border-bad/30 bg-bad/10 px-3 py-2 text-[13px] text-bad" role="alert">{error}</p>}
          <Button type="submit" variant="primary" className="w-full" loading={busy}>Sign in <ArrowRight className="h-4 w-4" /></Button>
        </form>
        {demo && <p className="mt-4 text-center text-[12.5px] text-muted">Demo: <span className="text-fg-2">admin@flowhq.demo</span> or <span className="text-fg-2">staff@flowhq.demo</span>, password <span className="text-fg-2">demo1234</span></p>}
      </div>
    </div>
  );
}
