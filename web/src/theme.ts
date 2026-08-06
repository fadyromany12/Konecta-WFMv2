/**
 * Theme selection.
 *
 * Three states rather than two: light, dark, and following the operating
 * system. A contact centre floor is often darkened for shift work while the
 * same person reads the same screens from home in daylight, so the choice has
 * to be explicit and it has to stick — but "system" stays the default, because
 * most people have already made this decision once at the OS level.
 */

export type ThemeChoice = 'light' | 'dark' | 'system';

const KEY = 'pulse.theme';

export function storedTheme(): ThemeChoice {
  const value = localStorage.getItem(KEY);
  return value === 'light' || value === 'dark' ? value : 'system';
}

/**
 * Stamp the choice onto the root element. CSS keys off `data-theme`, falling
 * back to the media query when the attribute is absent.
 */
export function applyTheme(choice: ThemeChoice): void {
  const root = document.documentElement;
  if (choice === 'system') {
    root.removeAttribute('data-theme');
    localStorage.removeItem(KEY);
  } else {
    root.setAttribute('data-theme', choice);
    localStorage.setItem(KEY, choice);
  }
  updateMetaThemeColor();
}

/** Whether dark is actually in force right now, whatever the choice was. */
export function isDark(): boolean {
  const attr = document.documentElement.getAttribute('data-theme');
  if (attr === 'dark') return true;
  if (attr === 'light') return false;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

/** Keep the browser chrome in step with the page. */
function updateMetaThemeColor(): void {
  const colour = isDark() ? '#05061c' : '#f4f6fd';
  for (const tag of document.querySelectorAll('meta[name="theme-color"]')) {
    tag.setAttribute('content', colour);
  }
}

/** Applied before React mounts so the first paint is already the right theme. */
export function initTheme(): void {
  applyTheme(storedTheme());
  window
    .matchMedia('(prefers-color-scheme: dark)')
    .addEventListener('change', () => {
      if (storedTheme() === 'system') updateMetaThemeColor();
    });
}
