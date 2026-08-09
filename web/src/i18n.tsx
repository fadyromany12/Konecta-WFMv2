/**
 * Language and direction.
 *
 * The keys are the English strings themselves. That is unusual and deliberate:
 * this is a large existing application with several hundred strings already
 * written, and inventing a key for each one is a day of naming that produces
 * nothing a user can see. Using the source text means an untranslated string
 * renders as English rather than as `admin.directory.title`, so a half-finished
 * dictionary degrades into a bilingual screen instead of a broken one — and the
 * screens can be translated in the order people actually use them.
 *
 * The cost is that changing English copy silently drops its translation. That
 * is a real cost, and the check script catches it: it compares the dictionary's
 * keys against the strings actually passed to `t()` in the source.
 *
 * Digits stay Latin. Egyptian business and payroll documents use 0-9 rather
 * than Arabic-Indic numerals, timecards are read alongside systems that only
 * emit Latin digits, and `font-variant-numeric: tabular-nums` — which is what
 * keeps the hour columns aligned — does not apply to ٠١٢٣. An Arabic-reading
 * supervisor comparing 07:30 here against 07:30 in a payroll export is better
 * served by them matching.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { ar } from './locales/ar';

export const LOCALES = [
  { code: 'en', label: 'English', endonym: 'English', dir: 'ltr' },
  { code: 'ar', label: 'Arabic', endonym: 'العربية', dir: 'rtl' },
] as const;

export type Locale = (typeof LOCALES)[number]['code'];

const DICTIONARIES: Record<Locale, Record<string, string>> = { en: {}, ar };

const STORAGE_KEY = 'pulse.locale';

function initialLocale(): Locale {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored === 'en' || stored === 'ar') return stored;
  // Somebody whose browser is set to Arabic should not have to find a menu to
  // get Arabic. Matched on the language subtag so ar-EG, ar-SA and plain ar
  // all count.
  const preferred = navigator.languages?.find((l) => l.toLowerCase().startsWith('ar'));
  return preferred ? 'ar' : 'en';
}

export function dirFor(locale: Locale): 'ltr' | 'rtl' {
  return LOCALES.find((l) => l.code === locale)?.dir ?? 'ltr';
}

/**
 * Translate, with interpolation.
 *
 * `t('{n} people', { n: 12 })` keeps the number out of the dictionary, which
 * matters because Arabic puts it in a different place in several of these
 * sentences and a concatenated string cannot be reordered by a translator.
 */
export type Translate = (key: string, vars?: Record<string, string | number>) => string;

interface I18n {
  locale: Locale;
  dir: 'ltr' | 'rtl';
  setLocale: (locale: Locale) => void;
  t: Translate;
}

const I18nContext = createContext<I18n | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(initialLocale);

  // Set on the document rather than on a wrapper element, because `dir` has to
  // reach the dialogs, toasts and the command palette — all of which render
  // through portals attached to body and would otherwise stay left-to-right
  // while the page behind them flipped.
  useEffect(() => {
    const root = document.documentElement;
    root.lang = locale;
    root.dir = dirFor(locale);
  }, [locale]);

  const setLocale = useCallback((next: Locale) => {
    localStorage.setItem(STORAGE_KEY, next);
    setLocaleState(next);
  }, []);

  const t = useCallback<Translate>(
    (key, vars) => {
      const template = DICTIONARIES[locale][key] ?? key;
      if (!vars) return template;
      return template.replace(/\{(\w+)\}/g, (whole, name) =>
        Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : whole,
      );
    },
    [locale],
  );

  const value = useMemo(() => ({ locale, dir: dirFor(locale), setLocale, t }), [locale, setLocale, t]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18n {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error('useI18n must be used inside an I18nProvider');
  return ctx;
}

/** The common case: just the translate function. */
export function useT(): Translate {
  return useI18n().t;
}
