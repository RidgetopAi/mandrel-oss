/**
 * AuthedImage — an `<img>` for a bearer-authed attachment, via useAuthedImage. Honest
 * states: a skeleton box while loading, a quiet "couldn't load" box on error, never a
 * broken-image glyph and never a token in a URL.
 *
 * `openOnClick` (the gallery's use) turns the thumbnail into a focusable
 * control named after `alt` that opens the FULL-SIZE authed blob in a new tab, via the
 * same fetch → object URL → window.open mechanism AuthedFileTile uses (openAuthedAttachment).
 * It fetches fresh on click rather than reusing the thumbnail's object URL, because that URL
 * is revoked on unmount/id-change and a fresh fetch matches the file tile exactly. Left off
 * by default: PunchCard's board-card thumbnail lives inside the card's OWN clickable
 * `<button>`, so it must stay inert rather than fight that click for meaning.
 */
import React from 'react';
import { cx } from '../../components/ui';
import { useAuthedImage } from '../../hooks/useAuthedImage';
import { openAuthedAttachment } from './openAuthedAttachment';
import styles from './Punch.module.css';

export interface AuthedImageProps {
  attachmentId: string;
  alt: string;
  className?: string;
  openOnClick?: boolean;
}

export const AuthedImage: React.FC<AuthedImageProps> = ({ attachmentId, alt, className, openOnClick = false }) => {
  const { src, loading, error } = useAuthedImage(attachmentId);
  const [opening, setOpening] = React.useState(false);

  if (loading) return <span className={cx(styles.imgBox, styles.imgLoading, className)} aria-busy="true" />;
  if (error || !src) {
    return (
      <span className={cx(styles.imgBox, styles.imgError, className)} role="img" aria-label={`${alt} (couldn't load)`}>
        !
      </span>
    );
  }
  if (!openOnClick) {
    return <img src={src} alt={alt} className={cx(styles.img, className)} />;
  }

  const open = () => {
    if (opening) return;
    setOpening(true);
    // Best-effort: the thumbnail already loaded fine, so a failure here is rare and has no
    // dedicated UI slot on an image (unlike AuthedFileTile's text "couldn't open").
    openAuthedAttachment(attachmentId).finally(() => setOpening(false));
  };

  return (
    <img
      src={src}
      alt={alt}
      className={cx(styles.img, className)}
      role="button"
      tabIndex={0}
      aria-label={`Open ${alt}`}
      aria-busy={opening}
      onClick={open}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          open();
        }
      }}
    />
  );
};

export default AuthedImage;
