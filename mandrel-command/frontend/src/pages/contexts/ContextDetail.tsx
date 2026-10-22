/**
 * ContextDetail — the RIGHT COLUMN of the Contexts rail+reader screen: the selected
 * context's detail, rendered IN PLACE beside the list (NOT a slide-over, NOT a separate
 * route). Driven by the `/contexts/:id` route param via the page, so it is also the
 * deep-link + `/r/:id` resolve landing target.
 *
 * Owns the detail data (record + typed links + related) and the mutations. Two modes:
 *   - READ: the ContextReader body (markdown + typed ThreadBox moat) with the full action
 *     cluster (copy-id / copy-ref / share / edit / delete), plus the collapsible Related
 *     (semantic) and Metadata sections passed into the reader's `sections` slot so the
 *     detail reads as ONE reader card — the same shape the Decisions reader has.
 *   - EDIT: an inline content + tags form, saving through useUpdateContext.
 * Delete is a danger action gated behind a confirm Modal (useDeleteContext).
 *
 * HISTORY: this was ContextDrawer (a right-anchored slide-over over a card grid, shipped
 * 2026-07-16). The operator reversed the grid after using it live — the rail+reader reads better
 * for long-form memory records and unifies Contexts with Decisions.
 * The drawer's CHROME is gone; every action it carried is preserved here.
 */
import React from 'react';
import { Link } from 'react-router-dom';
import {
  Modal,
  Button,
  Form,
  Field,
  Input,
  Textarea,
  Alert,
  Spinner,
} from '../../components/ui';
import { ContextReader } from './ContextReader';
import { ChevronDown, ChevronRight } from './icons';
import { kindDotVar, type ShareFormat } from './config';
import { id8 } from './parts';
import { shareContext } from './share';
import {
  useContext,
  useContextLinks,
  useUpdateContext,
  useDeleteContext,
  useRestoreContext,
  useRelatedContexts,
} from './hooks';
import { buildNavHref } from '../../utils/navIdLinkify';
import type { Context } from '../../types/context';
import styles from './Contexts.module.css';
import { apiErrorMessage } from '../../api/request';

export interface ContextDetailProps {
  id: string | null;
  /** An already-loaded list row for this id — paints the reader instantly while detail settles. */
  fallback?: Context;
  /**
   * Called after a successful delete. The record is gone, so the page DESELECTS (navigates
   * back to /contexts) rather than leaving the reader pointed at a deleted id. (The drawer
   * used to close itself here; inline, deselecting is the equivalent.)
   */
  onDeleted?: () => void;
}

type Mode = 'read' | 'edit';

