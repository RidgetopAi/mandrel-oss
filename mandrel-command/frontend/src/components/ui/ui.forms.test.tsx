/**
 * Interactive / overlay primitive tests (P0.3b PASS 2). Mounts into jsdom with
 * createRoot + act and drives REAL DOM events — the a11y/keyboard behaviour that
 * is the whole reason these are PASS 2: Field error wiring, control toggles,
 * Select keyboard listbox, Modal/Drawer focus trap + restore + Esc + scroll-lock,
 * and DataTable sort/empty/loading/selection.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  Field,
  Input,
  NumberInput,
  Checkbox,
  Switch,
  Radio,
  RadioGroup,
  Select,
  Modal,
  Drawer,
  DataTable,
  type Column,
} from './index';

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
function rerender(ui: React.ReactElement) {
  act(() => root.render(ui));
}
function click(el: Element | null) {
  act(() => {
    el?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}
function mousedown(el: Element | null) {
  act(() => {
    el?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  });
}
function keydown(el: Element | null, key: string, opts: KeyboardEventInit = {}) {
  act(() => {
    el?.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...opts }));
  });
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  document.body.style.overflow = '';
});

// ── Field wiring ─────────────────────────────────────────────────────────────
describe('Field a11y wiring', () => {
  it('binds label→control, and error sets aria-invalid + aria-describedby + role=alert', () => {
    mount(
      <Field label="Email" error="Required" required>
        <Input />
      </Field>,
    );
    const input = container.querySelector('input')!;
    const label = container.querySelector('label')!;
    const err = container.querySelector('[role="alert"]')!;
    expect(label.getAttribute('for')).toBe(input.id);
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(input.getAttribute('aria-describedby')).toBe(err.id);
    expect(input.required).toBe(true);
    expect(err.textContent).toBe('Required');
  });

  it('hint (no error) is associated but not an alert', () => {
    mount(
      <Field label="Name" hint="Your full name">
        <Input />
      </Field>,
    );
    const input = container.querySelector('input')!;
    const hint = document.getElementById(input.getAttribute('aria-describedby')!)!;
    expect(hint.textContent).toBe('Your full name');
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(input.getAttribute('aria-invalid')).toBeNull();
  });
});

// ── Toggles ──────────────────────────────────────────────────────────────────
describe('Checkbox', () => {
  it('fires onChange when toggled', () => {
    const onChange = vi.fn();
    mount(<Checkbox onChange={onChange}>Accept</Checkbox>);
    click(container.querySelector('input'));
    expect(onChange).toHaveBeenCalledTimes(1);
  });
  it('indeterminate exposes aria-checked="mixed" and sets the DOM property', () => {
    mount(<Checkbox indeterminate>Partial</Checkbox>);
    const input = container.querySelector('input') as HTMLInputElement;
    expect(input.getAttribute('aria-checked')).toBe('mixed');
    expect(input.indeterminate).toBe(true);
  });
});

describe('Switch', () => {
  it('is role=switch and toggles', () => {
    const onChange = vi.fn();
    mount(<Switch onChange={onChange}>Wifi</Switch>);
    const input = container.querySelector('input')!;
    expect(input.getAttribute('role')).toBe('switch');
    click(input);
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});

describe('RadioGroup', () => {
  it('is a radiogroup; selecting a radio reports its value + updates checked', () => {
    const onChange = vi.fn();
    mount(
      <RadioGroup aria-label="size" defaultValue="s" onChange={onChange}>
        <Radio value="s">Small</Radio>
        <Radio value="m">Medium</Radio>
      </RadioGroup>,
    );
    expect(container.querySelector('[role="radiogroup"]')).toBeTruthy();
    const radios = container.querySelectorAll('input[type="radio"]');
    expect((radios[0] as HTMLInputElement).checked).toBe(true);
    click(radios[1]);
    expect(onChange).toHaveBeenCalledWith('m');
    expect((radios[1] as HTMLInputElement).checked).toBe(true);
  });
});

// ── NumberInput ──────────────────────────────────────────────────────────────
describe('NumberInput', () => {
  it('stepper increments and clamps at max', () => {
    const onValueChange = vi.fn();
    mount(<NumberInput defaultValue={5} max={6} onValueChange={onValueChange} />);
    const inc = container.querySelector('button[aria-label="Increment"]')!;
    click(inc);
    expect(onValueChange).toHaveBeenLastCalledWith(6);
    // at max → increment disabled, no further change
    expect((inc as HTMLButtonElement).disabled).toBe(true);
  });
});

// ── Select (accessible listbox) ──────────────────────────────────────────────
describe('Select — accessible listbox + keyboard', () => {
  const options = [
    { value: 'a', label: 'Alpha' },
    { value: 'b', label: 'Bravo' },
    { value: 'c', label: 'Charlie', disabled: true },
    { value: 'd', label: 'Delta' },
  ];

  it('opens on click, exposes aria-expanded + role=listbox, options are role=option', () => {
    mount(<Select options={options} aria-label="pick" />);
    const trigger = container.querySelector('button')!;
    expect(trigger.getAttribute('aria-haspopup')).toBe('listbox');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelector('[role="listbox"]')).toBeTruthy();
    expect(container.querySelectorAll('[role="option"]').length).toBe(4);
  });

  it('ArrowDown moves the active option (aria-activedescendant), Enter selects + closes', () => {
    const onChange = vi.fn();
    mount(<Select options={options} aria-label="pick" onChange={onChange} />);
    const trigger = container.querySelector('button')!;
    click(trigger);
    const list = container.querySelector('[role="listbox"]')!;
    // opens on the first enabled (a); ArrowDown → b
    keydown(list, 'ArrowDown');
    expect(list.getAttribute('aria-activedescendant')).toMatch(/-opt-1$/);
    keydown(list, 'Enter');
    expect(onChange).toHaveBeenCalledWith('b');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
  });

  it('ArrowDown skips a disabled option (b → d, past disabled c)', () => {
    mount(<Select options={options} aria-label="pick" />);
    click(container.querySelector('button'));
    const list = container.querySelector('[role="listbox"]')!;
    keydown(list, 'ArrowDown'); // a → b
    keydown(list, 'ArrowDown'); // b → d (skip disabled c)
    expect(list.getAttribute('aria-activedescendant')).toMatch(/-opt-3$/);
  });

  it('type-ahead jumps to the option whose label matches', () => {
    mount(<Select options={options} aria-label="pick" />);
    click(container.querySelector('button'));
    const list = container.querySelector('[role="listbox"]')!;
    keydown(list, 'd');
    expect(list.getAttribute('aria-activedescendant')).toMatch(/-opt-3$/);
  });

  it('Escape closes and click-outside closes', () => {
    mount(<Select options={options} aria-label="pick" />);
    const trigger = container.querySelector('button')!;
    click(trigger);
    keydown(container.querySelector('[role="listbox"]'), 'Escape');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    // reopen, then outside click
    click(trigger);
    mousedown(document.body);
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
  });
});

// ── Select — searchable combobox (defect 1) ───────────────────
describe('Select — searchable combobox', () => {
  const projects = [
    { value: 'flowux', label: 'flowux' },
    { value: 'daisy', label: 'daisy' },
    { value: 'mandrel', label: 'mandrel' },
    { value: 'riverbend', label: 'riverbend' },
  ];

  // Set a controlled input's value the way React expects (native setter + input
  // event) so the component's onChange fires.
  function typeInto(el: HTMLInputElement, text: string) {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value',
    )!.set!;
    act(() => {
      setter.call(el, text);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  it('opens to a role=combobox input, autofocused, wired to the listbox', () => {
    mount(<Select options={projects} aria-label="project" searchable />);
    click(container.querySelector('button'));
    const input = container.querySelector('[role="combobox"]') as HTMLInputElement;
    expect(input).toBeTruthy();
    // combobox a11y wiring
    expect(input.getAttribute('aria-expanded')).toBe('true');
    expect(input.getAttribute('aria-controls')).toBe(
      container.querySelector('[role="listbox"]')!.id,
    );
    expect(input.getAttribute('aria-autocomplete')).toBe('list');
    // autofocused on open
    expect(document.activeElement).toBe(input);
  });

  it('typing filters the visible options by case-insensitive substring', () => {
    mount(<Select options={projects} aria-label="project" searchable />);
    click(container.querySelector('button'));
    const input = container.querySelector('[role="combobox"]') as HTMLInputElement;
    expect(container.querySelectorAll('[role="option"]').length).toBe(4);
    typeInto(input, 'R'); // uppercase → still matches mandrel + riverbend
    const labels = Array.from(container.querySelectorAll('[role="option"]')).map(
      (o) => o.textContent,
    );
    expect(labels).toEqual(['mandrel', 'riverbend']);
  });

  it('shows a "No matches" empty state when nothing matches (and no options)', () => {
    mount(<Select options={projects} aria-label="project" searchable />);
    click(container.querySelector('button'));
    const input = container.querySelector('[role="combobox"]') as HTMLInputElement;
    typeInto(input, 'zzz');
    expect(container.querySelectorAll('[role="option"]').length).toBe(0);
    expect(container.querySelector('[role="listbox"]')!.textContent).toContain('No matches');
  });

  it('Arrow/Enter keyboard nav operates over the FILTERED set', () => {
    const onChange = vi.fn();
    mount(<Select options={projects} aria-label="project" searchable onChange={onChange} />);
    click(container.querySelector('button'));
    const input = container.querySelector('[role="combobox"]') as HTMLInputElement;
    typeInto(input, 'r'); // filtered = [mandrel, riverbend], active seats on index 0
    // aria-activedescendant lives on the focused combobox input, points at opt-0
    expect(input.getAttribute('aria-activedescendant')).toMatch(/-opt-0$/);
    keydown(input, 'ArrowDown'); // → index 1 within the filtered set
    expect(input.getAttribute('aria-activedescendant')).toMatch(/-opt-1$/);
    keydown(input, 'Enter'); // selects the 2nd FILTERED option, not the 2nd overall
    expect(onChange).toHaveBeenCalledWith('riverbend');
    expect(container.querySelector('button')!.getAttribute('aria-expanded')).toBe('false');
  });

  it('Escape closes the searchable popup', () => {
    mount(<Select options={projects} aria-label="project" searchable />);
    const trigger = container.querySelector('button')!;
    click(trigger);
    keydown(container.querySelector('[role="combobox"]'), 'Escape');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
  });

  it('REGRESSION: the non-searchable path renders NO search input / combobox', () => {
    mount(<Select options={projects} aria-label="project" />);
    click(container.querySelector('button'));
    expect(container.querySelector('[role="listbox"]')).toBeTruthy();
    expect(container.querySelector('input')).toBeNull();
    expect(container.querySelector('[role="combobox"]')).toBeNull();
    // aria-activedescendant stays on the listbox (focus target) in this path
    expect(container.querySelector('[role="listbox"]')!.getAttribute('aria-activedescendant'))
      .toMatch(/-opt-0$/);
  });
});

// ── Select — dropdown width decoupled from trigger (defect 2) ─────────────────
// jsdom does not apply CSS module stylesheets (vitest css:false), so the width
// fix is asserted against the module source: the popup shell must be content-
// driven + capped, and must NOT be pinned to the trigger width via right:0.
describe('Select.module.css — dropdown width is decoupled from the trigger', () => {
  // vitest root is the frontend package dir; read the module source from there.
  const css = readFileSync(
    resolve(process.cwd(), 'src/components/ui/Select.module.css'),
    'utf8',
  );

  it('no longer pins the popup to the trigger width (right: 0 removed)', () => {
    expect(css).not.toMatch(/right:\s*0\b/);
  });

  it('sizes the popup by content, floored at the trigger width and capped', () => {
    expect(css).toMatch(/width:\s*max-content/);
    expect(css).toMatch(/min-width:\s*100%/);
    expect(css).toMatch(/max-width:\s*var\(--select-popup-max-width\)/);
  });

  it('the width cap is a named custom property, not an inline magic number', () => {
    expect(css).toMatch(/--select-popup-max-width:\s*\d/);
  });
});

// ── Modal (focus trap / restore / esc / scroll-lock) ─────────────────────────
function ModalHarness() {
  const [open, setOpen] = React.useState(false);
  return (
    <div>
      <button id="opener" onClick={() => setOpen(true)}>
        Open
      </button>
      <Modal open={open} onClose={() => setOpen(false)} title="Confirm">
        <button id="inside-1">First</button>
        <button id="inside-2">Second</button>
      </Modal>
    </div>
  );
}

describe('Modal — dialog a11y', () => {
  it('role=dialog aria-modal + labelledby wired to the title', () => {
    mount(<Modal open onClose={() => undefined} title="Delete task" />);
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    const labelledby = dialog.getAttribute('aria-labelledby')!;
    expect(document.getElementById(labelledby)?.textContent).toBe('Delete task');
  });

  it('locks body scroll while open and restores on close', () => {
    mount(<Modal open onClose={() => undefined} title="X" />);
    expect(document.body.style.overflow).toBe('hidden');
    rerender(<Modal open={false} onClose={() => undefined} title="X" />);
    expect(document.body.style.overflow).toBe('');
  });

  it('moves focus into the dialog on open and restores to the trigger on close', () => {
    mount(<ModalHarness />);
    const opener = document.getElementById('opener')!;
    opener.focus();
    click(opener);
    // focus is now inside the dialog
    expect(document.querySelector('[role="dialog"]')!.contains(document.activeElement)).toBe(true);
    // Esc closes → focus restored to the opener
    keydown(document, 'Escape');
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('Tab wraps from last→first and Shift+Tab from first→last (focus trap)', () => {
    mount(<Modal open onClose={() => undefined} title="Trap" />);
    const dialog = document.querySelector('[role="dialog"]')!;
    const focusables = dialog.querySelectorAll('button');
    const first = focusables[0] as HTMLButtonElement; // close button
    const last = focusables[focusables.length - 1] as HTMLButtonElement;
    last.focus();
    keydown(document, 'Tab');
    expect(document.activeElement).toBe(first);
    first.focus();
    keydown(document, 'Tab', { shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it('Escape fires onClose', () => {
    const onClose = vi.fn();
    mount(<Modal open onClose={onClose} title="X" />);
    keydown(document, 'Escape');
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('Drawer — dialog a11y', () => {
  it('role=dialog aria-modal, Esc fires onClose', () => {
    const onClose = vi.fn();
    mount(<Drawer open onClose={onClose} title="Details" />);
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    keydown(document, 'Escape');
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

// ── DataTable ────────────────────────────────────────────────────────────────
interface Row {
  id: string;
  name: string;
  count: number;
}
const rows: Row[] = [
  { id: '1', name: 'Alpha', count: 3 },
  { id: '2', name: 'Bravo', count: 7 },
];
const cols: Column<Row>[] = [
  { key: 'name', header: 'Name', sortable: true },
  { key: 'count', header: 'Count', align: 'right' },
];

describe('DataTable', () => {
  it('renders a semantic table with column headers', () => {
    mount(<DataTable columns={cols} data={rows} rowKey={(r) => r.id} />);
    expect(container.querySelector('table')).toBeTruthy();
    expect(container.querySelectorAll('thead th').length).toBe(2);
    expect(container.querySelectorAll('tbody tr').length).toBe(2);
  });

  it('sortable header cycles aria-sort none→ascending→descending→none + reports it', () => {
    const onSortChange = vi.fn();
    mount(
      <DataTable columns={cols} data={rows} rowKey={(r) => r.id} onSortChange={onSortChange} />,
    );
    const th = container.querySelector('th[aria-sort]')!;
    expect(th.getAttribute('aria-sort')).toBe('none');
    const btn = th.querySelector('button')!;
    click(btn);
    expect(th.getAttribute('aria-sort')).toBe('ascending');
    expect(onSortChange).toHaveBeenLastCalledWith({ key: 'name', direction: 'asc' });
    click(btn);
    expect(th.getAttribute('aria-sort')).toBe('descending');
    click(btn);
    expect(th.getAttribute('aria-sort')).toBe('none');
    expect(onSortChange).toHaveBeenLastCalledWith(null);
  });

  it('empty state renders when there are no rows', () => {
    mount(<DataTable columns={cols} data={[]} rowKey={(r) => r.id} />);
    expect(container.textContent).toContain('No rows');
  });

  it('loading renders skeleton rows (not the data)', () => {
    mount(<DataTable columns={cols} data={rows} rowKey={(r) => r.id} loading skeletonRows={3} />);
    expect(container.querySelectorAll('tbody tr').length).toBe(3);
    expect(container.textContent).not.toContain('Alpha');
  });

  it('selection: header select-all reports every row key', () => {
    const onSelectionChange = vi.fn();
    mount(
      <DataTable
        columns={cols}
        data={rows}
        rowKey={(r) => r.id}
        selectable
        onSelectionChange={onSelectionChange}
      />,
    );
    const headerCheckbox = container.querySelector('thead input[type="checkbox"]')!;
    click(headerCheckbox);
    expect(onSelectionChange).toHaveBeenLastCalledWith(['1', '2']);
  });
});
