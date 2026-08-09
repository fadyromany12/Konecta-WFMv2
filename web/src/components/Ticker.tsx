import { useEffect, useRef, useState } from 'react';

/**
 * A number that moves to its new value instead of snapping to it.
 *
 * On a live board the difference matters: "On the phone" going from 7 to 8 is
 * an event, and a figure that simply replaces itself is one a supervisor
 * watching the room will miss. Rolling the value makes the change legible
 * without anything flashing for attention.
 *
 * Deliberately short — around a third of a second. Long enough to be seen,
 * short enough that a screen full of these still settles before you have
 * finished reading the first one.
 */

const DURATION = 380;

/** Ease-out: fast at first, so the number arrives rather than crawls. */
function easeOut(t: number): number {
  return 1 - (1 - t) ** 3;
}

export function Ticker({
  value,
  format = (n) => String(n),
  className,
}: {
  value: number;
  format?: (n: number) => string;
  className?: string;
}) {
  const [shown, setShown] = useState(value);
  const from = useRef(value);
  const frame = useRef<number | undefined>(undefined);

  useEffect(() => {
    // Respect the reader's setting: with reduced motion the value just changes.
    const reduced =
      typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced || from.current === value) {
      from.current = value;
      setShown(value);
      return;
    }

    const start = performance.now();
    const origin = from.current;
    const delta = value - origin;

    function step(now: number) {
      const t = Math.min(1, (now - start) / DURATION);
      setShown(origin + delta * easeOut(t));
      if (t < 1) frame.current = requestAnimationFrame(step);
      else from.current = value;
    }
    frame.current = requestAnimationFrame(step);

    return () => {
      if (frame.current !== undefined) cancelAnimationFrame(frame.current);
      // Landing on the true value when interrupted matters more than the
      // animation: a half-finished count left on screen would be a lie.
      from.current = value;
    };
  }, [value]);

  return <span className={className}>{format(Math.round(shown))}</span>;
}
