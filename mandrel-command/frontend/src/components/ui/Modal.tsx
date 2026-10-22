import React from 'react';
import { createPortal } from 'react-dom';
import { cx } from './cx';
import { useFocusTrap, useScrollLock } from './hooks';
import styles from './Modal.module.css';

/**
 * Modal (P0.3b) — a centered dialog rendered in a portal. role="dialog"
 * aria-modal with a FOCUS TRAP (Tab cycles within; focus restored to the trigger
 * on close), Esc to close, backdrop-click to close (opt-out), body scroll-lock,
 * and aria-labelledby wired to the title. Nothing renders while closed.
 */
export type ModalSize = 'sm' | 'md' | 'lg';

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: React.ReactNode;
  children?: React.ReactNode;
  footer?: React.ReactNode;
  size?: ModalSize;
  /** Close when the backdrop is clicked (default true). */
  closeOnBackdrop?: boolean;
  /** Focus this element first instead of the first focusable. */
  initialFocusRef?: React.RefObject<HTMLElement>;
  /** Accessible name when there is no visible title. */
  'aria-label'?: string;
  className?: string;
}

const sizeClass: Record<ModalSize, string> = {
  sm: styles.sm,
  md: styles.md,
  lg: styles.lg,
};

export const Modal: React.FC<ModalProps> = ({
  open,
  onClose,
  title,
  children,
  footer,
  size = 'md',
  closeOnBackdrop = true,
  initialFocusRef,
  'aria-label': ariaLabel,
  className,
}) => {
  const dialogRef = React.useRef<HTMLDivElement>(null);
  const auto = React.useId();
  const titleId = title ? `${auto}-title` : undefined;

  useScrollLock(open);
  useFocusTrap(open, dialogRef, { onEscape: onClose, initialFocusRef });

  if (!open) return null;

  return createPortal(
    <div className={styles.backdrop} onMouseDown={closeOnBackdrop ? onClose : undefined}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-label={titleId ? undefined : ariaLabel}
        tabIndex={-1}
        className={cx(styles.dialog, sizeClass[size], className)}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {title != null && (
          <div className={styles.header}>
            <h2 id={titleId} className={styles.title}>
              {title}
            </h2>
            <button type="button" className={styles.close} aria-label="Close dialog" onClick={onClose}>
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

export default Modal;
