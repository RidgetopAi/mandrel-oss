import React from 'react';
import { cx } from './cx';
import { useFieldContext } from './Field';
import { useOnClickOutside } from './hooks';
import styles from './Select.module.css';

/**
 * Select (P0.3b) — an accessible single-select listbox built from scratch (no
 * heavy dep). A button trigger (aria-haspopup/expanded) opens a role="listbox"
 * popup; focus moves to the listbox which tracks the active option via
 * aria-activedescendant. Full keyboard: Up/Down/Home/End, type-ahead, Enter/Space
 * to select, Esc/Tab to close, click-outside to dismiss. Wires to an enclosing
 * Field. (Multi-select is NOT needed by any current mock — single is the must.)
 *
 * `searchable` (opt-in, default false) turns the popup into a combobox: a text
 * input is rendered at the top of the popup and autofocused on open; typing
 * filters `options` by case-insensitive substring. Arrow/Enter/Home/End keyboard
 * nav operates over the FILTERED set; a "No matches" empty state shows when the
 * filter yields nothing. Non-searchable behaviour is unchanged — every index/nav
 * path routes through `visibleOptions`, which is exactly `options` when the query
 * is empty (i.e. always, in the non-searchable path).
 */
export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface SelectProps {
  options: SelectOption[];
  value?: string;
  defaultValue?: string;
  onChange?: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  invalid?: boolean;
  searchable?: boolean;
  searchPlaceholder?: string;
  id?: string;
  'aria-label'?: string;
  className?: string;
}

const IconChevron = () => (
  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M6 9l6 6 6-6" />
  </svg>
);
const IconCheck = () => (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M5 12l4.5 4.5L19 7" />
  </svg>
);

// First non-disabled index in `arr` scanning from `from` in direction `dir`,
// wrapping modularly. Returns -1 when the array has no enabled option.
const firstEnabledIn = (arr: SelectOption[], from: number, dir: 1 | -1): number => {
  const n = arr.length;
  for (let i = 0; i < n; i += 1) {
    const idx = (((from + dir * i) % n) + n) % n;
    if (!arr[idx].disabled) return idx;
  }
  return -1;
};

