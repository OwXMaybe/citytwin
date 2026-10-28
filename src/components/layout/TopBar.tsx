import { useEffect, useRef, useState } from 'react';
import { ChevronDown, Loader2, MapPin, PanelRight, Search, User, Wifi, WifiOff, X } from 'lucide-react';
import { CITIES } from '../../data/cities';
import { useCity } from '../../hooks/CityDataContext';
import type { FeedState } from '../../hooks/useCityData';
import { searchPlaces, type PlaceResult } from '../../services/geocode';
import { useAppStore } from '../../store/useAppStore';
import { t, locale, LANGUAGES } from '../../i18n';

const MAP_PAGES = new Set(['city3d', 'traffic', 'environment', 'energy']);

export function TopBar() {
  const { city } = useCity();
  const setCity = useAppStore((s) => s.setCity);
  const rightOpen = useAppStore((s) => s.rightPanelOpen);
  const setRightOpen = useAppStore((s) => s.setRightPanelOpen);
  return (
    <header className="no-print flex h-12 shrink-0 items-center gap-3 border-b border-ink-700 bg-ink-900 px-3">
      <label className="relative flex items-center">
        <MapPin className="pointer-events-none absolute left-2 size-3.5 text-accent" />
        <select
          value={city.id}
          onChange={(e) => setCity(e.target.value)}
          className="h-8 appearance-none rounded border border-ink-600 bg-ink-800 pr-7 pl-7 text-sm font-medium text-ink-100 outline-none hover:border-ink-500 focus:border-accent"
          aria-label={t('Select city')}
        >
          {[...new Set(CITIES.map((c) => c.country))].map((country) => (
            <optgroup key={country} label={t(country)}>
              {CITIES.filter((c) => c.country === country).map((c) => (
                <option key={c.id} value={c.id}>
                  {t(c.name)}, {t(c.country)}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        <ChevronDown className="pointer-events-none absolute right-2 size-3.5 text-ink-400" />
      </label>
      <PlaceSearch />
      <div className="ml-auto flex items-center gap-3">
        <LanguageToggle />
        <ConnectionStatus />
        <Clock tz={city.timezone} />
        <button
          onClick={() => setRightOpen(!rightOpen)}
          title={t(rightOpen ? 'Hide details panel' : 'Show details panel')}
          className={`hidden size-8 items-center justify-center rounded border md:flex ${rightOpen ? 'border-accent/50 text-accent' : 'border-ink-600 text-ink-300'} hover:border-accent`}
        >
          <PanelRight className="size-4" />
        </button>
        <div className="flex items-center gap-2 border-l border-ink-700 pl-3" title={t('Local demo profile — no sign-in yet')}>
          <div className="flex size-7 items-center justify-center rounded-full bg-ink-700 text-ink-200">
            <User className="size-3.5" />
          </div>
          <div className="hidden leading-tight xl:block">
            <div className="text-xs font-medium">{t('Demo Analyst')}</div>
            <div className="text-[10px] text-ink-400">{t('Local session')}</div>
          </div>
        </div>
      </div>
    </header>
  );
}

function PlaceSearch() {
  const { city } = useCity();
  const flyTo = useAppStore((s) => s.flyTo);
  const select = useAppStore((s) => s.select);
  const page = useAppStore((s) => s.page);
  const setPage = useAppStore((s) => s.setPage);
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [results, setResults] = useState<PlaceResult[]>([]);
  const [state, setState] = useState<'idle' | 'loading' | 'error'>('idle');
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (q.trim().length < 3) {
      setResults([]);
      setState('idle');
      return;
    }
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      setState('loading');
      searchPlaces(q.trim(), { lon: city.lon, lat: city.lat }, ctrl.signal)
        .then((r) => {
          setResults(r);
          setState('idle');
        })
        .catch((e) => {
          if (e.name !== 'AbortError') setState('error');
        });
    }, 350);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [q, city.lon, city.lat]);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  const choose = (r: PlaceResult) => {
    if (!MAP_PAGES.has(page)) setPage('city3d');
    const bbox = r.extent ? ([r.extent[0], r.extent[3], r.extent[2], r.extent[1]] as [number, number, number, number]) : undefined;
    flyTo({ lon: r.lon, lat: r.lat, zoom: 15.5, bbox });
    select({ kind: 'place', lon: r.lon, lat: r.lat, label: [r.label, r.detail].filter(Boolean).join(' — ') });
    setOpen(false);
    setQ(r.label);
  };

  return (
    <div ref={boxRef} className="relative w-full max-w-sm">
      <Search className="pointer-events-none absolute top-2.5 left-2.5 size-3.5 text-ink-400" />
      <input
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && results[0]) choose(results[0]);
          if (e.key === 'Escape') setOpen(false);
        }}
        placeholder={t('Search district, street or landmark…')}
        className="h-8 w-full rounded border border-ink-600 bg-ink-800 pr-8 pl-8 text-sm text-ink-100 outline-none placeholder:text-ink-400 hover:border-ink-500 focus:border-accent"
      />
      {state === 'loading' && <Loader2 className="absolute top-2.5 right-2.5 size-3.5 animate-spin text-accent" />}
      {q && state !== 'loading' && (
        <button onClick={() => setQ('')} className="absolute top-2 right-2 text-ink-400 hover:text-ink-100" aria-label={t('Clear search')}>
          <X className="size-4" />
        </button>
      )}
      {open && q.trim().length >= 3 && (
        <div className="fade-in absolute top-9 right-0 left-0 z-50 overflow-hidden rounded border border-ink-600 bg-ink-800 shadow-xl">
          {state === 'error' && <div className="px-3 py-2 text-amber-400">{t('Search service unavailable. Try again shortly.')}</div>}
          {state !== 'error' && results.length === 0 && state === 'idle' && <div className="px-3 py-2 text-ink-400">{t('No places found.')}</div>}
          {results.map((r) => (
            <button key={r.id} onClick={() => choose(r)} className="block w-full px-3 py-2 text-left hover:bg-ink-700">
              <div className="truncate text-ink-100">{r.label}</div>
              <div className="truncate text-[11px] text-ink-400">{r.detail}</div>
            </button>
          ))}
          <div className="border-t border-ink-700 px-3 py-1 text-[10px] text-ink-400">{t('Geocoding: Photon · © OpenStreetMap contributors')}</div>
        </div>
      )}
    </div>
  );
}

