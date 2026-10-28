import { Component, lazy, Suspense, type ReactNode } from 'react';
import { Sidebar } from './components/layout/Sidebar';
import { TopBar } from './components/layout/TopBar';
import { RightPanel } from './components/layout/RightPanel';
import { Loading } from './components/ui/Panel';
import { CityDataProvider } from './hooks/CityDataContext';
import { useAppStore } from './store/useAppStore';
import { t } from './i18n';

// Pages are code-split so MapLibre, Three.js and Recharts load only when needed.
const OverviewPage = lazy(() => import('./pages/OverviewPage').then((m) => ({ default: m.OverviewPage })));
const MapPage = lazy(() => import('./pages/MapPage').then((m) => ({ default: m.MapPage })));
const SimulationPage = lazy(() => import('./pages/SimulationPage').then((m) => ({ default: m.SimulationPage })));
const AssistantPage = lazy(() => import('./pages/AssistantPage').then((m) => ({ default: m.AssistantPage })));
const ReportsPage = lazy(() => import('./pages/ReportsPage').then((m) => ({ default: m.ReportsPage })));
const SettingsPage = lazy(() => import('./pages/SettingsPage').then((m) => ({ default: m.SettingsPage })));

function Page() {
  const page = useAppStore((s) => s.page);
  switch (page) {
    case 'city3d':
    case 'traffic':
    case 'environment':
    case 'energy':
      return <MapPage module={page} />;
    case 'simulation':
      return <SimulationPage />;
    case 'assistant':
      return <AssistantPage />;
    case 'reports':
      return <ReportsPage />;
    case 'settings':
      return <SettingsPage />;
    default:
      return <OverviewPage />;
  }
}

const MAP_PAGES = new Set(['city3d', 'traffic', 'environment', 'energy']);
const WITH_RIGHT_PANEL = new Set(['overview', ...MAP_PAGES]);

export default function App() {
  const page = useAppStore((s) => s.page);
  return (
    <CityDataProvider>
      <div className="flex h-full">
        <Sidebar />
        <div className="flex min-w-0 flex-1 flex-col">
          <TopBar />
          <div className="flex min-h-0 flex-1">
            <main className="min-w-0 flex-1">
              {/* Map modules share one boundary key so the map stays mounted between them. */}
              <ErrorBoundary key={MAP_PAGES.has(page) ? 'map' : page}>
                <Suspense fallback={<Loading label="Loading module…" className="h-full" />}>
                  <Page />
                </Suspense>
              </ErrorBoundary>
            </main>
            {WITH_RIGHT_PANEL.has(page) && <RightPanel />}
          </div>
        </div>
      </div>
    </CityDataProvider>
  );
}

class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (this.state.error) {
      return (
        <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
          <div className="text-base font-semibold text-red-400">{t('This module failed to render')}</div>
          <pre className="max-w-xl text-xs whitespace-pre-wrap text-ink-300">{this.state.error.message}</pre>
          <button onClick={() => this.setState({ error: null })} className="rounded border border-ink-600 px-3 py-1 text-ink-200 hover:border-accent">{t('Try again')}</button>
        </div>
      );
    }
    return this.props.children;
  }
}
