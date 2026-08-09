import { useCallback, useEffect, useLayoutEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useSession } from '../state';
import {
  TUTORIAL_VERSION,
  WHATS_NEW,
  tourFor,
  tutorialOffer,
  writeProgress,
  type TourStep,
} from '../content/tutorial';

/**
 * The guided tour.
 *
 * Points at the real controls rather than showing pictures of them, so what
 * somebody learns is where things are on their own screen with their own data.
 *
 * The rule that keeps it honest: a step whose target is not on the page is
 * skipped, not shown floating in the middle. Roles see different screens, and a
 * tour that confidently points at nothing teaches people to distrust it.
 */

interface Box {
  top: number;
  left: number;
  width: number;
  height: number;
}

const MARGIN = 12;
const BUBBLE_WIDTH = 340;

export function Tour({ open, startAt = 0, onClose }: { open: boolean; startAt?: number; onClose: () => void }) {
  const { user } = useSession();
  const navigate = useNavigate();
  const location = useLocation();
  const [index, setIndex] = useState(startAt);
  const [box, setBox] = useState<Box | null>(null);
  const [ready, setReady] = useState(false);

  const steps = tourFor(user?.role ?? 'ADVISOR');
  const step: TourStep | undefined = steps[index];

  useEffect(() => {
    if (open) setIndex(startAt);
  }, [open, startAt]);

  // Move to the step's screen first. Measuring before the route settles would
  // find the previous page's elements.
  useEffect(() => {
    if (!open || !step?.route) return;
    if (!location.pathname.startsWith(step.route)) {
      setReady(false);
      navigate(step.route);
    }
  }, [open, step, location.pathname, navigate]);

  const measure = useCallback(() => {
    if (!open || !step) return;
    if (step.route && !location.pathname.startsWith(step.route)) return;

    if (!step.target) {
      setBox(null);
      setReady(true);
      return;
    }
    const el = document.querySelector(step.target);
    if (!el) {
      setBox(null);
      setReady(true);
      return;
    }
    const rect = el.getBoundingClientRect();
    // An element scrolled out of view cannot be pointed at usefully.
    if (rect.height === 0 && rect.width === 0) {
      setBox(null);
      setReady(true);
      return;
    }
    setBox({ top: rect.top, left: rect.left, width: rect.width, height: rect.height });
    setReady(true);
  }, [open, step, location.pathname]);

  useLayoutEffect(() => {
    if (!open) return;
    // A frame for the route to render, then measure. Repeat once shortly after
    // in case data arrived and moved things.
    const first = requestAnimationFrame(measure);
    const second = setTimeout(measure, 260);
    return () => {
      cancelAnimationFrame(first);
      clearTimeout(second);
    };
  }, [open, measure]);

  useEffect(() => {
    if (!open) return;
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
  }, [open, measure]);

  const finish = useCallback(
    (completed: boolean) => {
      writeProgress(completed ? steps.length : index, completed);
      onClose();
    },
    [index, onClose, steps.length],
  );

  const go = useCallback(
    (delta: number) => {
      const next = index + delta;
      if (next < 0) return;
      if (next >= steps.length) {
        finish(true);
        return;
      }
      setReady(false);
      setIndex(next);
      writeProgress(next, false);
    },
    [index, steps.length, finish],
  );

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') finish(false);
      else if (e.key === 'ArrowRight' || e.key === 'Enter') go(1);
      else if (e.key === 'ArrowLeft') go(-1);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, go, finish]);

  if (!open || !step) return null;

  const bubble = placeBubble(box, step.placement);

  return (
    <div className="tour" role="dialog" aria-modal="true" aria-label="Guided tour">
      {/* The scrim is one element with a huge spread shadow punched through by
          the highlight, so there is no second layer to keep in sync. */}
      <div className="tour-scrim" onClick={() => finish(false)} />
      {box && ready && (
        <div
          className="tour-spot"
          style={{
            top: box.top - 6,
            left: box.left - 6,
            width: box.width + 12,
            height: box.height + 12,
          }}
        />
      )}

      <div className="tour-bubble" style={bubble}>
        <div className="tour-count">
          Step {index + 1} of {steps.length}
        </div>
        <h3>{step.title}</h3>
        <p>{step.body}</p>
        <div className="tour-actions">
          <button className="btn btn-ghost" onClick={() => finish(false)}>
            Skip
          </button>
          <div style={{ flex: 1 }} />
          {index > 0 && (
            <button className="btn" onClick={() => go(-1)}>
              Back
            </button>
          )}
          <button className="btn btn-primary" onClick={() => go(1)}>
            {index === steps.length - 1 ? 'Done' : 'Next'}
          </button>
        </div>
        <div className="tour-progress" aria-hidden="true">
          <span style={{ width: `${((index + 1) / steps.length) * 100}%` }} />
        </div>
      </div>
    </div>
  );
}