export const Select: React.FC<SelectProps> = ({
  options,
  value,
  defaultValue,
  onChange,
  placeholder = 'Select…',
  disabled = false,
  invalid,
  searchable = false,
  searchPlaceholder = 'Search…',
  id,
  'aria-label': ariaLabel,
  className,
}) => {
  const field = useFieldContext();
  const isInvalid = invalid ?? field?.invalid ?? false;
  const auto = React.useId();
  const baseId = id ?? field?.id ?? `${auto}-select`;
  const listboxId = `${baseId}-listbox`;
  const searchId = `${baseId}-search`;

  const isControlled = value !== undefined;
  const [internal, setInternal] = React.useState<string | undefined>(defaultValue);
  const current = isControlled ? value : internal;

  const [open, setOpen] = React.useState(false);
  const [activeIndex, setActiveIndex] = React.useState<number>(-1);
  const [query, setQuery] = React.useState('');

  const rootRef = React.useRef<HTMLDivElement>(null);
  const buttonRef = React.useRef<HTMLButtonElement>(null);
  const listRef = React.useRef<HTMLUListElement>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const searchRef = React.useRef<{ str: string; timer: number | undefined }>({
    str: '',
    timer: undefined,
  });

  // The trigger label always reflects the selected value from the FULL list.
  const selectedOption = options.find((o) => o.value === current);

  // The options the popup actually shows/navigates: filtered when searching,
  // otherwise the full list (so the non-searchable path is byte-identical).
  const filter = (opts: SelectOption[], q: string): SelectOption[] => {
    const needle = q.trim().toLowerCase();
    if (!needle) return opts;
    return opts.filter((o) => o.label.toLowerCase().includes(needle));
  };
  const visibleOptions = React.useMemo(
    () => (searchable ? filter(options, query) : options),
    [searchable, options, query],
  );

  const firstEnabled = (from: number, dir: 1 | -1): number =>
    firstEnabledIn(visibleOptions, from, dir);

  const openList = React.useCallback(() => {
    if (disabled) return;
    setQuery('');
    setOpen(true);
    // Open query is empty → visible list is the full `options`; land on the
    // selected option, else the first enabled one.
    const selIdx = options.findIndex((o) => o.value === current);
    setActiveIndex(selIdx >= 0 ? selIdx : firstEnabledIn(options, 0, 1));
  }, [disabled, options, current]);

  const close = React.useCallback((restoreFocus = true) => {
    setOpen(false);
    setActiveIndex(-1);
    setQuery('');
    if (restoreFocus) buttonRef.current?.focus();
  }, []);

  const commit = (idx: number) => {
    const opt = visibleOptions[idx];
    if (!opt || opt.disabled) return;
    if (!isControlled) setInternal(opt.value);
    onChange?.(opt.value);
    close();
  };

  useOnClickOutside(rootRef, () => close(false), open);

  // Move DOM focus into the popup when it opens: the search input in searchable
  // mode (combobox), otherwise the listbox itself.
  React.useEffect(() => {
    if (!open) return;
    if (searchable) inputRef.current?.focus();
    else listRef.current?.focus();
  }, [open, searchable]);

  const move = (dir: 1 | -1) => {
    setActiveIndex((prev) => {
      const start = prev < 0 ? (dir === 1 ? -1 : 0) : prev;
      return firstEnabled(start + dir, dir);
    });
  };

  const onButtonKeyDown = (e: React.KeyboardEvent) => {
    switch (e.key) {
      case 'ArrowDown':
      case 'ArrowUp':
      case 'Enter':
      case ' ':
        e.preventDefault();
        openList();
        break;
      default:
        break;
    }
  };

  const typeahead = (char: string) => {
    const s = searchRef.current;
    window.clearTimeout(s.timer);
    s.str += char.toLowerCase();
    const match = visibleOptions.findIndex(
      (o) => !o.disabled && o.label.toLowerCase().startsWith(s.str),
    );
    if (match >= 0) setActiveIndex(match);
    s.timer = window.setTimeout(() => {
      s.str = '';
    }, 500);
  };

  // Shared navigation for the listbox (non-searchable) and the search input
  // (searchable). Returns true if the key was a handled navigation key.
  const handleNavKey = (e: React.KeyboardEvent): boolean => {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        move(1);
        return true;
      case 'ArrowUp':
        e.preventDefault();
        move(-1);
        return true;
      case 'Home':
        e.preventDefault();
        setActiveIndex(firstEnabled(0, 1));
        return true;
      case 'End':
        e.preventDefault();
        setActiveIndex(firstEnabled(visibleOptions.length - 1, -1));
        return true;
      case 'Enter':
        e.preventDefault();
        if (activeIndex >= 0) commit(activeIndex);
        return true;
      case 'Escape':
        e.preventDefault();
        close();
        return true;
      case 'Tab':
        close(false);
        return true;
      default:
        return false;
    }
  };

  const onListKeyDown = (e: React.KeyboardEvent) => {
    // Space selects on the listbox (button-like), and single chars type-ahead.
    if (e.key === ' ') {
      e.preventDefault();
      if (activeIndex >= 0) commit(activeIndex);
      return;
    }
    if (handleNavKey(e)) return;
    if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
      typeahead(e.key);
    }
  };

  const onSearchKeyDown = (e: React.KeyboardEvent) => {
    // Nav keys drive the filtered listbox; everything else types into the input.
    handleNavKey(e);
  };

  const onQueryChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const q = e.target.value;
    setQuery(q);
    // Re-seat the active option onto the first enabled match of the new filter.
    const nextVisible = filter(options, q);
    setActiveIndex(firstEnabledIn(nextVisible, 0, 1));
  };

  const activeId = activeIndex >= 0 ? `${baseId}-opt-${activeIndex}` : undefined;

  const optionList = (
    <ul
      ref={listRef}
      id={listboxId}
      role="listbox"
      tabIndex={-1}
      aria-label={ariaLabel}
      aria-activedescendant={searchable ? undefined : activeId}
      className={cx(styles.listbox, searchable && styles.listboxNested)}
      onKeyDown={searchable ? undefined : onListKeyDown}
    >
      {visibleOptions.length === 0 && searchable && (
        <li role="presentation" className={styles.empty}>
          No matches
        </li>
      )}
      {visibleOptions.map((opt, idx) => {
        const isSelected = opt.value === current;
        const isActive = idx === activeIndex;
        return (
          <li
            key={opt.value}
            id={`${baseId}-opt-${idx}`}
            role="option"
            aria-selected={isSelected}
            aria-disabled={opt.disabled || undefined}
            className={cx(
              styles.option,
              isActive && styles.active,
              opt.disabled && styles.optionDisabled,
            )}
            onMouseEnter={() => !opt.disabled && setActiveIndex(idx)}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => commit(idx)}
          >
            <span className={styles.optionCheck} aria-hidden="true">
              {isSelected && <IconCheck />}
            </span>
            <span className={styles.optionLabel}>{opt.label}</span>
          </li>
        );
      })}
    </ul>
  );

  return (
    <div ref={rootRef} className={cx(styles.root, className)}>
      <button
        ref={buttonRef}
        type="button"
        id={baseId}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        aria-label={ariaLabel}
        aria-invalid={isInvalid || undefined}
        aria-describedby={field?.describedBy}
        className={cx(styles.trigger, isInvalid && styles.invalid, open && styles.open)}
        onClick={() => (open ? close() : openList())}
        onKeyDown={onButtonKeyDown}
      >
        <span className={cx(styles.value, !selectedOption && styles.placeholder)}>
          {selectedOption ? selectedOption.label : placeholder}
        </span>
        <span className={styles.chevron} aria-hidden="true">
          <IconChevron />
        </span>
      </button>

      {open &&
        (searchable ? (
          <div className={styles.popup}>
            <div className={styles.search}>
              <input
                ref={inputRef}
                id={searchId}
                type="text"
                role="combobox"
                autoComplete="off"
                aria-expanded={open}
                aria-controls={listboxId}
                aria-activedescendant={activeId}
                aria-autocomplete="list"
                aria-label={ariaLabel}
                className={styles.searchInput}
                placeholder={searchPlaceholder}
                value={query}
                onChange={onQueryChange}
                onKeyDown={onSearchKeyDown}
              />
            </div>
            {optionList}
          </div>
        ) : (
          optionList
        ))}
    </div>
  );
};

export default Select;
