/**
 * PhotoPicker — the form's Photo field: a camera-first file input on a phone
 * (`capture="environment"` opens the rear camera), a drop zone on desktop, previews, and
 * remove-before-upload. Holds `File`s only; the form uploads them after the task exists.
 */
import React from 'react';
import { cx } from '../../components/ui';
import { PUNCH_COPY } from './config';
import styles from './Punch.module.css';

export interface PhotoPickerProps {
  files: File[];
  onChange: (files: File[]) => void;
  disabled?: boolean;
  id?: string;
}

function onlyImages(list: ArrayLike<File> | null | undefined): File[] {
  return Array.from(list ?? []).filter((f) => f.type.startsWith('image/'));
}

export const PhotoPicker: React.FC<PhotoPickerProps> = ({ files, onChange, disabled = false, id }) => {
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [over, setOver] = React.useState(false);
  const previews = React.useMemo(() => files.map((f) => ({ f, url: URL.createObjectURL(f) })), [files]);
  React.useEffect(() => () => previews.forEach((p) => URL.revokeObjectURL(p.url)), [previews]);

  const add = (incoming: File[]) => {
    if (incoming.length === 0) return;
    onChange([...files, ...incoming]);
  };

  return (
    <div className={styles.photo}>
      <div
        className={cx(styles.dropzone, over && styles.dropzoneOver, disabled && styles.dropzoneDisabled)}
        onDragOver={(e) => {
          e.preventDefault();
          if (!disabled) setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          if (!disabled) add(onlyImages(e.dataTransfer?.files));
        }}
      >
        <input
          ref={inputRef}
          id={id}
          type="file"
          accept="image/*"
          capture="environment"
          multiple
          disabled={disabled}
          className={styles.fileInput}
          aria-label="Add a photo"
          onChange={(e) => {
            add(onlyImages(e.target.files));
            // Let the same photo be picked again after a remove.
            e.target.value = '';
          }}
        />
        <button
          type="button"
          className={styles.photoBtn}
          disabled={disabled}
          onClick={() => inputRef.current?.click()}
        >
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 8h3l2-3h6l2 3h3v11H4z" />
            <circle cx="12" cy="13" r="3.5" />
          </svg>
          {files.length === 0 ? 'Take or choose a photo' : 'Add another'}
        </button>
        <span className={styles.photoHint}>{PUNCH_COPY.photoHint}</span>
      </div>
      {previews.length > 0 && (
        <ul className={styles.previews}>
          {previews.map((p, i) => (
            <li key={`${p.f.name}-${i}`} className={styles.preview}>
              <img src={p.url} alt={p.f.name} className={styles.previewImg} />
              <button
                type="button"
                className={styles.previewRemove}
                aria-label={`Remove ${p.f.name}`}
                disabled={disabled}
                onClick={() => onChange(files.filter((_, j) => j !== i))}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};

export default PhotoPicker;
