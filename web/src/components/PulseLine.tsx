import { useEffect, useRef, useState } from 'react';
import { useLive, useLiveEvent } from '../live';

/**
 * The pulse line.
 *
 * The product is called Pulse and the motion language should mean something, so
 * this is a status indicator rather than an ornament: the trace beats when a
 * live event actually arrives, and settles to a slow idle rhythm when nothing
 * is happening. If the event stream is down it flattens and dims — the same
 * information the dot under the bell carries, in a form you notice from across
 * a room.
 *
 * Drawn as one SVG path that scrolls right to left. Only `transform` is
 * animated, so it composites on the GPU and costs nothing measurable next to
 * the tables it sits above.
 */

/** A single heartbeat: baseline, small P wave, the spike, recovery. */
const BEAT = 'l3 0 l1.5 -3 l1.5 6 l1.5 -9 l1.5 12 l1.5 -6 l2 0';
/** Quiet stretch between beats. */
const FLAT = 'l10 0';

function trace(beats: number): string {
  let d = 'M0 16';
  for (let i = 0; i < beats; i++) d += ` ${FLAT} ${BEAT} ${FLAT}`;
  return d;
}

export function PulseLine() {
  const { connected } = useLive();
  const [excited, setExcited] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // A real event makes it beat harder for a moment, which is what turns this
  // from decoration into a signal that something just happened.
  useLiveEvent('*', () => {
    setExcited(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setExcited(false), 2400);
  });

  useEffect(() => () => clearTimeout(timer.current), []);

  return (
    <div
      className={`pulseline ${connected ? 'is-live' : 'is-idle'} ${excited ? 'is-excited' : ''}`}
      aria-hidden="true"
      title={connected ? 'Live — events arriving as they happen' : 'Not streaming — refreshing on a timer'}
    >
      <svg viewBox="0 0 120 32" preserveAspectRatio="none">
        <path d={trace(6)} className="pulseline-trace" />
        <path d={trace(6)} className="pulseline-trace pulseline-trace-2" />
      </svg>
    </div>
  );
}