/** A collapsible disclosure section (Related / Metadata) with a chevron header. */
const Section: React.FC<{
  label: string;
  count?: number;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}> = ({ label, count, open, onToggle, children }) => (
  <div className={styles.section}>
    <button
      type="button"
      className={styles.sectionHead}
      aria-expanded={open}
      aria-label={label}
      onClick={onToggle}
    >
      {open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
      <span>{label}</span>
      {count != null && count > 0 && <span className={styles.sectionCount}>{count}</span>}
    </button>
    {open && <div className={styles.sectionBody}>{children}</div>}
  </div>
);

export const ContextDetail: React.FC<ContextDetailProps> = ({ id, fallback, onDeleted }) => {
  const detail = useContext(id);
  const links = useContextLinks(id);
  const updateMutation = useUpdateContext();
  const deleteMutation = useDeleteContext();
  const restoreMutation = useRestoreContext();

  const [mode, setMode] = React.useState<Mode>('read');
  const [confirmDelete, setConfirmDelete] = React.useState(false);
  const [relatedOpen, setRelatedOpen] = React.useState(false);
  const [metaOpen, setMetaOpen] = React.useState(false);

  // Edit-form state (seeded when entering edit mode).
  const [content, setContent] = React.useState('');
  const [tags, setTags] = React.useState('');

  const record = detail.data ?? fallback;

  // Reset transient UI whenever a different context is selected.
  React.useEffect(() => {
    setMode('read');
    setConfirmDelete(false);
    setRelatedOpen(false);
    setMetaOpen(false);
    updateMutation.reset();
    deleteMutation.reset();
    restoreMutation.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const related = useRelatedContexts(id, relatedOpen);

  const enterEdit = React.useCallback(() => {
    if (!record) return;
    setContent(record.content ?? '');
    setTags((record.tags ?? []).join(', '));
    updateMutation.reset();
    setMode('edit');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [record?.id]);

  const save = (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!id) return;
    updateMutation.mutate(
      {
        id,
        updates: {
          content,
          tags: tags
            .split(',')
            .map((t) => t.trim())
            .filter(Boolean),
        },
      },
      { onSuccess: () => setMode('read') },
    );
  };

  const share = (format: ShareFormat) => {
    if (record) void shareContext(record, format);
  };

  const doDelete = () => {
    if (!id) return;
    deleteMutation.mutate(id, {
      onSuccess: () => {
        setConfirmDelete(false);
        setMode('read');
        onDeleted?.();
      },
    });
  };

  /**
   * An ARCHIVED context is still reachable by id — the list hides it, the reader does not
   *, because the reader is where a user discovers they need to un-delete
   * and a permalink to a deleted record should explain itself rather than 404.
   */
  const isArchived = Boolean(record?.archived_at);

  const doRestore = () => {
    if (!id) return;
    restoreMutation.mutate(id);
  };

  const metadata = (record?.metadata ?? {}) as Record<string, unknown>;
  const metaKeys = Object.keys(metadata);

  if (mode === 'edit') {
    return (
      <div className={styles.detail}>
        <div className={styles.reader}>
          <Form className={styles.editForm} onSubmit={save}>
            {updateMutation.isError && (
              <Alert variant="error" title="Couldn't save">
                {apiErrorMessage(updateMutation.error, 'Update failed.')}
              </Alert>
            )}
            <Field label="Content" hint="Markdown">
              <Textarea
                value={content}
                onChange={(e) => setContent(e.target.value)}
                placeholder="Context content (markdown)"
                rows={16}
              />
            </Field>
            <Field label="Tags" hint="Comma-separated">
              <Input
                value={tags}
                onChange={(e) => setTags(e.target.value)}
                placeholder="tag-a, tag-b"
              />
            </Field>
            <div className={styles.editActions}>
              <Button
                variant="subtle"
                onClick={() => setMode('read')}
                disabled={updateMutation.isPending}
              >
                Cancel
              </Button>
              <Button variant="primary" onClick={() => save()} loading={updateMutation.isPending}>
                Save changes
              </Button>
            </div>
          </Form>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.detail}>
      {isArchived && (
        <Alert variant="warning" title="This context is deleted">
          It was soft-deleted, so it is hidden from the list and the counts — but the record
          and its links are intact. Restore puts it back.
          <div className={styles.editActions}>
            <Button
              variant="primary"
              onClick={doRestore}
              loading={restoreMutation.isPending}
            >
              Restore
            </Button>
          </div>
          {restoreMutation.isError && (
            <div>{apiErrorMessage(restoreMutation.error, 'Restore failed.')}</div>
          )}
        </Alert>
      )}

      <ContextReader
        context={record}
        isLoading={Boolean(id) && detail.isLoading && !record}
        isError={detail.isError && !record}
        error={detail.error}
        links={links.data}
        linksLoading={links.isLoading}
        linksError={links.isError}
        linksErrorObj={links.error}
        onEdit={enterEdit}
        onShare={share}
        // An archived context offers RESTORE (the banner above) instead of Delete —
        // deleting it again is a harmless no-op, but the affordance would be a lie about
        // what the record's state is. Same rule as TaskDrawer.
        onDelete={isArchived ? undefined : () => setConfirmDelete(true)}
        sections={
          record ? (
            <>
              <Section
                label="Related"
                count={related.data?.length}
                open={relatedOpen}
                onToggle={() => setRelatedOpen((v) => !v)}
              >
                {related.isLoading ? (
                  <div className={styles.sectionState}>
                    <Spinner size="sm" />
                  </div>
                ) : related.isError ? (
                  <Alert variant="error" title="Couldn't load related contexts">
                    {apiErrorMessage(related.error, 'Request failed.')}
                  </Alert>
                ) : (related.data?.length ?? 0) === 0 ? (
                  <p className={styles.sectionEmpty}>No semantically-related contexts.</p>
                ) : (
                  <div className={styles.relatedList}>
                    {related.data!.map((r) => {
                      const rk = (r as { context_type?: string }).context_type ?? r.type ?? 'context';
                      return (
                        <Link key={r.id} className={styles.relatedRow} to={buildNavHref(r.id)}>
                          <span
                            className={styles.relatedDot}
                            style={{ background: `var(${kindDotVar(rk)})` }}
                            aria-hidden="true"
                          />
                          <span className={styles.relatedTitle}>
                            {(r.content ?? '').split('\n').find((l) => l.trim()) ?? '(untitled)'}
                          </span>
                          <span className={styles.relatedId}>{id8(r.id)}</span>
                        </Link>
                      );
                    })}
                  </div>
                )}
              </Section>

              <Section
                label="Metadata"
                count={metaKeys.length}
                open={metaOpen}
                onToggle={() => setMetaOpen((v) => !v)}
              >
                {metaKeys.length === 0 ? (
                  <p className={styles.sectionEmpty}>No metadata on this context.</p>
                ) : (
                  <dl className={styles.metaList}>
                    {metaKeys.map((k) => (
                      <div key={k} className={styles.metaRow}>
                        <dt className={styles.metaKey}>{k}</dt>
                        <dd className={styles.metaVal}>
                          {typeof metadata[k] === 'string'
                            ? (metadata[k] as string)
                            : JSON.stringify(metadata[k])}
                        </dd>
                      </div>
                    ))}
                  </dl>
                )}
              </Section>
            </>
          ) : null
        }
      />

      <Modal
        open={confirmDelete}
        onClose={() => !deleteMutation.isPending && setConfirmDelete(false)}
        title="Delete context?"
        size="sm"
        footer={
          <div className={styles.editActions}>
            <Button
              variant="subtle"
              onClick={() => setConfirmDelete(false)}
              disabled={deleteMutation.isPending}
            >
              Cancel
            </Button>
            <Button variant="danger" onClick={doDelete} loading={deleteMutation.isPending}>
              Delete
            </Button>
          </div>
        }
      >
        <p className={styles.confirmText}>
          Delete this context? It is removed from memory (soft-deleted) and drops out of the list.
        </p>
        {deleteMutation.isError && (
          <Alert variant="error" title="Couldn't delete the context">
            {apiErrorMessage(deleteMutation.error, 'Delete failed.')}
          </Alert>
        )}
      </Modal>
    </div>
  );
};

export default ContextDetail;
