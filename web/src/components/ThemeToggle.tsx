import { useState } from 'react';
import { applyTheme, storedTheme, type ThemeChoice } from '../theme';

const OPTIONS: { value: ThemeChoice; label: string; title: string }[] = [
  { value: 'light', label: '☀', title: 'Light' },
  { value: 'system', label: '◐', title: 'Match my system' },
  { value: 'dark', label: '☾', title: 'Dark' },
];

/**
 * Three-way theme control. "System" is the default and stays available, so
 * choosing light or dark is an override rather than a one-way door.
 */
export function ThemeToggle() {
  const [choice, setChoice] = useState<ThemeChoice>(() => storedTheme());

  function pick(next: ThemeChoice) {
    setChoice(next);
    applyTheme(next);
  }

  return (
    <div className="theme-toggle" role="group" aria-label="Colour theme">
      {OPTIONS.map((option) => (
        <button
          key={option.value}
          onClick={() => pick(option.value)}
          aria-pressed={choice === option.value}
          title={option.title}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
