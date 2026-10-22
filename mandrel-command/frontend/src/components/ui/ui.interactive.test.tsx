/**
 * Primitive interaction tests (P0.3). Mounts into jsdom with createRoot + act
 * (setupTests sets IS_REACT_ACT_ENVIRONMENT) and drives real DOM events —
 * behaviour that renderToStaticMarkup can't cover: click handlers, forwardRef,
 * and uncontrolled Tabs selection.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { Button, Tabs, Alert } from './index';

let container: HTMLDivElement;
let root: Root;

function mount(ui: React.ReactElement) {
  container = document.createElement('div');
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container);
    root.render(ui);
  });
}

function click(el: Element | null) {
  act(() => {
    el?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

function keydown(el: Element | null, key: string) {
  act(() => {
    el?.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  });
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
});

describe('Button interaction', () => {
  it('fires onClick when enabled', () => {
    const onClick = vi.fn();
    mount(<Button onClick={onClick}>Go</Button>);
    click(container.querySelector('button'));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('does NOT fire onClick while loading (disabled)', () => {
    const onClick = vi.fn();
    mount(
      <Button loading onClick={onClick}>
        Saving
      </Button>,
    );
    click(container.querySelector('button'));
    expect(onClick).not.toHaveBeenCalled();
  });

  it('forwardRef exposes the underlying <button> node', () => {
    const ref = React.createRef<HTMLButtonElement>();
    mount(<Button ref={ref}>x</Button>);
    expect(ref.current).toBeInstanceOf(HTMLButtonElement);
  });
});

describe('Alert dismiss', () => {
  it('clicking the dismiss control fires onClose', () => {
    const onClose = vi.fn();
    mount(
      <Alert variant="info" onClose={onClose}>
        body
      </Alert>,
    );
    click(container.querySelector('button[aria-label="Dismiss"]'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('Tabs interaction', () => {
  const items = [
    { key: 'a', label: 'A', content: <span>PanelA</span> },
    { key: 'b', label: 'B', content: <span>PanelB</span> },
    { key: 'c', label: 'C', content: <span>PanelC</span>, disabled: true },
  ];

  it('uncontrolled: clicking a tab switches the visible panel', () => {
    mount(<Tabs items={items} />);
    expect(container.textContent).toContain('PanelA');
    const tabB = container.querySelector('#tab-b');
    click(tabB);
    expect(container.textContent).toContain('PanelB');
    expect(container.textContent).not.toContain('PanelA');
    expect(tabB?.getAttribute('aria-selected')).toBe('true');
  });

  it('a disabled tab cannot be selected', () => {
    mount(<Tabs items={items} />);
    click(container.querySelector('#tab-c'));
    expect(container.textContent).toContain('PanelA');
    expect(container.textContent).not.toContain('PanelC');
  });

  it('controlled: onChange fires but active tab follows the prop, not internal state', () => {
    const onChange = vi.fn();
    mount(<Tabs items={items} activeKey="a" onChange={onChange} />);
    click(container.querySelector('#tab-b'));
    expect(onChange).toHaveBeenCalledWith('b');
    // still shows A because the parent controls activeKey and didn't update it
    expect(container.textContent).toContain('PanelA');
  });

  // Roving-tabindex keyboard nav — branchy logic (Arrow/Home/End, modular
  // wrap-around, skip-disabled). Exercise the BRANCHES, not just render.
  describe('keyboard navigation (roving tabindex)', () => {
    const selected = () => container.querySelector('[aria-selected="true"]')?.id;
    const rovingTabIndex = () =>
      Array.from(container.querySelectorAll('[role="tab"]')).map((t) => t.getAttribute('tabindex'));

    it('ArrowRight moves selection + focus to the next enabled tab', () => {
      mount(<Tabs items={items} />);
      keydown(container.querySelector('#tab-a'), 'ArrowRight');
      expect(selected()).toBe('tab-b');
      expect(document.activeElement?.id).toBe('tab-b');
      // aria-selected AND the roving tabindex follow (only selected tab is 0)
      expect(rovingTabIndex()).toEqual(['-1', '0', '-1']);
    });

    it('ArrowLeft moves to the previous enabled tab', () => {
      mount(<Tabs items={items} defaultActiveKey="b" />);
      keydown(container.querySelector('#tab-b'), 'ArrowLeft');
      expect(selected()).toBe('tab-a');
      expect(document.activeElement?.id).toBe('tab-a');
    });

    it('ArrowRight wraps around AND skips a disabled tab (b → a, past disabled c)', () => {
      mount(<Tabs items={items} defaultActiveKey="b" />);
      // enabled = [a, b]; from b, next wraps to a (disabled c is never landed on)
      keydown(container.querySelector('#tab-b'), 'ArrowRight');
      expect(selected()).toBe('tab-a');
      expect(document.activeElement?.id).toBe('tab-a');
    });

    it('ArrowLeft wraps around from the first enabled tab to the last enabled tab', () => {
      mount(<Tabs items={items} />);
      // from a, previous wraps to last ENABLED (b, since c is disabled)
      keydown(container.querySelector('#tab-a'), 'ArrowLeft');
      expect(selected()).toBe('tab-b');
    });

    it('Home selects the first, End selects the last ENABLED tab (skips disabled)', () => {
      mount(<Tabs items={items} defaultActiveKey="b" />);
      keydown(container.querySelector('#tab-b'), 'Home');
      expect(selected()).toBe('tab-a');
      keydown(container.querySelector('#tab-a'), 'End');
      // last enabled is b (c is disabled), NOT the disabled c
      expect(selected()).toBe('tab-b');
      expect(document.activeElement?.id).toBe('tab-b');
    });

    it('a non-navigation key is ignored (no selection change)', () => {
      mount(<Tabs items={items} />);
      keydown(container.querySelector('#tab-a'), 'x');
      expect(selected()).toBe('tab-a');
    });
  });
});
