import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from './lib/theme';
import { ToastProvider } from './components/ui/feedback';
import { App } from './App';
import './styles.css';

// Fonts load without blocking the first paint (the page shows in the fallback font, then swaps).
const fonts = document.createElement('link'); fonts.rel = 'stylesheet'; fonts.href = 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Playfair+Display:wght@600;700&family=JetBrains+Mono:wght@500&display=swap'; document.head.appendChild(fonts);

const client = new QueryClient({ defaultOptions: { queries: { retry: (n, e) => n < 2 && !(e as { status?: number }).status?.toString().startsWith('4'), refetchOnWindowFocus: true, staleTime: 5000 } } });
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider>
      <QueryClientProvider client={client}>
        <ToastProvider>
          <BrowserRouter><App /></BrowserRouter>
        </ToastProvider>
      </QueryClientProvider>
    </ThemeProvider>
  </StrictMode>,
);
