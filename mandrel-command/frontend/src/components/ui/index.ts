/**
 * Command primitive component library (P0.3 — PASS 1 + PASS 2).
 *
 * Token-driven, CSS-Modules, zero-runtime primitives. Every primitive reads the
 * P0.2 design tokens via `var(--token)` — no hardcoded hex/colour anywhere (see
 * the guard in ui.guards.test.ts). Import from here:
 *
 *   import { Button, Card, Input, Select, Modal, DataTable } from '@/components/ui';
 *
 * PASS 1 = presentational + pattern set. PASS 2 (P0.3b) adds the interactive /
 * overlay set: Field/Form, Input/Textarea/NumberInput, Checkbox/Radio/Switch,
 * Select (listbox), Modal + Drawer (focus-trapped), and DataTable — all with
 * real a11y (labels, keyboard, focus trap, aria).
 */

// Helpers
export { cx } from './cx';
export type { ClassValue } from './cx';

// Typography
export { Text, Heading, Label, Code } from './Text';
export type { TextProps, TextVariant, TextTone, HeadingProps, LabelProps, CodeProps } from './Text';

// Button
export { Button } from './Button';
export type { ButtonProps, ButtonVariant, ButtonSize } from './Button';

// Card / Panel
export { Card, CardHeader, CardBody, CardFooter } from './Card';
export type { CardProps, CardSectionProps } from './Card';

// Badge / Tag
export { Badge } from './Badge';
export type { BadgeProps, BadgeVariant } from './Badge';

// Status pill
export { StatusPill } from './StatusPill';
export type { StatusPillProps, StatusTone } from './StatusPill';

// Alert / Callout
export { Alert } from './Alert';
export type { AlertProps, AlertVariant } from './Alert';

// Empty state
export { Empty } from './Empty';
export type { EmptyProps } from './Empty';

// Spinner / Skeleton
export { Spinner } from './Spinner';
export type { SpinnerProps, SpinnerSize } from './Spinner';
export { Skeleton } from './Skeleton';
export type { SkeletonProps, SkeletonShape } from './Skeleton';

// Tooltip
export { Tooltip } from './Tooltip';
export type { TooltipProps, TooltipPlacement } from './Tooltip';

// StatTile / Statistic
export { StatTile } from './StatTile';
export type { StatTileProps, TrendDirection } from './StatTile';

// Tabs
export { Tabs } from './Tabs';
export type { TabsProps, TabItem } from './Tabs';

// Layout
export { Stack } from './Stack';
export type { StackProps, SpaceStep } from './Stack';
export { Grid } from './Grid';
export type { GridProps } from './Grid';
export { Divider } from './Divider';
export type { DividerProps } from './Divider';

// ── PASS 2 (P0.3b) — interactive / overlay set ──────────────────────────────

// Field harness + Form layout
export { Field, useFieldContext } from './Field';
export type { FieldProps, FieldContextValue } from './Field';
export { Form, FormActions } from './Form';
export type { FormProps, FormActionsProps } from './Form';

// Text controls
export { Input } from './Input';
export type { InputProps } from './Input';
export { Textarea } from './Textarea';
export type { TextareaProps } from './Textarea';
export { NumberInput } from './NumberInput';
export type { NumberInputProps } from './NumberInput';

// Toggles
export { Checkbox } from './Checkbox';
export type { CheckboxProps } from './Checkbox';
export { Radio, RadioGroup } from './Radio';
export type { RadioProps, RadioGroupProps } from './Radio';
export { Switch } from './Switch';
export type { SwitchProps } from './Switch';

// Select (listbox)
export { Select } from './Select';
export type { SelectProps, SelectOption } from './Select';

// Combobox — a free-text input WITH suggestions. Use it, not Select,
// whenever the vocabulary is open: it steers toward a canonical spelling without making
// an unlisted value impossible.
export { Combobox, filterComboboxOptions } from './Combobox';
export type { ComboboxProps, ComboboxOption } from './Combobox';

// ProjectSelect — THE project selector every project-scoped page uses. Pair it with
// hooks/usePageProject (`<ProjectSelect {...project.selectProps} />`). See the header
// of ProjectSelect.tsx for the contract; do not hand-roll a project dropdown.
export {
  ProjectSelect,
  ALL_PROJECTS_VALUE,
  ALL_PROJECTS_LABEL,
  UNASSIGNED_PROJECT_VALUE,
  UNASSIGNED_PROJECT_LABEL,
  SEARCHABLE_THRESHOLD,
} from './ProjectSelect';
export type { ProjectSelectProps, ProjectSelectItem } from './ProjectSelect';

// Overlays
export { Modal } from './Modal';
export type { ModalProps, ModalSize } from './Modal';
export { Drawer } from './Drawer';
export type { DrawerProps, DrawerSide } from './Drawer';

// DataTable
export { DataTable } from './Table';
export type { DataTableProps, Column, SortState, SortDirection } from './Table';

// Overlay behaviour hooks (shared a11y building blocks)
export { useFocusTrap, useScrollLock, useOnClickOutside, getFocusable } from './hooks';

// Popup placement (shared): flip an absolutely-positioned popup upward when the scrolling
// ancestor that clips it leaves no room below. Combobox uses it; Select's popup carries the
// identical downward-only pattern and can adopt this without reimplementing the measurement.
export {
  usePopupPlacement,
  choosePopupPlacement,
  findClipBounds,
  readPxCustomProperty,
} from './popupPlacement';
export type { PopupPlacement, VerticalBounds, ChoosePlacementInput } from './popupPlacement';
