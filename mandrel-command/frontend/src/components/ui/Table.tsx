import React from 'react';
import { cx } from './cx';
import { Empty } from './Empty';
import { Skeleton } from './Skeleton';
import { Checkbox } from './Checkbox';
import styles from './Table.module.css';

/**
 * DataTable (P0.3b) — a semantic <table> for the tasks/contexts/sessions lists.
 * Sortable column headers report state via aria-sort + onSortChange (report-only:
 * the caller owns data order — no hidden reordering). Loading → skeleton rows;
 * no rows → the Empty primitive (or a custom node). Optional row selection with
 * a header select-all (indeterminate) built on the Checkbox primitive.
 */
export type SortDirection = 'asc' | 'desc';
export interface SortState {
  key: string;
  direction: SortDirection;
}

export interface Column<T> {
  key: string;
  header: React.ReactNode;
  sortable?: boolean;
  align?: 'left' | 'right' | 'center';
  width?: string | number;
  /** Cell renderer; defaults to `String(row[key])`. */
  render?: (row: T) => React.ReactNode;
}

export interface DataTableProps<T> {
  columns: Column<T>[];
  data: T[];
  rowKey: (row: T, index: number) => string;
  sort?: SortState | null;
  defaultSort?: SortState | null;
  onSortChange?: (sort: SortState | null) => void;
  loading?: boolean;
  skeletonRows?: number;
  /** Custom empty node; defaults to the Empty primitive. */
  empty?: React.ReactNode;
  selectable?: boolean;
  selectedKeys?: string[];
  onSelectionChange?: (keys: string[]) => void;
  caption?: React.ReactNode;
  className?: string;
}

const alignClass = {
  left: styles.alignLeft,
  right: styles.alignRight,
  center: styles.alignCenter,
} as const;

const IconSort = ({ dir }: { dir: SortDirection | null }) => (
  <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={cx(styles.sortIcon, dir && styles.sortActive)} aria-hidden="true">
    {dir === 'asc' ? (
      <path d="M8 14l4-4 4 4" />
    ) : dir === 'desc' ? (
      <path d="M8 10l4 4 4-4" />
    ) : (
      <path d="M8 10l4-4 4 4M8 14l4 4 4-4" />
    )}
  </svg>
);

export function DataTable<T>({
  columns,
  data,
  rowKey,
  sort,
  defaultSort = null,
  onSortChange,
  loading = false,
  skeletonRows = 5,
  empty,
  selectable = false,
  selectedKeys,
  onSelectionChange,
  caption,
  className,
}: DataTableProps<T>) {
  const sortControlled = sort !== undefined;
  const [internalSort, setInternalSort] = React.useState<SortState | null>(defaultSort);
  const currentSort = sortControlled ? sort : internalSort;

  const cycleSort = (key: string) => {
    let next: SortState | null;
    if (!currentSort || currentSort.key !== key) next = { key, direction: 'asc' };
    else if (currentSort.direction === 'asc') next = { key, direction: 'desc' };
    else next = null;
    if (!sortControlled) setInternalSort(next);
    onSortChange?.(next);
  };

  const selectionControlled = selectedKeys !== undefined;
  const [internalSel, setInternalSel] = React.useState<string[]>([]);
  const selection = selectionControlled ? selectedKeys : internalSel;
  const selSet = React.useMemo(() => new Set(selection), [selection]);

  const setSelection = (keys: string[]) => {
    if (!selectionControlled) setInternalSel(keys);
    onSelectionChange?.(keys);
  };

  const allKeys = data.map((r, i) => rowKey(r, i));
  const allSelected = allKeys.length > 0 && allKeys.every((k) => selSet.has(k));
  const someSelected = allKeys.some((k) => selSet.has(k));

  const toggleAll = () => setSelection(allSelected ? [] : allKeys);
  const toggleRow = (key: string) =>
    setSelection(selSet.has(key) ? selection.filter((k) => k !== key) : [...selection, key]);

  const totalCols = columns.length + (selectable ? 1 : 0);
  const isEmpty = !loading && data.length === 0;

  return (
    <div className={cx(styles.wrap, className)}>
      <table className={styles.table}>
        {caption != null && <caption className={styles.caption}>{caption}</caption>}
        <thead>
          <tr>
            {selectable && (
              <th scope="col" className={cx(styles.th, styles.selectCol)}>
                <Checkbox
                  checked={allSelected}
                  indeterminate={!allSelected && someSelected}
                  onChange={toggleAll}
                  aria-label="Select all rows"
                />
              </th>
            )}
            {columns.map((col) => {
              const active = currentSort?.key === col.key ? currentSort.direction : null;
              const ariaSort = active
                ? active === 'asc'
                  ? 'ascending'
                  : 'descending'
                : col.sortable
                  ? 'none'
                  : undefined;
              return (
                <th
                  key={col.key}
                  scope="col"
                  aria-sort={ariaSort}
                  style={col.width ? { width: col.width } : undefined}
                  className={cx(styles.th, col.align && alignClass[col.align])}
                >
                  {col.sortable ? (
                    <button
                      type="button"
                      className={styles.sortBtn}
                      onClick={() => cycleSort(col.key)}
                    >
                      <span>{col.header}</span>
                      <IconSort dir={active} />
                    </button>
                  ) : (
                    col.header
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {loading &&
            Array.from({ length: skeletonRows }).map((_, r) => (
              <tr key={`sk-${r}`} className={styles.row}>
                {selectable && (
                  <td className={cx(styles.td, styles.selectCol)}>
                    <Skeleton shape="block" width={17} height={17} />
                  </td>
                )}
                {columns.map((col) => (
                  <td key={col.key} className={cx(styles.td, col.align && alignClass[col.align])}>
                    <Skeleton shape="line" width="70%" />
                  </td>
                ))}
              </tr>
            ))}

          {!loading &&
            data.map((row, i) => {
              const key = rowKey(row, i);
              const selected = selSet.has(key);
              return (
                <tr
                  key={key}
                  className={cx(styles.row, selected && styles.rowSelected)}
                  aria-selected={selectable ? selected : undefined}
                >
                  {selectable && (
                    <td className={cx(styles.td, styles.selectCol)}>
                      <Checkbox
                        checked={selected}
                        onChange={() => toggleRow(key)}
                        aria-label={`Select row ${i + 1}`}
                      />
                    </td>
                  )}
                  {columns.map((col) => (
                    <td key={col.key} className={cx(styles.td, col.align && alignClass[col.align])}>
                      {col.render ? col.render(row) : String((row as Record<string, unknown>)[col.key] ?? '')}
                    </td>
                  ))}
                </tr>
              );
            })}

          {isEmpty && (
            <tr>
              <td colSpan={totalCols} className={styles.emptyCell}>
                {empty ?? <Empty title="No rows" description="There is nothing to show here yet." />}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

export default DataTable;
