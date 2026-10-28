import { create } from 'zustand';
import type { BuildingRecord, OsmImport } from '../services/osm/buildings';
import type { LonLat } from '../services/osm/geometry';

export interface ImportLogEntry {
  source: string;
  osmTimestamp: string | null;
  importedAt: string;
  buildings: number;
  trees: number;
  fromCache: boolean;
}

export type ImportState = { state: 'idle' } | { state: 'loading'; message: string } | { state: 'error'; message: string } | { state: 'done'; message: string };

export type BuildingColorMode = 'height' | 'use';

interface OsmState {
  cityId: string | null;
  /** Keyed by OSM id. */
  buildings: Map<number, BuildingRecord>;
  trees: LonLat[];
  log: ImportLogEntry[];
  status: ImportState;
  colorMode: BuildingColorMode;
  /** Bumped on every data change so map effects can depend on a primitive. */
  version: number;
  addImport: (cityId: string, imp: OsmImport, fromCache: boolean) => void;
  clear: () => void;
  setStatus: (s: ImportState) => void;
  setColorMode: (m: BuildingColorMode) => void;
  resetForCity: (cityId: string) => void;
}

/** Session store for imported OSM attribute data (per city; cleared on city change). */
export const useOsmStore = create<OsmState>()((set, get) => ({
  cityId: null,
  buildings: new Map(),
  trees: [],
  log: [],
  status: { state: 'idle' },
  colorMode: 'height',
  version: 0,
  addImport: (cityId, imp, fromCache) => {
    const s = get();
    const buildings = s.cityId === cityId ? new Map(s.buildings) : new Map<number, BuildingRecord>();
    imp.buildings.forEach((b) => buildings.set(b.osmId, b));
    const seen = new Set((s.cityId === cityId ? s.trees : []).map((t) => `${t[0].toFixed(6)},${t[1].toFixed(6)}`));
    const trees = s.cityId === cityId ? [...s.trees] : [];
    for (const t of imp.trees) {
      const k = `${t[0].toFixed(6)},${t[1].toFixed(6)}`;
      if (!seen.has(k)) {
        seen.add(k);
        trees.push(t);
      }
    }
    set({
      cityId,
      buildings,
      trees,
      log: [{ source: imp.source, osmTimestamp: imp.osmTimestamp, importedAt: imp.importedAt, buildings: imp.buildings.length, trees: imp.trees.length, fromCache }, ...(s.cityId === cityId ? s.log : [])].slice(0, 10),
      colorMode: 'use',
      version: s.version + 1,
    });
  },
  clear: () => set((s) => ({ buildings: new Map(), trees: [], log: [], status: { state: 'idle' }, colorMode: 'height', version: s.version + 1 })),
  setStatus: (status) => set({ status }),
  setColorMode: (colorMode) => set({ colorMode }),
  resetForCity: (cityId) => {
    if (get().cityId !== cityId) set((s) => ({ cityId, buildings: new Map(), trees: [], log: [], status: { state: 'idle' }, colorMode: 'height', version: s.version + 1 }));
  },
}));
