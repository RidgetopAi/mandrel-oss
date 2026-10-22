/**
 * TaskCard — the board card's two jobs at once.
 *
 * The card is a native <button> AND a drag handle. Making it draggable required
 * `disableInteractiveElementBlocking` on its <Draggable> (rbd refuses to drag from a
 * `button` otherwise — see the note at that prop in Board.tsx). That flag has a stated
 * cost: rbd will start a drag from a NESTED interactive element too, so a nested control
 * would become undraggable-from and would also swallow the card's own click.
 *
 * This pins both halves of that: the card stays a real button, and there is nothing
 * interactive nested inside it. The second is the one that can silently stop being true —
 * someone adds an inline "assign" button to the card and the flag quietly starts costing
 * something.
 *
 * Harness matches the rest of the suite: raw react-dom + React.act, no @testing-library.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, it, expect, vi, afterEach } from 'vitest';

import { TaskCard } from './TaskCard';
import type { Task } from '../../types/task';

/** rbd's own list, which is what actually decides the block (interactiveTagNames). */
const RBD_INTERACTIVE_TAGS = [
  'input',
  'button',
  'textarea',
  'select',
  'option',
  'optgroup',
  'video',
  'audio',
];

const makeTask = (over: Partial<Task> = {}): Task =>
  ({
    id: 'aaaaaaaa-0000-0000-0000-000000000001',
    project_id: 'proj-1',
    title: 'Drag me',
    type: 'feature',
    status: 'todo',
    priority: 'high',
    assigned_to: 'builder',
    tags: [],
    created_at: '2026-08-09T00:00:00.000Z',
    updated_at: '2026-08-09T00:00:00.000Z',
    ...over,
  }) as unknown as Task;

let container: HTMLDivElement;
let root: Root;

function mount(ui: React.ReactElement) {
  container = document.createElement('div');
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container);
    root.render(ui);
  });
  return container;
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
});

const noop = () => {};

describe('TaskCard — stays a real button', () => {
  it('renders a native <button>, not a div with a role bolted on', () => {
    const el = mount(<TaskCard task={makeTask()} active={false} onSelect={noop} />);
    const card = el.querySelector('button');
    expect(card).not.toBeNull();
    expect(card!.tagName).toBe('BUTTON');
    // type=button so it can never submit a surrounding form.
    expect(card!.getAttribute('type')).toBe('button');
  });

  it('carries the task text as its accessible name', () => {
    const el = mount(
      <TaskCard task={makeTask({ title: 'Restore the board' })} active={false} onSelect={noop} />,
    );
    expect(el.querySelector('button')!.textContent).toContain('Restore the board');
  });

  it('clicking it selects the task', () => {
    const onSelect = vi.fn();
    const el = mount(<TaskCard task={makeTask()} active={false} onSelect={onSelect} />);
    act(() => {
      el.querySelector('button')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onSelect).toHaveBeenCalledWith('aaaaaaaa-0000-0000-0000-000000000001');
  });

  it('renders identically with no drag bindings (it is used outside a Draggable too)', () => {
    const el = mount(<TaskCard task={makeTask()} active={false} onSelect={noop} />);
    expect(el.querySelector('button')).not.toBeNull();
  });
});

describe('TaskCard — nothing interactive is nested inside the card', () => {
  /**
   * The card is the drag handle, and `disableInteractiveElementBlocking` means rbd no
   * longer refuses drags that begin on an interactive descendant. Assert there are none,
   * across the states that add content (assignee vs unassigned, link glyph, in-progress).
   */
  it.each([
    ['assigned + in progress', makeTask({ status: 'in_progress', assigned_to: 'builder' })],
    ['unassigned', makeTask({ assigned_to: null as unknown as string })],
    ['completed with a timestamp', makeTask({ status: 'completed' })],
  ])('%s — no nested interactive element', (_label, task) => {
    const el = mount(<TaskCard task={task} active={false} onSelect={noop} linkCount={3} />);
    const card = el.querySelector('button')!;
    const nested = card.querySelectorAll(RBD_INTERACTIVE_TAGS.join(','));
    expect(Array.from(nested).map((n) => n.tagName.toLowerCase())).toEqual([]);
  });

  it('nothing nested is focusable either (one tab stop per card)', () => {
    const el = mount(<TaskCard task={makeTask()} active={false} onSelect={noop} linkCount={2} />);
    const card = el.querySelector('button')!;
    expect(card.querySelectorAll('[tabindex]').length).toBe(0);
    expect(card.querySelectorAll('a[href]').length).toBe(0);
  });
});