function LanguageToggle() {
  const language = useAppStore((s) => s.settings.language);
  const update = useAppStore((s) => s.updateSettings);
  return (
    <div className="flex h-8 overflow-hidden rounded border border-ink-600 text-[11px] font-semibold" title={t('Interface language')}>
      {LANGUAGES.map((l) => (
        <button
          key={l.id}
          onClick={() => update({ language: l.id })}
          aria-pressed={language === l.id}
          className={`px-2 uppercase ${language === l.id ? 'bg-accent/15 text-accent' : 'text-ink-400 hover:text-ink-100'}`}
        >
          {l.id}
        </button>
      ))}
    </div>
  );
}

const DOT: Record<FeedState, string> = {
  ok: 'bg-emerald-400',
  loading: 'bg-sky-400 pulse',
  error: 'bg-red-500',
  offline: 'bg-ink-500',
};

function ConnectionStatus() {
  const { feeds } = useCity();
  const [open, setOpen] = useState(false);
  const live = feeds.filter((f) => f.state === 'ok').length;
  const errors = feeds.filter((f) => f.state === 'error').length;
  return (
    <div className="relative" onMouseLeave={() => setOpen(false)}>
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex h-8 items-center gap-2 rounded border border-ink-600 px-2 text-xs hover:border-ink-500"
        aria-expanded={open}
      >
        {errors ? <WifiOff className="size-3.5 text-red-400" /> : <Wifi className="size-3.5 text-emerald-400" />}
        <span className="hidden sm:inline">
          {t('{live}/{n} feeds', { live, n: feeds.length })}
        </span>
      </button>
      {open && (
        <div className="fade-in absolute top-9 right-0 z-50 w-72 rounded border border-ink-600 bg-ink-800 p-2 shadow-xl">
          <div className="px-1 pb-1 text-[10px] font-semibold tracking-widest text-ink-400 uppercase">{t('Data connections')}</div>
          {feeds.map((f) => (
            <div key={f.id} className="flex items-start gap-2 rounded px-1 py-1.5">
              <span className={`mt-1.5 size-2 shrink-0 rounded-full ${DOT[f.state]}`} />
              <div className="min-w-0">
                <div className="text-ink-100">{t(f.label)}</div>
                <div className="text-[11px] text-ink-400">{t(f.detail)}</div>
              </div>
              <span className="ml-auto text-[10px] tracking-wider text-ink-400 uppercase">{t(f.state)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Clock({ tz }: { tz: string }) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  return (
    <div className="hidden text-right leading-tight sm:block" title={t('City local time ({tz})', { tz })}>
      <div className="num text-xs text-ink-100">{now.toLocaleTimeString(locale(), { timeZone: tz, hour12: false })}</div>
      <div className="text-[10px] text-ink-400">{now.toLocaleDateString(locale(), { timeZone: tz, weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' })}</div>
    </div>
  );
}
