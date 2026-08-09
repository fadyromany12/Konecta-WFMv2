/**
 * English or Arabic.
 *
 * Two buttons rather than a dropdown, because there are two options and a
 * select would hide the one you want behind a click. Each is labelled in its
 * own language — somebody who cannot read the interface cannot read the word
 * "Arabic" in it either, which is the whole problem a language switch exists
 * to solve.
 */

import { LOCALES, useI18n } from '../i18n';

export function LocaleSwitch() {
  const { locale, setLocale, t } = useI18n();

  return (
    <div className="locale-switch" role="group" aria-label={t('Language')}>
      {LOCALES.map((option) => (
        <button
          key={option.code}
          type="button"
          lang={option.code}
          aria-pressed={locale === option.code}
          onClick={() => setLocale(option.code)}
          title={option.label}
        >
          {option.endonym}
        </button>
      ))}
    </div>
  );
}
