/**
 * Shared behaviour hooks for the interactive / overlay primitives (P0.3b PASS 2).
 *
 * Zero new deps — these are the small, well-understood a11y building blocks the
 * Modal / Drawer / Select need: a focus trap (with focus restore), scroll lock,
 * and outside-click detection. Keeping them here means every overlay shares ONE
 * correct implementation instead of N drifting copies (fix-the-class).
 */
import React from 'react';

/** Elements considered focusable for the tab cycle / initial focus. */
const FOCUSABLE =
  'a[href],area[href],input:not([disabled]),select:not([disabled]),' +
  'textarea:not([disabled]),button:not([disabled]),iframe,object,embed,' +
  '[contenteditable="true"],[tabindex]:not([tabindex="-1"])';

/** All tabbable nodes inside `container`, in DOM order (hidden nodes excluded). */
export function getFocusable(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => el.offsetParent !== null || el === document.activeElement,
  );
}

/**
 * Trap focus inside `containerRef` while `active`. On activate, remembers the
 * previously focused element and moves focus into the container; Tab / Shift+Tab
 * cycle within; Escape calls `onEscape`; on deactivate, focus is restored to the
 * element that had it before (so a keyboard user lands back on the trigger).
 */
export function useFocusTrap(
  active: boolean,
  containerRef: React.RefObject<HTMLElement>,
  opts: { onEscape?: () => void; initialFocusRef?: React.RefObject<HTMLElement> } = {},
): void {
  const { onEscape, initialFocusRef } = opts;
  // Keep the latest onEscape without re-binding the effect each render.
  const escapeRef = React.useRef(onEscape);
  escapeRef.current = onEscape;

  React.useEffect(() => {
    if (!active) return;
    const container = containerRef.current;
    if (!container) return;

    const previouslyFocused = document.activeElement as HTMLElement | null;

    // Move focus in: explicit initial target → first focusable → the container.
    const focusFirst = () => {
      const target =
        initialFocusRef?.current ?? getFocusable(container)[0] ?? container;
      target.focus();
    };
    focusFirst();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        escapeRef.current?.();
        return;
      }
      if (e.key !== 'Tab') return;
      const focusable = getFocusable(container);
      if (focusable.length === 0) {
        // Nothing focusable — keep focus on the container itself.
        e.preventDefault();
        container.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const activeEl = document.activeElement;
      if (e.shiftKey) {
        if (activeEl === first || activeEl === container || !container.contains(activeEl)) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (activeEl === last || activeEl === container || !container.contains(activeEl)) {
          e.preventDefault();
          first.focus();
        }
      }
    };

    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      // Restore focus to the trigger on close (guard: it may have unmounted).
      if (previouslyFocused && document.contains(previouslyFocused)) {
        previouslyFocused.focus();
      }
    };
  }, [active, containerRef, initialFocusRef]);
}

/** Lock body scroll while `active` (overlay open). Restores the prior value. */
export function useScrollLock(active: boolean): void {
  React.useEffect(() => {
    if (!active) return;
    const { body } = document;
    const prev = body.style.overflow;
    body.style.overflow = 'hidden';
    return () => {
      body.style.overflow = prev;
    };
  }, [active]);
}

/**
 * Call `handler` when a pointerdown/touchstart lands outside `ref` while
 * `active`. Used by Select to close its popup on an outside click.
 */
export function useOnClickOutside(
  ref: React.RefObject<HTMLElement>,
  handler: (e: Event) => void,
  active = true,
): void {
  const handlerRef = React.useRef(handler);
  handlerRef.current = handler;
  React.useEffect(() => {
    if (!active) return;
    const listener = (e: Event) => {
      const el = ref.current;
      if (!el || el.contains(e.target as Node)) return;
      handlerRef.current(e);
    };
    document.addEventListener('mousedown', listener);
    document.addEventListener('touchstart', listener);
    return () => {
      document.removeEventListener('mousedown', listener);
      document.removeEventListener('touchstart', listener);
    };
  }, [ref, active]);
}
