import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
type Theme = 'dark' | 'light';
const Ctx = createContext<{ theme: Theme; toggle: () => void }>({ theme: 'light', toggle: () => {} });
const read = (): Theme => { try { return localStorage.getItem('fhq-theme') === 'dark' ? 'dark' : 'light'; } catch { return 'light'; } };
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<Theme>(read);
  useEffect(() => { document.documentElement.setAttribute('data-theme', theme); try { localStorage.setItem('fhq-theme', theme); } catch { /* private mode */ } }, [theme]);
  const toggle = useCallback(() => {
    const root = document.documentElement;
    root.classList.add('theme-anim');   // cross-fade the colours for a moment (styles.css; off for reduced motion)
    window.setTimeout(() => root.classList.remove('theme-anim'), 400);
    setTheme((t) => (t === 'dark' ? 'light' : 'dark'));
  }, []);
  return <Ctx.Provider value={{ theme, toggle }}>{children}</Ctx.Provider>;
}
export const useTheme = () => useContext(Ctx);
