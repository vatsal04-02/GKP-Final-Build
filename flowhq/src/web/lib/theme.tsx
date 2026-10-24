import type { ReactNode } from 'react';
// Light only. The clinic theme has no dark mode; this stays so existing imports keep working.
export function ThemeProvider({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
