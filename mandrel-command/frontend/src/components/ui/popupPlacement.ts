/**
 * Popup placement — flip a downward-anchored popup UPWARD when there is no room below.
 *
 * ── WHY THIS EXISTS (browser-measured, not theorised) ─────────────────────────────────
 * An absolutely-positioned popup anchored `top: calc(100% + offset)` always opens
 * DOWNWARD. When its field is the last row of a form inside a scrolling panel, "downward"
 * is inside the region the panel CLIPS — the drawer body is `overflow-y: auto`, which
 * makes it a clipping container, so the popup is sliced off at the body's bottom edge and
 * the rest is unreachable.
 *
 * This is an OVERFLOW-CLIPPING problem, NOT a z-index problem. A child cannot be rescued
 * from an ancestor's `overflow` by any z-index: stacking order only decides what paints in
 * front of what, and a clipped child paints nothing at all outside the clip rect. Raising
 * `z-index` here would be a no-op. The fix is to put the popup somewhere that is INSIDE
 * the clip rect — i.e. above the anchor when below does not fit.
 *
 * ── HOW PLACEMENT IS DECIDED ──────────────────────────────────────────────────────────
 * Space is measured against the ANCHOR's rect and the intersection of every clipping
 * ancestor with the viewport. Deciding from the anchor (never from the popup's current
 * position) is what makes it stable: flipping does not change the inputs, so it cannot
 * oscillate between the two placements.
 *
 * ── SHARED ON PURPOSE ─────────────────────────────────────────────────────────────────
 * `Select.module.css` carries the IDENTICAL `position: absolute; top: calc(100% + 4px)`
 * popup pattern and therefore the same latent defect. This module is deliberately
 * component-agnostic (it knows about an anchor element, a popup element and a CSS custom
 * property name — nothing about comboboxes) so Select can adopt it without the logic being
 * written a second time. Select is NOT changed here: it is used across the whole app and
 * earns its own verification pass.
 *
 * No positioning library, no portal: flipping keeps the popup inside the same clipping
 * container, which is the property we actually need.
 */
import React from 'react';

/** Which side of the anchor the popup occupies. `bottom` is the default/preferred side. */
export type PopupPlacement = 'bottom' | 'top';

/** A vertical span in viewport coordinates. */
export interface VerticalBounds {
  top: number;
  bottom: number;
}

export interface ChoosePlacementInput {
  /** Anchor (the control) rect in viewport coordinates. */
  anchor: VerticalBounds;
  /** Measured popup height in px. */
  popupHeight: number;
  /** Gap between anchor and popup, in px — the same value the stylesheet applies. */
  offset: number;
  /** The region the popup must stay inside (clipping ancestors ∩ viewport). */
  bounds: VerticalBounds;
}

/**
 * Pure placement rule. `bottom` is preferred and only given up when it genuinely does not
 * fit AND `top` has strictly more room — so a popup that fits below never flips, and one
 * that fits nowhere stays on the roomier side rather than flip-flopping.
 */
export function choosePopupPlacement({
  anchor,
  popupHeight,
  offset,
  bounds,
}: ChoosePlacementInput): PopupPlacement {
  const needed = popupHeight + offset;
  const spaceBelow = bounds.bottom - anchor.bottom;
  const spaceAbove = anchor.top - bounds.top;
  if (spaceBelow >= needed) return 'bottom';
  return spaceAbove > spaceBelow ? 'top' : 'bottom';
}

/**
 * The vertical region `el` is actually visible in: every ancestor that clips (computed
 * `overflow-y` other than `visible`) intersected with the viewport.
 *
 * Note the third state (C1): if `el` is detached or there is no layout engine, the caller
 * gets the viewport span, which in jsdom is a zero-height box — that is why the hook below
 * treats a zero-height popup measurement as "could not measure" and leaves the default
 * placement alone rather than inventing a flip.
 */
export function findClipBounds(el: Element | null): VerticalBounds {
  const viewportHeight =
    typeof window === 'undefined' ? 0 : window.innerHeight || 0;
  let top = 0;
  let bottom = viewportHeight;
  let node: Element | null = el?.parentElement ?? null;
  while (node && node !== document.documentElement) {
    const overflowY = getComputedStyle(node).overflowY;
    if (overflowY !== 'visible') {
      const rect = node.getBoundingClientRect();
      top = Math.max(top, rect.top);
      bottom = Math.min(bottom, rect.bottom);
    }
    node = node.parentElement;
  }
  return { top, bottom };
}

/**
 * Read a px-valued CSS custom property off `el`. The offset lives in the stylesheet
 * (`--combobox-popup-offset`, beside `--combobox-popup-max-width`) so the gap the CSS
 * draws and the gap this module reasons about are ONE value, not two that can drift.
 * An absent/unparseable property yields 0 — a missing tunable must not fabricate a number.
 */
export function readPxCustomProperty(el: Element | null, property: string): number {
  if (!el) return 0;
  const raw = getComputedStyle(el).getPropertyValue(property).trim();
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

export interface UsePopupPlacementOptions {
  /** CSS custom property (on the anchor's subtree) holding the anchor↔popup gap. */
  offsetProperty: string;
}

/**
 * Choose `bottom`/`top` for `popupRef` relative to `anchorRef` while `open`.
 *
 * Re-measures: on open, whenever the popup resizes (filtering changes the row count), on
 * ANY scroll (capture phase, so a scrolling ancestor such as the drawer body is caught —
 * scroll events from a nested container do not bubble), and on window resize. Measurement
 * runs in a layout effect, so the flip is applied before paint and never flashes.
 */
export function usePopupPlacement(
  anchorRef: React.RefObject<HTMLElement>,
  popupRef: React.RefObject<HTMLElement>,
  open: boolean,
  { offsetProperty }: UsePopupPlacementOptions,
): PopupPlacement {
  const [placement, setPlacement] = React.useState<PopupPlacement>('bottom');

  const measure = React.useCallback(() => {
    const anchor = anchorRef.current;
    const popup = popupRef.current;
    if (!anchor || !popup) return;
    const popupRect = popup.getBoundingClientRect();
    // COULD-NOT-MEASURE is its own branch: a layout engine that reports no height (jsdom,
    // a display:none ancestor) must not be read as "nothing fits below".
    if (popupRect.height <= 0) return;
    setPlacement(
      choosePopupPlacement({
        anchor: anchor.getBoundingClientRect(),
        popupHeight: popupRect.height,
        offset: readPxCustomProperty(anchor, offsetProperty),
        bounds: findClipBounds(anchor),
      }),
    );
  }, [anchorRef, popupRef, offsetProperty]);

  React.useLayoutEffect(() => {
    if (!open) {
      setPlacement('bottom');
      return;
    }
    measure();

    // `true` = capture phase: scroll does not bubble, so a listener on window only sees
    // scrolling of a nested container (the drawer body) during capture.
    window.addEventListener('scroll', measure, true);
    window.addEventListener('resize', measure);

    const popup = popupRef.current;
    let observer: ResizeObserver | null = null;
    if (popup && typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(measure);
      observer.observe(popup);
    }

    return () => {
      window.removeEventListener('scroll', measure, true);
      window.removeEventListener('resize', measure);
      observer?.disconnect();
    };
  }, [open, measure, popupRef]);

  return placement;
}
