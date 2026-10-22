/**
 * ActorChip render tests — the WHO chip on a Sessions stream card must show the ONE
 * neutral "unattributed" label for every non-attributed actor (null AND the
 * `anonymous` sentinel), and the real slug otherwise (an earlier task display part).
 * Mirrors the Dashboard/Sessions test style: createRoot + act into jsdom.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ActorChip } from './parts';
import { UNATTRIBUTED_ACTOR } from '../../config/actor';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function renderChip(actor: string | null | undefined) {
  act(() => {
    root.render(<ActorChip actor={actor} />);
  });
  return container.textContent ?? '';
}

describe('ActorChip', () => {
  it('shows the neutral label for a null actor', () => {
    expect(renderChip(null)).toBe(UNATTRIBUTED_ACTOR);
  });

  it('shows the neutral label for the `anonymous` sentinel (never the literal)', () => {
    const text = renderChip('anonymous');
    expect(text).toBe(UNATTRIBUTED_ACTOR);
    expect(text).not.toContain('anonymous');
  });

  it('shows the real slug for an attributed actor', () => {
    expect(renderChip('coordinator')).toBe('coordinator');
  });
});
