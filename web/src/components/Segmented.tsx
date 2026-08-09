import { useEffect, useLayoutEffect, useRef, useState } from 'react';

/**
 * A segmented control whose indicator travels.
 *
 * The point is the travel. A pill that simply appears under the new option
 * makes two states with nothing between them, and the eye has to re-find where
 * it is; a pill that slides carries the relationship — *this* came from
 * *there* — and costs one transform. It is the same reason the tab underline
 * moves rather than blinks.
 *
 * Measured rather than calculated, because the options are text of different
 * widths and any arithmetic would be a second source of truth that drifts the
 * moment a label changes.
 */

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  /** Shown after the label, for counts. */
  badge?: string | number;
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
  size = 'default',
}: {
  options: SegmentedOption<T>[];
  value: T;
  onChange: (next: T) => void;
  ariaLabel: string;
  size?: 'default' | 'small';
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const [indicator, setIndicator] = useState<{ left: number; width: number } | null>(null);

  // Layout effect, not effect: the indicator must be in place before the frame
  // paints, or the first render shows it at zero width and it grows out of the
  // left edge on mount.
  useLayoutEffect(() => {
    const container = wrap.current;
    if (!container) return;
    const active = container.querySelector<HTMLElement>('[data-active="true"]');
    if (!active) return;
    setIndicator({ left: active.offsetLeft, width: active.offsetWidth });
  }, [value, options]);

  // Re-measure when the container resizes — a sub-tab strip that reflows on a
  // narrower screen would otherwise leave the pill behind.
  useEffect(() => {
    const container = wrap.current;
    if (!container || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      const active = container.querySelector<HTMLElement>('[data-active="true"]');
      if (active) setIndicator({ left: active.offsetLeft, width: active.offsetWidth });
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={wrap}
      className={`segmented ${size === 'small' ? 'is-small' : ''}`}
      role="tablist"
      aria-label={ariaLabel}
    >
      {indicator && (
        <span
          className="segmented-pill"
          aria-hidden="true"
          style={{ transform: `translateX(${indicator.left}px)`, width: indicator.width }}
        />
      )}
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="tab"
          aria-selected={option.value === value}
          data-active={option.value === value}
          className="segmented-option"
          onClick={() => onChange(option.value)}
        >
          {option.label}
          {option.badge !== undefined && <span className="segmented-badge">{option.badge}</span>}
        </button>
      ))}
    </div>
  );
}
