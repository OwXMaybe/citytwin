import type { Provenance, Zone } from '../types/data';

/**
 * Preliminary what-if engine (Phase 1 preview of the Phase 6 simulation module).
 * Every coefficient is explicit and listed in ASSUMPTIONS so results can be audited.
 * Outputs are illustrative ESTIMATES, not validated predictions.
 */

export const SCENARIO_PROVENANCE: Provenance = {
  source: 'estimated',
  provider: 'CityTwin scenario engine v0',
  note: 'First-order heuristic model over simulated baseline data. Not a validated traffic, climate or energy model.',
};

export interface ScenarioInput {
  closureZoneId: string | null;
  closureSeverity: number; // 0..1 share of road capacity removed
  newRouteZoneId: string | null;
  newRouteCapacity: number; // 0..0.5 extra capacity
  greenIncreasePp: number; // percentage points of land converted to green
  efficiencyPct: number; // % demand reduction
  solarAdoptionPct: number; // % of suitable roofs with PV
}

export const DEFAULT_SCENARIO: ScenarioInput = {
  closureZoneId: null,
  closureSeverity: 0.5,
  newRouteZoneId: null,
  newRouteCapacity: 0.2,
  greenIncreasePp: 0,
  efficiencyPct: 0,
  solarAdoptionPct: 0,
};

export const ASSUMPTIONS = [
  { k: 'Closure diversion', v: 'Zone index rises by 50% of its remaining headroom × severity; adjacent zones absorb 15%.' },
  { k: 'Added capacity', v: 'Congestion scales with volume/capacity: index ÷ (1 + added capacity); neighbours gain 30% of the relief.' },
  { k: 'Green cooling', v: '≈0.1 °C local air-temperature reduction per +1 pp green cover (rule of thumb from urban-heat literature; highly site-dependent).' },
  { k: 'Roof area', v: '15 m² suitable roof per resident (placeholder until building footprints are aggregated).' },
  { k: 'PV yield', v: 'Annual irradiation estimate × 18% module efficiency × 0.8 performance ratio.' },
  { k: 'Grid carbon', v: '0.40 tCO₂ per MWh (placeholder grid intensity).' },
];

const CARBON_T_PER_MWH = 0.4;

export interface ZoneResult {
  id: string;
  name: string;
  trafficBefore: number;
  trafficAfter: number;
  energyBefore: number;
  energyAfter: number;
}

export interface ScenarioResult {
  zones: ZoneResult[];
  cityTrafficBefore: number;
  cityTrafficAfter: number;
  energyBefore: number; // MWh/day
  energyAfter: number;
  solarMWhDay: number;
  co2Before: number; // t/day
  co2After: number;
  coolingC: number;
  greenBefore: number; // %
  greenAfter: number;
}

const dist = (a: Zone, b: Zone) => Math.hypot(a.center[0] - b.center[0], a.center[1] - b.center[1]);

function neighbours(zones: Zone[], z: Zone) {
  const ds = zones.filter((o) => o.id !== z.id).map((o) => ({ o, d: dist(o, z) }));
  const min = Math.min(...ds.map((x) => x.d));
  return ds.filter((x) => x.d < min * 1.2).map((x) => x.o);
}

export function runScenario(zones: Zone[], s: ScenarioInput): ScenarioResult {
  const traffic = new Map(zones.map((z) => [z.id, z.trafficIndex as number]));

  if (s.closureZoneId && s.closureSeverity > 0) {
    const z = zones.find((x) => x.id === s.closureZoneId);
    if (z) {
      const t = traffic.get(z.id)!;
      traffic.set(z.id, t + (100 - t) * 0.5 * s.closureSeverity);
      for (const n of neighbours(zones, z)) {
        const tn = traffic.get(n.id)!;
        traffic.set(n.id, tn + (100 - tn) * 0.15 * s.closureSeverity);
      }
    }
  }
  if (s.newRouteZoneId && s.newRouteCapacity > 0) {
    const z = zones.find((x) => x.id === s.newRouteZoneId);
    if (z) {
      const t = traffic.get(z.id)!;
      const after = t / (1 + s.newRouteCapacity);
      traffic.set(z.id, after);
      for (const n of neighbours(zones, z)) {
        const tn = traffic.get(n.id)!;
        traffic.set(n.id, tn - (tn - tn / (1 + s.newRouteCapacity)) * 0.3);
      }
    }
  }

  const eff = 1 - s.efficiencyPct / 100;
  let solarTotal = 0;
  const zr: ZoneResult[] = zones.map((z) => {
    const roofM2 = z.population * 15;
    const solarMWhDay = (roofM2 * (s.solarAdoptionPct / 100) * z.solarPotentialKWhm2 * 0.18 * 0.8) / 1000 / 365;
    solarTotal += solarMWhDay;
    return {
      id: z.id,
      name: z.name,
      trafficBefore: z.trafficIndex,
      trafficAfter: Math.round(Math.min(100, Math.max(0, traffic.get(z.id)!))),
      energyBefore: z.energyMWh,
      energyAfter: Math.max(0, z.energyMWh * eff - solarMWhDay),
    };
  });

  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const eB = zr.reduce((a, z) => a + z.energyBefore, 0);
  const eA = zr.reduce((a, z) => a + z.energyAfter, 0);
  const greenBefore = mean(zones.map((z) => z.greenShare * 100));
  return {
    zones: zr,
    cityTrafficBefore: mean(zr.map((z) => z.trafficBefore)),
    cityTrafficAfter: mean(zr.map((z) => z.trafficAfter)),
    energyBefore: eB,
    energyAfter: eA,
    solarMWhDay: solarTotal,
    co2Before: eB * CARBON_T_PER_MWH,
    co2After: eA * CARBON_T_PER_MWH,
    coolingC: s.greenIncreasePp * 0.1,
    greenBefore,
    greenAfter: greenBefore + s.greenIncreasePp,
  };
}
