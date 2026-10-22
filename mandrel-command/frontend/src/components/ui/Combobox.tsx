import React from 'react';
import { cx } from './cx';
import { useFieldContext } from './Field';
import { useOnClickOutside } from './hooks';
import { usePopupPlacement } from './popupPlacement';
import inputStyles from './Input.module.css';
import styles from './Combobox.module.css';

/**
 * Combobox — a REAL TEXT INPUT with a suggestion popup.
 *
 * ── WHAT MAKES THIS NOT A SELECT ──────────────────────────────────────────────────────
 * The control is an `<input>`, and `value`/`onChange` are the input's own. Anything the
 * user types is the value, whether or not it appears in `options` — the list only makes
 * the canonical spelling the path of least resistance. That is the whole design: on the
 * Tasks board `builder` / `the builder` / `builder (P3 Insight)` are one actor in three
 * buckets, but `'the operator + the coordinator'` is a legitimate value that no roster will ever contain,
 * so a Select would be wrong and free text alone leaves the drift. This is the middle.
 *
 * Consequently there is NO "commit" concept for typing and no validation against the
 * option list: `onChange` fires on every keystroke exactly as an `<Input>` does. Picking
 * a suggestion is a convenience that REPLACES the text with that option's spelling.
 *
 * ── MATCHING ──────────────────────────────────────────────────────────────────────────
 * Case-insensitive substring, on the trimmed query. `maxVisible` caps how many
 * suggestions are rendered (a DOM/scan bound — an unscoped admin's option list is
 * unbounded server-side); the cap applies AFTER filtering, so typing narrows toward what
 * you want rather than being hidden behind the cap.
 *
 * ── A11Y ──────────────────────────────────────────────────────────────────────────────
 * WAI-ARIA 1.2 editable combobox: `role="combobox"` on the input with `aria-expanded`,
 * `aria-controls`, `aria-autocomplete="list"` and `aria-activedescendant`; the popup is a
 * `role="listbox"` of `role="option"`. Keyboard: Down/Up move, Home/End jump, Enter picks
 * the active suggestion, Escape closes, Tab closes and moves on. Enter is only swallowed
 * when a suggestion is actually active — otherwise it falls through to the form, so a
 * typed-only value can still be submitted with the keyboard.
 */

export interface ComboboxOption {
  /** The canonical spelling written into the field when this option is picked. */
  value: string;
  /** Optional secondary text (e.g. usage counts). Never part of matching. */
  meta?: string;
}

export interface ComboboxProps {
  /** The field's value — free text, NOT constrained to `options`. */
  value: string;
  /** Fires on every keystroke AND when a suggestion is picked. */
  onChange: (value: string) => void;
  /** Suggestions. May be empty; an empty list simply means the control is a plain input. */
  options: ReadonlyArray<ComboboxOption>;
  /** Max suggestions RENDERED after filtering. */
  maxVisible: number;
  placeholder?: string;
  disabled?: boolean;
  invalid?: boolean;
  /** Forwarded to the input (the column cap — same one the zod schema enforces). */
  maxLength?: number;
  id?: string;
  'aria-label'?: string;
  className?: string;
  /** Text for the "nothing matches" row. Free text is still legal, so this is not an error. */
  emptyLabel?: string;
}

/**
 * The CSS custom property holding the anchor↔popup gap. Declared in Combobox.module.css
 * (`.root`); named here so the placement helper reads the stylesheet's value rather than a
 * duplicated literal (configs-not-hardcoded — one tunable, one home).
 */
const POPUP_OFFSET_PROPERTY = '--combobox-popup-offset';

/** Case-insensitive substring match on the trimmed query. Empty query matches everything. */
export function filterComboboxOptions(
  options: ReadonlyArray<ComboboxOption>,
  query: string,
  maxVisible: number,
): ComboboxOption[] {
  const needle = query.trim().toLowerCase();
  const matched = needle === ''
    ? [...options]
    : options.filter((o) => o.value.toLowerCase().includes(needle));
  return matched.slice(0, Math.max(0, maxVisible));
}

