import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from './lib/theme';
import { ToastProvider } from './components/ui/feedback';
import { App } from './App';
import './styles.css';

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
