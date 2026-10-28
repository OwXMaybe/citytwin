import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from './App';
import { useAppStore } from './store/useAppStore';
import './index.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5 * 60_000,
      retry: 2,
      retryDelay: (n) => Math.min(1000 * 2 ** n, 8000),
      refetchOnWindowFocus: false,
    },
  },
});

/** Remounts the app on a language switch so every string, including ones computed in queries, is rebuilt. */
function Root() {
  const language = useAppStore((s) => s.settings.language);
  const [shown, setShown] = useState(language);
  useEffect(() => {
    document.documentElement.lang = language;
    if (language !== shown) {
      queryClient.invalidateQueries();
      setShown(language);
    }
  }, [language, shown]);
  return <App key={language} />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <Root />
    </QueryClientProvider>
  </StrictMode>,
);
