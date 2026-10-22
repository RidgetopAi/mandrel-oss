import React from 'react';
import { createPortal } from 'react-dom';
import { cx } from './cx';
import { useFocusTrap, useScrollLock } from './hooks';
import styles from './Drawer.module.css';

/**
 * Drawer (P0.3b) — an edge-anchored panel for detail/edit surfaces. Same a11y as
 * Modal (role="dialog" aria-modal, focus trap + restore, Esc, scroll-lock,
 * labelledby) but slides in from the right (default) or left. Portal-rendered;
 * nothing renders while closed.
 */
export type DrawerSide = 'right' | 'left';

export interface DrawerProps {
  open: boolean;
  onClose: () => void;
  title?: React.ReactNode;
  children?: React.ReactNode;
  footer?: React.ReactNode;
  side?: DrawerSide;
  closeOnBackdrop?: boolean;
  initialFocusRef?: React.RefObject<HTMLElement>;
  'aria-label'?: string;
  className?: string;
}

const sideClass: Record<DrawerSide, string> = {
  right: styles.right,
  left: styles.left,
};

export const Drawer: React.FC<DrawerProps> = ({
  open,
  onClose,
  title,
  children,
  footer,
  side = 'right',
  closeOnBackdrop = true,
  initialFocusRef,
  'aria-label': ariaLabel,
  className,
}) => {
  const panelRef = React.useRef<HTMLDivElement>(null);
  const auto = React.useId();
  const titleId = title ? `${auto}-title` : undefined;

  useScrollLock(open);
  useFocusTrap(open, panelRef, { onEscape: onClose, initialFocusRef });

  if (!open) return null;

  return createPortal(
    <div
      className={cx(styles.backdrop, sideClass[side])}
      onMouseDown={closeOnBackdrop ? onClose : undefined}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-label={titleId ? undefined : ariaLabel}
        tabIndex={-1}
        className={cx(styles.panel, sideClass[side], className)}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {title != null && (
          <div className={styles.header}>
            <h2 id={titleId} className={styles.title}>
              {title}
            </h2>
            <button type="button" className={styles.close} aria-label="Close panel" onClick={onClose}>
              <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
                <path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
              </svg>
            </button>
          </div>
        )}
        <div className={styles.body}>{children}</div>
        {footer != null && <div className={styles.footer}>{footer}</div>}
      </div>
    </div>,
    document.body,
  );
};

export default Drawer;
