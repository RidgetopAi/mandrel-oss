/*
 * HighlightRegion: scroll-target SELECTION (pure) + the scroll-on-open EFFECT.
 * The effect test renders with react-dom + act into jsdom, stubbing rAF (run sync)
 * and Element.prototype.scrollIntoView (absent in jsdom), so we assert the REAL
 * effect behavior — not just its source. Degradation cases (no term / no match)
 * prove it never scrolls or throws.
 */
// This suite uses raw react-dom + React.act (NO @testing-library); it renders
// real act()-wrapped createRoot renders into jsdom.
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import HighlightRegion, { findFirstHighlight, useHighlightTerm } from './HighlightRegion';
import { highlightConfig } from '../../config/highlight';

// React 18 requires this flag for act() outside @testing-library.
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe('findFirstHighlight — scroll target selection', () => {
  it('returns the FIRST <mark> in the container', () => {
    const div = document.createElement('div');
    div.innerHTML = 'a <mark id="one">x</mark> b <mark id="two">y</mark>';
    expect(findFirstHighlight(div)?.id).toBe('one');
  });

  it('returns null when there is no <mark> (no match → no scroll)', () => {
    const div = document.createElement('div');
    div.innerHTML = 'no marks here';
    expect(findFirstHighlight(div)).toBeNull();
  });

  it('returns null for a null container (nothing rendered)', () => {
    expect(findFirstHighlight(null)).toBeNull();
  });
});

describe('HighlightRegion — scroll-to-first-match effect', () => {
  let container: HTMLDivElement;
  let scrollSpy: jest.Mock;
  let rafSpy: jest.SpyInstance;
  let root: ReturnType<typeof createRoot> | null;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = null;
    scrollSpy = jest.fn();
    // jsdom does not implement scrollIntoView.
    (window.HTMLElement.prototype as any).scrollIntoView = scrollSpy;
    // Run the queued rAF callback synchronously so the effect completes in act().
    rafSpy = jest
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation((cb: FrameRequestCallback) => {
        cb(0);
        return 1;
      });
  });

  afterEach(() => {
    if (root) act(() => root!.unmount());
    document.body.removeChild(container);
    rafSpy.mockRestore();
    jest.clearAllMocks();
  });

  const mount = (node: React.ReactElement) => {
    root = createRoot(container);
    act(() => {
      root!.render(node);
    });
    return root;
  };

  it('scrolls the first <mark> into view with the configured behavior/block', () => {
    mount(
      <HighlightRegion term="x">
        <p>
          before <mark id="first">x</mark> after <mark>x</mark>
        </p>
      </HighlightRegion>,
    );
    expect(scrollSpy).toHaveBeenCalledTimes(1);
    expect(scrollSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        behavior: highlightConfig.scrollBehavior,
        block: highlightConfig.scrollBlock,
      }),
    );
  });

  it('does NOT scroll when there is no term (clean no-op)', () => {
    mount(
      <HighlightRegion term={undefined}>
        <p>
          <mark>x</mark>
        </p>
      </HighlightRegion>,
    );
    expect(scrollSpy).not.toHaveBeenCalled();
  });

  it('does NOT scroll for a blank/whitespace term', () => {
    mount(
      <HighlightRegion term="   ">
        <p>
          <mark>x</mark>
        </p>
      </HighlightRegion>,
    );
    expect(scrollSpy).not.toHaveBeenCalled();
  });

  it('does NOT scroll (and does not throw) when the term matches nothing', () => {
    expect(() =>
      mount(
        <HighlightRegion term="x">
          <p>no marks rendered here</p>
        </HighlightRegion>,
      ),
    ).not.toThrow();
    expect(scrollSpy).not.toHaveBeenCalled();
  });

  it('sets data-highlight-query on the region root only when active', () => {
    mount(
      <HighlightRegion term="foo">
        <span>body</span>
      </HighlightRegion>,
    );
    const region = container.querySelector('[data-highlight-query="foo"]');
    expect(region).not.toBeNull();
  });
});

describe('useHighlightTerm', () => {
  const Probe: React.FC<{ override?: string }> = ({ override }) => {
    const term = useHighlightTerm(override);
    return <span data-term={term ?? '<none>'} />;
  };
  const container = () => {
    const c = document.createElement('div');
    document.body.appendChild(c);
    return c;
  };

  it('an explicit override wins over the ambient region term', () => {
    const c = container();
    act(() => {
      createRoot(c).render(
        <HighlightRegion term="ambient">
          <Probe override="explicit" />
        </HighlightRegion>,
      );
    });
    expect(c.querySelector('span')?.getAttribute('data-term')).toBe('explicit');
    document.body.removeChild(c);
  });

  it('falls back to the ambient region term when no override', () => {
    const c = container();
    act(() => {
      createRoot(c).render(
        <HighlightRegion term="ambient">
          <Probe />
        </HighlightRegion>,
      );
    });
    expect(c.querySelector('span')?.getAttribute('data-term')).toBe('ambient');
    document.body.removeChild(c);
  });

  it('normalizes a blank term to undefined (no highlight)', () => {
    const c = container();
    act(() => {
      createRoot(c).render(<Probe override="   " />);
    });
    expect(c.querySelector('span')?.getAttribute('data-term')).toBe('<none>');
    document.body.removeChild(c);
  });
});
