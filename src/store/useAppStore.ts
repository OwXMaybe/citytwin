import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { DEFAULT_CITY } from '../data/cities';
import type { Selection } from '../types/data';

export type PageId =
  | 'overview'
  | 'city3d'
  | 'traffic'
  | 'environment'
  | 'energy'
  | 'simulation'
  | 'assistant'
  | 'reports'
  | 'settings';

export type LayerId = 'buildings' | 'traffic' | 'air' | 'energy' | 'zones' | 'green' | 'transit' | 'incidents' | 'vegetation' | 'columns' | 'stations';

/** Metric shown by the Three.js district columns layer. */
export type ColumnMetric = 'population' | 'energy' | 'traffic' | 'pm25';

export type MapMode = '2d' | '3d';

export interface Settings {
  refreshMinutes: number;
  showSimulated: boolean;
  temperatureUnit: 'C' | 'F';
  defaultMapMode: MapMode;
  language: 'tr' | 'en';
}

export interface FlyTarget {
  lon: number;
  lat: number;
  zoom?: number;
  bbox?: [number, number, number, number];
  pitch?: number;
  bearing?: number;
  nonce: number;
}

interface AppState {
  page: PageId;
  cityId: string;
  mapMode: MapMode;
  layers: Record<LayerId, boolean>;
  selection: Selection;
  flyTarget: FlyTarget | null;
  settings: Settings;
  rightPanelOpen: boolean;
  columnMetric: ColumnMetric;
  setColumnMetric: (m: ColumnMetric) => void;
  setPage: (p: PageId) => void;
  setCity: (id: string) => void;
  setMapMode: (m: MapMode) => void;
  toggleLayer: (l: LayerId) => void;
  setLayers: (patch: Partial<Record<LayerId, boolean>>) => void;
  select: (s: Selection) => void;
  flyTo: (t: Omit<FlyTarget, 'nonce'>) => void;
  updateSettings: (patch: Partial<Settings>) => void;
  setRightPanelOpen: (open: boolean) => void;
}

/** Layer presets applied when entering a module page. */
export const PAGE_LAYERS: Partial<Record<PageId, Partial<Record<LayerId, boolean>>>> = {
  city3d: { buildings: true, traffic: false, air: false, energy: false, zones: true, green: true, transit: true, incidents: false, vegetation: true, columns: false, stations: false },
  traffic: { buildings: true, traffic: true, air: false, energy: false, zones: false, green: false, transit: false, incidents: true, vegetation: false, columns: false, stations: false },
  environment: { buildings: true, traffic: false, air: true, energy: false, zones: true, green: true, transit: false, incidents: false, vegetation: true, columns: false, stations: true },
  energy: { buildings: true, traffic: false, air: false, energy: true, zones: true, green: false, transit: false, incidents: false, vegetation: false, columns: true, stations: false },
};

const DEFAULT_LAYERS: Record<LayerId, boolean> = {
  buildings: true, traffic: true, air: false, energy: false, zones: false, green: true, transit: false, incidents: true, vegetation: true, columns: false, stations: true,
};

export const DEFAULT_SETTINGS: Settings = {
  refreshMinutes: 10,
  showSimulated: true,
  temperatureUnit: 'C',
  defaultMapMode: '3d',
  language: 'tr',
};

export const useAppStore = create<AppState>()(
  persist(
    (set) => ({
      page: 'overview',
      cityId: DEFAULT_CITY.id,
      mapMode: '3d',
      layers: DEFAULT_LAYERS,
      selection: null,
      flyTarget: null,
      settings: DEFAULT_SETTINGS,
      rightPanelOpen: true,
      columnMetric: 'population',
      setColumnMetric: (columnMetric) => set({ columnMetric }),
      setPage: (page) =>
        set((s) => ({ page, layers: PAGE_LAYERS[page] ? { ...s.layers, ...PAGE_LAYERS[page] } : s.layers })),
      setCity: (cityId) => set({ cityId, selection: null, flyTarget: null }),
      setMapMode: (mapMode) => set({ mapMode }),
      toggleLayer: (l) => set((s) => ({ layers: { ...s.layers, [l]: !s.layers[l] } })),
      setLayers: (patch) => set((s) => ({ layers: { ...s.layers, ...patch } })),
      select: (selection) => set({ selection }),
      flyTo: (t) => set({ flyTarget: { ...t, nonce: Date.now() } }),
      updateSettings: (patch) => set((s) => ({ settings: { ...s.settings, ...patch } })),
      setRightPanelOpen: (rightPanelOpen) => set({ rightPanelOpen }),
    }),
    {
      name: 'citytwin-ui',
      partialize: (s) => ({ page: s.page, cityId: s.cityId, mapMode: s.mapMode, layers: s.layers, settings: s.settings, columnMetric: s.columnMetric }),
      // Deep-merge so layers/settings added in later versions get their defaults.
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<AppState>;
        return { ...current, ...p, layers: { ...current.layers, ...p.layers }, settings: { ...current.settings, ...p.settings } };
      },
    },
  ),
);
