// One row of the four things a doctor does most, always at the top of the dashboard. Each is a plain link to a screen that already exists.
import { Link } from 'react-router-dom';
import { ClipboardCheck, FilePlus2, FileText, UserPlus } from 'lucide-react';
import type { ReactNode } from 'react';
import { useWs } from '../lib/workspace';

export function QuickActions({ base }: { base: string }) {
  const { has } = useWs();
  const items: Array<{ module: string; to: string; label: string; icon: ReactNode }> = [
    { module: 'patients', to: `${base}/patients?new=1`, label: 'Register patient', icon: <UserPlus className="h-4 w-4" /> },
    { module: 'prescriptions', to: `${base}/prescriptions/new`, label: 'New prescription', icon: <FileText className="h-4 w-4" /> },
    { module: 'invoices', to: `${base}/invoices/new`, label: 'New invoice', icon: <FilePlus2 className="h-4 w-4" /> },
    { module: 'visits', to: `${base}/attendance`, label: 'Mark attendance', icon: <ClipboardCheck className="h-4 w-4" /> },
  ].filter((i) => has(i.module as never));
  if (!items.length) return null;
  return (
    <nav aria-label="Quick actions" className="hscroll hscroll-bleed lg:flex-wrap lg:overflow-visible">
      {items.map((i) => (
        <Link key={i.label} to={i.to} className="press inline-flex h-11 items-center gap-2 whitespace-nowrap rounded-full border border-line bg-surface px-4 text-[14px] font-medium text-fg shadow-card max-lg:border-line/60 max-lg:shadow-none transition-all hover:border-line-2 hover:bg-surface-2 lg:h-10 lg:rounded-xl lg:px-3.5 lg:text-[13px]">
          <span className="text-blue-bright">{i.icon}</span>{i.label}
        </Link>
      ))}
    </nav>
  );
}
