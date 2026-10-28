import { useAppStore } from '../store/useAppStore';
import { TR, TR_PATTERNS } from './tr';

/**
 * UI translation. The English text is the key: t('Air quality') looks the string up in the
 * Turkish dictionary and falls back to the English text, so an untranslated string never breaks
 * a screen. Placeholders use {name}: t('{n} districts', { n: 12 }).
 *
 * Shared components (Panel, Stat, KV, SourceBadge, Loading, ErrorState) translate the strings
 * they are given, so call sites only wrap text those components don't render. main.tsx remounts
 * the app when the language changes, so module-level strings are safe as long as they are
 * translated at render time.
 */
export type Lang = 'tr' | 'en';

export const LANGUAGES: { id: Lang; label: string }[] = [
  { id: 'tr', label: 'Türkçe' },
  { id: 'en', label: 'English' },
];

export const lang = (): Lang => useAppStore.getState().settings.language;

/** BCP 47 locale for number and date formatting. */
export const locale = () => (lang() === 'tr' ? 'tr-TR' : 'en-GB');

const missing = new Set<string>();

function fromPattern(text: string): string | undefined {
  for (const [rx, out] of TR_PATTERNS) if (rx.test(text)) return text.replace(rx, out);
  return undefined;
}

export function t(text: string | null | undefined, vars?: Record<string, string | number>): string {
  if (text == null) return '';
  let out = text;
  if (lang() === 'tr') {
    const hit = TR[text] ?? fromPattern(text);
    if (hit != null) out = hit;
    else if (import.meta.env.DEV && text && /[a-z]{3}/i.test(text) && !missing.has(text)) {
      missing.add(text);
      (window as unknown as { __i18nMissing?: Set<string> }).__i18nMissing = missing;
    }
  }
  return vars ? out.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m)) : out;
}

/** Translates only plain strings; JSX and numbers pass through. */
export function tx<T>(v: T): T {
  return (typeof v === 'string' ? t(v) : v) as T;
}

/** Subscribes a component to the language so it re-renders on a switch. */
export const useLang = () => useAppStore((s) => s.settings.language);
