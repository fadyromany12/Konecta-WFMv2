import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';

/**
 * A navigation strip whose indicator slides between items.
 *
 * The old tabs scaled an underline in under the new tab and out from under the
 * old one. Two things fading in opposite places reads as *two* events; one
 * thing moving reads as the single event it actually is, and the eye follows
 * it instead of re-finding the row.
 *
 * The indicator is measured from the DOM rather than computed, because the
 * items are text of different widths and any arithmetic would be a second
 * source of truth. It is deliberately not rendered until the first
 * measurement, so it never animates in from the left edge on mount.
 */
export function TravellingNav({
  className,
  indicatorClassName,
  ariaLabel,
  children,
}: {
  className: string;
  indicatorClassName: string;
  ariaLabel?: string;
  children: ReactNode;
}) {
  const wrap = useRef<HTMLElement>(null);
  const [box, setBox] = useState<{ left: number; width: number } | null>(null);
  const location = useLocation();

  useLayoutEffect(() => {
    const container = wrap.current;
    if (!container) return;
    const active = container.querySelector<HTMLElement>('.active');
    // No active item — on a route the strip does not cover — so the indicator
    // is hidden rather than parked on whatever happens to be first.
    if (!active) {
      setBox(null);
      return;
    }
    setBox({ left: active.offsetLeft, width: active.offsetWidth });
  }, [location.pathname, children]);

  useEffect(() => {
    const container = wrap.current;
    if (!container || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      const active = container.querySelector<HTMLElement>('.active');
      if (active) setBox({ left: active.offsetLeft, width: active.offsetWidth });
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  return (
    <nav ref={wrap} className={className} aria-label={ariaLabel}>
      {box && (
        <span
          className={indicatorClassName}
          aria-hidden="true"
          style={{ transform: `translateX(${box.left}px)`, width: box.width }}
        />
      )}
      {children}
    </nav>
  );
}