/** Keep the bubble beside its target and inside the viewport. */
function placeBubble(box: Box | null, placement: TourStep['placement'] = 'bottom'): React.CSSProperties {
  if (!box) {
    return { top: '50%', left: '50%', transform: 'translate(-50%, -50%)' };
  }

  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let top = box.top + box.height + MARGIN;
  let left = box.left;

  if (placement === 'top') top = box.top - MARGIN - 190;
  if (placement === 'left') {
    top = box.top;
    left = box.left - BUBBLE_WIDTH - MARGIN;
  }
  if (placement === 'right') {
    top = box.top;
    left = box.left + box.width + MARGIN;
  }

  // Clamp last, so a preferred placement that would run off the screen still
  // lands somewhere readable rather than half cut off.
  left = Math.max(MARGIN, Math.min(left, vw - BUBBLE_WIDTH - MARGIN));
  top = Math.max(MARGIN, Math.min(top, vh - 210 - MARGIN));

  return { top, left };
}

/**
 * The offer to take the tour.
 *
 * Three different things to say, and saying the wrong one is worse than saying
 * nothing: a first-time offer, a resume for somebody who stopped half way, and
 * — the one that makes the tutorial updatable — a "this changed" for somebody
 * who finished an older version.
 */
export function TourPrompt({ onStart }: { onStart: (at: number) => void }) {
  const { user } = useSession();
  const [offer, setOffer] = useState<ReturnType<typeof tutorialOffer> | null>(null);

  useEffect(() => {
    if (!user) return;
    const timer = setTimeout(() => setOffer(tutorialOffer()), 900);
    return () => clearTimeout(timer);
  }, [user]);

  if (!offer?.show) return null;

  function dismiss() {
    // Treated as done at the current version: somebody who says no should not
    // be asked again until the tutorial actually changes.
    writeProgress(0, true);
    setOffer(null);
  }

  const resuming = offer.resumeAt > 0;

  return (
    <div className="guide-prompt" role="status">
      <div>
        <strong>
          {offer.updated ? 'The tour has been updated' : resuming ? 'Pick up where you left off?' : 'First time here?'}
        </strong>
        <div className="muted">
          {offer.updated
            ? WHATS_NEW
            : resuming
              ? `You stopped at step ${offer.resumeAt + 1}.`
              : `A short tour of the ${user?.roleLabel ?? ''} screens, pointing at the real controls.`}
        </div>
      </div>
      <button
        className="btn btn-primary"
        onClick={() => {
          setOffer(null);
          onStart(offer.updated ? 0 : offer.resumeAt);
        }}
      >
        {offer.updated ? 'Show me what changed' : resuming ? 'Resume' : 'Show me around'}
      </button>
      <button className="btn btn-ghost" onClick={dismiss}>
        Not now
      </button>
    </div>
  );
}

/** Exposed so the guide drawer and the palette can both restart the tour. */
export function restartTour(): void {
  writeProgress(0, false);
}

export { TUTORIAL_VERSION };
