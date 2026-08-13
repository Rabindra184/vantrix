import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import './styles/tokens.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // TanStack Query retries a failed query three times by default, with
      // backoff. Every rejection this shell acts on is a deliberate verdict
      // the server will repeat — a 401 with no cookie, a 403 with no
      // organisation — so retrying only delays the redirect by seconds
      // while the user looks at a loading state. A route that genuinely
      // wants retries (polling a pending run, Task 7) can ask per-query.
      retry: false,
    },
  },
});

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Root element #root not found');
}

createRoot(rootElement).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
