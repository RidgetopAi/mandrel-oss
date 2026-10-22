import React from 'react';
import { cx } from './cx';
import styles from './Text.module.css';

/**
 * Typography primitive (P0.3) — the type scale from the LOCKED design language
 * (command-design-language.html "Type" reference): Display/Title/Body/Label/Data.
 *
 * Every size/weight/tracking/colour is a `var(--token)` — nothing hardcoded.
 * `<Text>` is the base; `Heading`, `Label`, `Code` are thin, semantic wrappers.
 */
export type TextVariant = 'display' | 'title' | 'body' | 'label' | 'data';

export type TextTone =
  | 'default' // --tx
  | 'muted' // --tx-2
  | 'faint' // --tx-3
  | 'faintest' // --tx-4
  | 'teal'
  | 'violet'
  | 'blue'
  | 'green'
  | 'amber'
  | 'rose'
  | 'ok'
  | 'warn'
  | 'crit';

const variantClass: Record<TextVariant, string> = {
  display: styles.display,
  title: styles.title,
  body: styles.body,
  label: styles.label,
  data: styles.data,
};

const toneClass: Record<TextTone, string> = {
  default: styles.toneDefault,
  muted: styles.toneMuted,
  faint: styles.toneFaint,
  faintest: styles.toneFaintest,
  teal: styles.toneTeal,
  violet: styles.toneViolet,
  blue: styles.toneBlue,
  green: styles.toneGreen,
  amber: styles.toneAmber,
  rose: styles.toneRose,
  ok: styles.toneOk,
  warn: styles.toneWarn,
  crit: styles.toneCrit,
};

export interface TextOwnProps {
  /** Semantic element to render as. Defaults to `span`. */
  as?: React.ElementType;
  variant?: TextVariant;
  tone?: TextTone;
  /** Force the monospace face (default for the `data` variant). */
  mono?: boolean;
  /** Single-line ellipsis truncation. */
  truncate?: boolean;
  align?: 'left' | 'center' | 'right';
  className?: string;
  children?: React.ReactNode;
}

export type TextProps = TextOwnProps &
  Omit<React.HTMLAttributes<HTMLElement>, keyof TextOwnProps>;

export const Text: React.FC<TextProps> = ({
  as,
  variant = 'body',
  tone = 'default',
  mono = false,
  truncate = false,
  align,
  className,
  children,
  ...rest
}) => {
  const Component = as ?? 'span';
  return (
    <Component
      className={cx(
        styles.text,
        variantClass[variant],
        toneClass[tone],
        mono && styles.mono,
        truncate && styles.truncate,
        align === 'center' && styles.alignCenter,
        align === 'right' && styles.alignRight,
        className,
      )}
      {...rest}
    >
      {children}
    </Component>
  );
};

// ── Semantic convenience wrappers ────────────────────────────────────────────

export interface HeadingProps extends Omit<TextProps, 'variant' | 'as'> {
  /** h1–h6. Maps to the `display` (1–2) or `title` (3–6) scale by default. */
  level?: 1 | 2 | 3 | 4 | 5 | 6;
  variant?: Extract<TextVariant, 'display' | 'title'>;
}

export const Heading: React.FC<HeadingProps> = ({ level = 2, variant, ...rest }) => {
  const tag = `h${level}` as React.ElementType;
  return <Text as={tag} variant={variant ?? (level <= 2 ? 'display' : 'title')} {...rest} />;
};

export type LabelProps = Omit<TextProps, 'variant'>;
export const Label: React.FC<LabelProps> = (props) => (
  <Text variant="label" {...props} />
);

export type CodeProps = Omit<TextProps, 'variant' | 'mono' | 'as'>;
export const Code: React.FC<CodeProps> = (props) => (
  <Text as="code" variant="data" mono {...props} />
);

export default Text;
