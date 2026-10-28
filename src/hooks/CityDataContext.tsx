import { createContext, useContext, useEffect, type ReactNode } from 'react';
import { useOsmStore } from '../store/useOsmStore';
import { useCityData, type CityData } from './useCityData';

const Ctx = createContext<CityData | null>(null);

/** Loads city data once at the app root and shares it with every page. */
export function CityDataProvider({ children }: { children: ReactNode }) {
  const data = useCityData();
  const resetOsm = useOsmStore((s) => s.resetForCity);
  // Imported OSM attributes belong to one city; drop them when the city changes.
  useEffect(() => resetOsm(data.city.id), [data.city.id, resetOsm]);
  return <Ctx.Provider value={data}>{children}</Ctx.Provider>;
}

export function useCity(): CityData {
  const v = useContext(Ctx);
  if (!v) throw new Error('useCity must be used inside <CityDataProvider>');
  return v;
}
