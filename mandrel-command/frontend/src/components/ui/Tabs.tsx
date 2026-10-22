import React from 'react';
import { cx } from './cx';
import styles from './Tabs.module.css';

/**
 * Tabs primitive (P0.3). Underline tab bar + panels, matching the doc's calm
 * treatment (active = teal underline + primary text; rest muted). Works
 * controlled (`activeKey` + `onChange`) OR uncontrolled (`defaultActiveKey`).
 * Full ARIA: role tablist/tab/tabpanel, aria-selected, roving tabindex + arrow
 * / Home / End keyboard navigation.
 */
export interface TabItem {
  key: string;
  label: React.ReactNode;
  content?: React.ReactNode;
  disabled?: boolean;
}

export interface TabsProps {
  items: TabItem[];
  /** Controlled active key. */
  activeKey?: string;
  /** Initial active key for uncontrolled use. Defaults to the first item. */
  defaultActiveKey?: string;
  onChange?: (key: string) => void;
  /** Accessible name for the tablist. */
  'aria-label'?: string;
  className?: string;
}

export const Tabs: React.FC<TabsProps> = ({
  items,
  activeKey,
  defaultActiveKey,
  onChange,
  'aria-label': ariaLabel,
  className,
}) => {
  const isControlled = activeKey !== undefined;
  const [internalKey, setInternalKey] = React.useState<string>(
    defaultActiveKey ?? items[0]?.key ?? '',
  );
  const current = isControlled ? (activeKey as string) : internalKey;

  const select = (key: string) => {
    if (!isControlled) setInternalKey(key);
    onChange?.(key);
  };

  const tabRefs = React.useRef<Record<string, HTMLButtonElement | null>>({});

  const onKeyDown = (e: React.KeyboardEvent, index: number) => {
    const enabled = items.filter((it) => !it.disabled);
    if (enabled.length === 0) return;
    const pos = enabled.findIndex((it) => it.key === items[index].key);
    let next: TabItem | undefined;
    switch (e.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        next = enabled[(pos + 1) % enabled.length];
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        next = enabled[(pos - 1 + enabled.length) % enabled.length];
        break;
      case 'Home':
        next = enabled[0];
        break;
      case 'End':
        next = enabled[enabled.length - 1];
        break;
      default:
        return;
    }
    if (next) {
      e.preventDefault();
      select(next.key);
      tabRefs.current[next.key]?.focus();
    }
  };

  const activeItem = items.find((it) => it.key === current);

  return (
    <div className={cx(styles.tabs, className)}>
      <div role="tablist" aria-label={ariaLabel} className={styles.tablist}>
        {items.map((item, index) => {
          const selected = item.key === current;
          return (
            <button
              key={item.key}
              ref={(el) => {
                tabRefs.current[item.key] = el;
              }}
              role="tab"
              type="button"
              id={`tab-${item.key}`}
              aria-selected={selected}
              aria-controls={`tabpanel-${item.key}`}
              tabIndex={selected ? 0 : -1}
              disabled={item.disabled}
              className={cx(styles.tab, selected && styles.tabActive)}
              onClick={() => !item.disabled && select(item.key)}
              onKeyDown={(e) => onKeyDown(e, index)}
            >
              {item.label}
            </button>
          );
        })}
      </div>
      {activeItem && (
        <div
          role="tabpanel"
          id={`tabpanel-${activeItem.key}`}
          aria-labelledby={`tab-${activeItem.key}`}
          tabIndex={0}
          className={styles.panel}
        >
          {activeItem.content}
        </div>
      )}
    </div>
  );
};

export default Tabs;
