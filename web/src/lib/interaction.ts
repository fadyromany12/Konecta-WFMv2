import { useEffect } from 'react';

/**
 * A light that follows the pointer across whichever card it is over.
 *
 * The effect is small on purpose — a soft brightening under the cursor, not a
 * spotlight in a dark room. On a screen made of frosted panels it is the thing
 * that makes them read as physical rather than as rectangles, and it costs one
 * gradient that only exists while a card is hovered.
 *
 * One delegated listener rather than a handler per card. A dense screen carries
 * a dozen cards, and twelve listeners each doing their own bookkeeping is both
 * more code and more work per frame than one that asks the event where it is.
 * Coalesced into a frame, because pointermove fires far faster than the screen
 * refreshes and writing a custom property per event would style the same frame
 * several times over.
 */
export function useCardSpotlight(): void {
  useEffect(() => {
    // A coarse pointer has no hover — there is no cursor to follow, and the
    // effect would only fire on tap. Skip the listener entirely.
    if (typeof window === 'undefined' || !window.matchMedia('(hover: hover)').matches) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    let frame = 0;
    let pending: { card: HTMLElement; x: number; y: number } | null = null;
    let lit: HTMLElement | null = null;

    function apply() {
      frame = 0;
      if (!pending) return;
      const { card, x, y } = pending;
      if (lit && lit !== card) lit.style.removeProperty('--spot');
      card.style.setProperty('--spot-x', `${x}px`);
      card.style.setProperty('--spot-y', `${y}px`);
      card.style.setProperty('--spot', '1');
      lit = card;
    }

    function onMove(event: PointerEvent) {
      const card = (event.target as HTMLElement | null)?.closest<HTMLElement>('.card');
      if (!card) {
        if (lit) {
          lit.style.removeProperty('--spot');
          lit = null;
        }
        pending = null;
        return;
      }
      const box = card.getBoundingClientRect();
      pending = { card, x: event.clientX - box.left, y: event.clientY - box.top };
      frame ||= requestAnimationFrame(apply);
    }

    function onLeave() {
      if (lit) {
        lit.style.removeProperty('--spot');
        lit = null;
      }
    }

    document.addEventListener('pointermove', onMove, { passive: true });
    document.addEventListener('pointerleave', onLeave);
    return () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerleave', onLeave);
      if (frame) cancelAnimationFrame(frame);
      if (lit) lit.style.removeProperty('--spot');
    };
  }, []);
}

/**
 * Briefly mark an element as having just succeeded.
 *
 * Toasts say *what* happened; this says *where*. After pressing Save the eye is
 * on the button, and a confirmation that appears in the corner asks it to leave
 * and come back. A ring that expands from the control itself answers in place.
 *
 * The class is removed on animation end rather than on a timer, so the two can
 * never disagree about how long the animation is.
 */
export function pulseSuccess(element: HTMLElement | null | undefined): void {
  if (!element) return;
  element.classList.remove('did-succeed');
  // Reading offsetWidth forces the removal to take effect before the class goes
  // back on; without it a second press inside the animation does nothing at all.
  void element.offsetWidth;
  element.classList.add('did-succeed');
  element.addEventListener('animationend', () => element.classList.remove('did-succeed'), {
    once: true,
  });
}
