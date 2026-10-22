/**
 * AttachmentGallery — the detail's images, split BEFORE (what was photographed when the
 * punch was filed) / EVIDENCE (what the Walkthrough critic uploads when it is proven).
 * Both sections always render — an empty Evidence section says "no evidence yet" quietly
 * rather than vanishing, because "nothing here yet" is information on a punch board.
 * Each image has a Delete (confirmed inline, never a modal on a phone). Only `image/*`
 * renders as an <img>, clickable/focusable to open the full-size authed blob in a new tab
 * (an earlier task — a gallery image had no click target at all); the API's other allowed
 * kinds (text/plain, application/json) get a file tile that opens the authed bytes on click
 * (AuthedFileTile), the same open mechanism.
 */
import React from 'react';
import { Button, Spinner, Alert, cx } from '../../components/ui';
import { apiErrorMessage } from '../../api/request';
import { AuthedImage } from './AuthedImage';
import { AuthedFileTile } from './AuthedFileTile';
import { PUNCH_COPY } from './config';
import type { TaskAttachment, AttachmentKind } from '../../types/attachment';
import styles from './Punch.module.css';

export interface AttachmentGalleryProps {
  attachments: TaskAttachment[] | undefined;
  isLoading: boolean;
  isError: boolean;
  error: unknown;
  onDelete: (attachment: TaskAttachment) => void;
  deletingId?: string | null;
  deleteError?: unknown;
}

const SECTIONS: ReadonlyArray<{ kind: AttachmentKind; label: string; empty: string }> = [
  { kind: 'before', label: 'Before', empty: PUNCH_COPY.noBefore },
  { kind: 'evidence', label: 'Evidence', empty: PUNCH_COPY.noEvidence },
];

export const AttachmentGallery: React.FC<AttachmentGalleryProps> = ({
  attachments,
  isLoading,
  isError,
  error,
  onDelete,
  deletingId,
  deleteError,
}) => {
  const [confirmId, setConfirmId] = React.useState<string | null>(null);

  if (isLoading) {
    return (
      <div className={styles.galleryState}>
        <Spinner size="sm" />
      </div>
    );
  }
  if (isError) {
    return (
      <Alert variant="error" title="Couldn't load attachments">
        {apiErrorMessage(error, 'The request failed.')}
      </Alert>
    );
  }
  const rows = attachments ?? [];

  return (
    <div className={styles.gallery}>
      {deleteError != null && (
        <Alert variant="error" title="Couldn't delete the image">
          {apiErrorMessage(deleteError, 'The request failed.')}
        </Alert>
      )}
      {SECTIONS.map((sec) => {
        const items = rows.filter((a) => a.kind === sec.kind);
        return (
          <section key={sec.kind} className={styles.gallerySection} data-kind={sec.kind}>
            <h3 className={styles.galleryLabel}>
              {sec.label}
              <span className={styles.galleryCount}>{items.length}</span>
            </h3>
            {items.length === 0 ? (
              <p className={styles.galleryEmpty}>{sec.empty}</p>
            ) : (
              <ul className={styles.galleryGrid}>
                {items.map((a) => {
                  const confirming = confirmId === a.id;
                  const deleting = deletingId === a.id;
                  return (
                    <li key={a.id} className={cx(styles.galleryItem, deleting && styles.galleryDeleting)}>
                      {a.mime.startsWith('image/') ? (
                        <AuthedImage attachmentId={a.id} alt={a.filename} className={styles.galleryImg} openOnClick />
                      ) : (
                        <AuthedFileTile
                          attachmentId={a.id}
                          filename={a.filename}
                          mime={a.mime}
                          byteSize={a.byteSize}
                          className={styles.galleryImg}
                        />
                      )}
                      <div className={styles.galleryMeta}>
                        <span className={styles.galleryName} title={a.filename}>
                          {a.filename}
                        </span>
                        {confirming ? (
                          <span className={styles.galleryConfirm}>
                            <Button size="sm" variant="danger" loading={deleting} onClick={() => onDelete(a)}>
                              Delete
                            </Button>
                            <Button size="sm" variant="subtle" onClick={() => setConfirmId(null)} disabled={deleting}>
                              Keep
                            </Button>
                          </span>
                        ) : (
                          <Button
                            size="sm"
                            variant="subtle"
                            onClick={() => setConfirmId(a.id)}
                            aria-label={`Delete ${a.filename}`}
                          >
                            Delete
                          </Button>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
};

export default AttachmentGallery;