export const Combobox: React.FC<ComboboxProps> = ({
  value,
  onChange,
  options,
  maxVisible,
  placeholder,
  disabled = false,
  invalid,
  maxLength,
  id,
  'aria-label': ariaLabel,
  className,
  emptyLabel = 'No matches — free text is fine',
}) => {
  const field = useFieldContext();
  const isInvalid = invalid ?? field?.invalid ?? false;
  const auto = React.useId();
  const baseId = id ?? field?.id ?? `${auto}-combobox`;
  const listboxId = `${baseId}-listbox`;

  const [open, setOpen] = React.useState(false);
  const [activeIndex, setActiveIndex] = React.useState(-1);
  const rootRef = React.useRef<HTMLDivElement>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const popupRef = React.useRef<HTMLDivElement>(null);

  // The drawer body that hosts this field is `overflow-y: auto`, so a popup opening
  // downward off the last form row is CLIPPED (not merely covered — z-index cannot help).
  // Measure the real room and open upward when below does not fit. See popupPlacement.ts.
  const placement = usePopupPlacement(inputRef, popupRef, open, {
    offsetProperty: POPUP_OFFSET_PROPERTY,
  });

  const visible = React.useMemo(
    () => filterComboboxOptions(options, value, maxVisible),
    [options, value, maxVisible],
  );

  const close = React.useCallback(() => {
    setOpen(false);
    setActiveIndex(-1);
  }, []);

  useOnClickOutside(rootRef, close, open);

  // A suggestion list that shrinks under the cursor must never leave a stale active index
  // pointing past its end (which would commit the wrong option on Enter).
  React.useEffect(() => {
    setActiveIndex((prev) => (prev >= visible.length ? -1 : prev));
  }, [visible.length]);

  const pick = (idx: number) => {
    const opt = visible[idx];
    if (!opt) return;
    onChange(opt.value);
    close();
    inputRef.current?.focus();
  };

  const onInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    // FREE TEXT: the typed value goes straight out, unfiltered and unvalidated.
    onChange(e.target.value);
    setOpen(true);
    setActiveIndex(-1);
  };

  const move = (dir: 1 | -1) => {
    if (visible.length === 0) return;
    setOpen(true);
    setActiveIndex((prev) => {
      const next = prev + dir;
      if (next < 0) return visible.length - 1;
      if (next >= visible.length) return 0;
      return next;
    });
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        if (!open) setOpen(true);
        move(1);
        break;
      case 'ArrowUp':
        e.preventDefault();
        if (!open) setOpen(true);
        move(-1);
        break;
      case 'Home':
        if (open && visible.length > 0) {
          e.preventDefault();
          setActiveIndex(0);
        }
        break;
      case 'End':
        if (open && visible.length > 0) {
          e.preventDefault();
          setActiveIndex(visible.length - 1);
        }
        break;
      case 'Enter':
        // ONLY swallowed when a suggestion is genuinely active. A typed-only value must
        // stay submittable from the keyboard.
        if (open && activeIndex >= 0) {
          e.preventDefault();
          pick(activeIndex);
        }
        break;
      case 'Escape':
        if (open) {
          e.preventDefault();
          close();
        }
        break;
      case 'Tab':
        close();
        break;
      default:
        break;
    }
  };

  const activeId = open && activeIndex >= 0 ? `${baseId}-opt-${activeIndex}` : undefined;

  return (
    <div ref={rootRef} className={cx(styles.root, className)}>
      <input
        ref={inputRef}
        id={baseId}
        type="text"
        role="combobox"
        autoComplete="off"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        aria-autocomplete="list"
        aria-activedescendant={activeId}
        aria-label={ariaLabel}
        aria-invalid={isInvalid || undefined}
        aria-describedby={field?.describedBy}
        className={inputStyles.control}
        value={value}
        disabled={disabled}
        placeholder={placeholder}
        maxLength={maxLength}
        onChange={onInputChange}
        onKeyDown={onKeyDown}
        onFocus={() => setOpen(true)}
      />
      {open && (
        <div
          ref={popupRef}
          className={cx(styles.popup, placement === 'top' && styles.popupAbove)}
        >
          <ul id={listboxId} role="listbox" aria-label={ariaLabel} className={styles.listbox}>
            {visible.length === 0 && (
              <li role="presentation" className={styles.empty}>
                {emptyLabel}
              </li>
            )}
            {visible.map((opt, idx) => (
              <li
                key={opt.value}
                id={`${baseId}-opt-${idx}`}
                role="option"
                aria-selected={opt.value === value}
                className={cx(styles.option, idx === activeIndex && styles.active)}
                onMouseEnter={() => setActiveIndex(idx)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(idx)}
              >
                <span className={styles.optionLabel}>{opt.value}</span>
                {opt.meta && <span className={styles.optionMeta}>{opt.meta}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
};

export default Combobox;
