/**
 * AuthedFileTile — the non-image attachment (the API allows text/plain and
 * application/json). An `<img>` for these was a broken-image glyph (Reviewer
 * #5). A file tile instead: icon + filename + size, and a click fetches the bytes through
 * the AUTHED client (never a bearer token in a URL) and opens them in a new tab as an
 * object URL. Nothing is fetched until the click — a board of notes should not download
 * every note on mount.
 */
import React from 'react';
import { cx } from '../../components/ui';
import { openAuthedAttachment } from './openAuthedAttachment';
import styles from './Punch.module.css';

const KIB = 1024;

/** `1234` → `1.2 KB`. Small and local; the gallery is its only reader. */
export function formatByteSize(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '';
  if (n < KIB) return `${n} B`;
  if (n < KIB * KIB) return `${(n / KIB).toFixed(n < 10 * KIB ? 1 : 0)} KB`;
  return `${(n / (KIB * KIB)).toFixed(1)} MB`;
}

export interface AuthedFileTileProps {
  attachmentId: string;
  filename: string;
  mime: string;
  byteSize: number;
  className?: string;
}

export const AuthedFileTile: React.FC<AuthedFileTileProps> = ({ attachmentId, filename, mime, byteSize, className }) => {
  const [opening, setOpening] = React.useState(false);
  const [failed, setFailed] = React.useState(false);

  const open = async () => {
    setOpening(true);
    setFailed(false);
    try {
      await openAuthedAttachment(attachmentId);
    } catch {
      setFailed(true);
    } finally {
      setOpening(false);
    }
  };

  return (
    <button
      type="button"
      className={cx(styles.fileTile, className)}
      onClick={open}
      disabled={opening}
      aria-label={`Open ${filename}`}
      title={filename}
    >
      <span className={styles.fileIcon} aria-hidden="true">
        {mime === 'application/json' ? '{ }' : '≡'}
      </span>
      <span className={styles.fileName}>{filename}</span>
      <span className={styles.fileSize}>{formatByteSize(byteSize)}</span>
      {failed && <span className={styles.fileError}>couldn&apos;t open</span>}
    </button>
  );
};

export default AuthedFileTile;
