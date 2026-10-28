import { useAppStore } from '../store/useAppStore';
import { fmt } from '../lib/format';

/** Temperature formatting that respects the unit preference in Settings. */
export function useTemp() {
  const unit = useAppStore((s) => s.settings.temperatureUnit);
  const conv = (c: number | null | undefined) => (c == null ? null : unit === 'F' ? c * 1.8 + 32 : c);
  return {
    unit,
    conv,
    fmt: (c: number | null | undefined) => `${fmt(conv(c))} °${unit}`,
  };
}
