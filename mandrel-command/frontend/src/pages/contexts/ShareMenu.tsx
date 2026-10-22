/**
 * ShareMenu — the ported Export/Share dropdown (old UI's share menu, rebuilt zero-antd).
 * A small icon button that toggles a token-styled popover listing the client-side share
 * formats (Markdown / Copy text / JSON from `SHARE_FORMATS`). Selecting a format invokes
 * `onShare(format)` and closes. Closes on outside-click / Escape.
 */
import React from 'react';
import { useOnClickOutside } from '../../components/ui';
import { ShareIcon } from './icons';
import { SHARE_FORMATS, type ShareFormat } from './config';
import styles from './Contexts.module.css';

export interface ShareMenuProps {
  onShare: (format: ShareFormat) => void;
}

export const ShareMenu: React.FC<ShareMenuProps> = ({ onShare }) => {
  const [open, setOpen] = React.useState(false);
  const wrapRef = React.useRef<HTMLDivElement>(null);
  useOnClickOutside(wrapRef, () => setOpen(false));

  const pick = (format: ShareFormat) => {
    setOpen(false);
    onShare(format);
  };

  return (
    <div
      className={styles.shareWrap}
      ref={wrapRef}
      onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}
    >
      <button
        type="button"
        className={styles.ricon}
        title="Export / share"
        aria-label="Export or share context"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <ShareIcon size={15} />
      </button>
      {open && (
        <div className={styles.shareMenu} role="menu" aria-label="Share format">
          {SHARE_FORMATS.map((f) => (
            <button
              key={f.value}
              type="button"
              role="menuitem"
              className={styles.shareItem}
              onClick={() => pick(f.value)}
            >
              {f.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

export default ShareMenu;
