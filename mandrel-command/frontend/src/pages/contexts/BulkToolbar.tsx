/**
 * BulkToolbar — the actions on a SELECTION of contexts. Rendered by the
 * page only while >=1 row is selected. Four actions, one confirm each where it matters:
 *   - DELETE  → confirm Modal naming the count → api.contexts.bulkDelete (page-scoped).
 *   - TAG     → Modal, comma-separated tags (the same input the reader's edit form uses;
 *               there is no tag-chip input component in this UI) → bulkUpdate. The
 *               endpoint REPLACES the tag list, so "add" is computed here as each row's
 *               existing + new, grouped by outcome — one request per distinct result.
 *   - MOVE    → Modal, project picker from the page's own project list (minus the current
 *               project) → bulkUpdate({ project_id }).
 *   - EXPORT  → in-browser JSON / Markdown of the selected rows (share.ts exportContexts).
 * Owns its mutations like ContextDetail owns the single-record ones; the page owns the
 * selection and is told when rows were deleted so it can deselect the reader.
 */
import React from 'react';
import { Alert, Button, Field, Form, Input, Modal, Select } from '../../components/ui';
import type { ProjectSelectItem } from '../../components/ui/ProjectSelect';
import { BULK_EXPORT_FORMATS, CONTEXTS_CONFIG, type BulkExportFormat } from './config';
import {
  useBulkDeleteContexts,
  useBulkUpdateContexts,
  type BulkUpdateBatch,
  type RequestScope,
} from './hooks';
import { exportContexts } from './share';
import type { Context } from '../../types/context';
import styles from './Contexts.module.css';
import { apiErrorMessage } from '../../api/request';

export interface BulkToolbarProps {
  /** The selected rows (snapshots) — everything here acts on exactly these. */
  selected: ReadonlyMap<string, Context>;
  /** The page's project list, for the move picker. */
  projects: ProjectSelectItem[];
  /** The page's current project — excluded from the move picker (a no-op move). */
  currentProjectId: string | undefined;
  /** `usePageProject().scope` — bulk delete authorizes against the request's project. */
  scope: RequestScope;
  onClear: () => void;
  /** Called with the ids after a successful delete (the page deselects the reader if hit). */
  onDeleted?: (ids: string[]) => void;
}

type Dialog = 'none' | 'delete' | 'tag' | 'move';

/** Parse the comma-separated tag input the way the reader's edit form does. */
export function parseTags(raw: string): string[] {
  return Array.from(new Set(raw.split(',').map((t) => t.trim()).filter(Boolean)));
}

/**
 * Group the selection by the tag list each row would END UP with (existing + added), so the
 * replace-only endpoint can be driven as "add". Rows already carrying every added tag are
 * skipped — nothing to write. Exported for the test.
 */
export function planTagAdd(
  selected: ReadonlyMap<string, Context>,
  add: string[],
): BulkUpdateBatch[] {
  const byOutcome = new Map<string, BulkUpdateBatch>();
  selected.forEach((ctx, id) => {
    const existing = ctx.tags ?? [];
    const tags = Array.from(new Set([...existing, ...add]));
    if (tags.length === existing.length) return; // every added tag was already present
    const key = tags.join(' ');
    const batch = byOutcome.get(key) ?? { ids: [], updates: { tags } };
    batch.ids.push(id);
    byOutcome.set(key, batch);
  });
  return Array.from(byOutcome.values());
}

const noun = (n: number) => (n === 1 ? 'context' : 'contexts');

export const BulkToolbar: React.FC<BulkToolbarProps> = ({
  selected,
  projects,
  currentProjectId,
  scope,
  onClear,
  onDeleted,
}) => {
  const ids = React.useMemo(() => Array.from(selected.keys()), [selected]);
  const rows = React.useMemo(() => Array.from(selected.values()), [selected]);
  const count = ids.length;

  const deleteMutation = useBulkDeleteContexts(scope);
  const updateMutation = useBulkUpdateContexts();

  const [dialog, setDialog] = React.useState<Dialog>('none');
  const [tagInput, setTagInput] = React.useState('');
  const [tagProblem, setTagProblem] = React.useState<string | null>(null);
  const [moveTo, setMoveTo] = React.useState<string | undefined>(undefined);

  const busy = deleteMutation.isPending || updateMutation.isPending;

  const open = (d: Dialog) => {
    deleteMutation.reset();
    updateMutation.reset();
    setTagProblem(null);
    setDialog(d);
  };
  const close = () => {
    if (!busy) setDialog('none');
  };

  // The ONLY path to the bulk delete request: the confirm dialog's Delete button.
  const doDelete = () => {
    deleteMutation.mutate(ids, {
      onSuccess: () => {
        setDialog('none');
        onDeleted?.(ids);
        onClear();
      },
    });
  };

  const doTag = (e?: React.FormEvent) => {
    e?.preventDefault();
    const add = parseTags(tagInput);
    if (add.length === 0) {
      setTagProblem('Enter at least one tag.');
      return;
    }
    const batches = planTagAdd(selected, add);
    const over = batches.find(
      (b) => (b.updates.tags?.length ?? 0) > CONTEXTS_CONFIG.maxTagsPerContext,
    );
    if (over) {
      setTagProblem(
        `${over.ids.length} of the selected contexts would end up with more than ` +
          `${CONTEXTS_CONFIG.maxTagsPerContext} tags. Nothing was changed.`,
      );
      return;
    }
    if (batches.length === 0) {
      // Every selected row already carries every tag — an honest no-op, not a request.
      setDialog('none');
      setTagInput('');
      return;
    }
    updateMutation.mutate(batches, {
      onSuccess: () => {
        setDialog('none');
        setTagInput('');
      },
    });
  };

  const doMove = (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!moveTo) return;
    updateMutation.mutate([{ ids, updates: { project_id: moveTo } }], {
      onSuccess: () => {
        setDialog('none');
        setMoveTo(undefined);
        // The rows now belong to another project and have left this page's list.
        onClear();
      },
    });
  };

  const doExport = (format: BulkExportFormat) => exportContexts(rows, format);

  const moveTargets = projects.filter((p) => p.id !== currentProjectId);

  return (
    <div className={styles.bulkBar} role="toolbar" aria-label="Bulk actions">
      <span className={styles.bulkCount} aria-live="polite">
        {count} selected
      </span>
      <Button size="sm" variant="subtle" onClick={() => open('tag')} disabled={busy}>
        Add tags
      </Button>
      <Button
        size="sm"
        variant="subtle"
        onClick={() => open('move')}
        disabled={busy || moveTargets.length === 0}
        title={moveTargets.length === 0 ? 'No other project to move to' : undefined}
      >
        Move to project
      </Button>
      {BULK_EXPORT_FORMATS.map((f) => (
        <Button key={f.value} size="sm" variant="subtle" onClick={() => doExport(f.value)}>
          {f.label}
        </Button>
      ))}
      <span className={styles.bulkSpacer} />
      <Button size="sm" variant="subtle" onClick={onClear} disabled={busy}>
        Clear
      </Button>
      <Button size="sm" variant="danger" onClick={() => open('delete')} disabled={busy}>
        Delete
      </Button>

      <Modal
        open={dialog === 'delete'}
        onClose={close}
        title={`Delete ${count} ${noun(count)}?`}
        size="sm"
        footer={
          <div className={styles.editActions}>
            <Button variant="subtle" onClick={close} disabled={deleteMutation.isPending}>
              Cancel
            </Button>
            <Button variant="danger" onClick={doDelete} loading={deleteMutation.isPending}>
              Delete {count}
            </Button>
          </div>
        }
      >
        <p className={styles.confirmText}>
          Delete {count} selected {noun(count)}? They are removed from memory (soft-deleted)
          and drop out of the list; each can be restored from its reader.
        </p>
        {deleteMutation.isError && (
          <Alert variant="error" title="Couldn't delete the contexts">
            {apiErrorMessage(deleteMutation.error, 'Bulk delete failed.')}
          </Alert>
        )}
      </Modal>

      <Modal
        open={dialog === 'tag'}
        onClose={close}
        title={`Add tags to ${count} ${noun(count)}`}
        size="sm"
        footer={
          <div className={styles.editActions}>
            <Button variant="subtle" onClick={close} disabled={updateMutation.isPending}>
              Cancel
            </Button>
            <Button variant="primary" onClick={() => doTag()} loading={updateMutation.isPending}>
              Add tags
            </Button>
          </div>
        }
      >
        <Form className={styles.bulkForm} onSubmit={doTag}>
          <Field label="Tags" hint="Comma-separated; added to each context's existing tags">
            <Input
              value={tagInput}
              onChange={(e) => {
                setTagInput(e.target.value);
                setTagProblem(null);
              }}
              placeholder="tag-a, tag-b"
              aria-label="Tags to add"
            />
          </Field>
          {tagProblem && (
            <Alert variant="warning" title="Nothing sent">
              {tagProblem}
            </Alert>
          )}
          {updateMutation.isError && (
            <Alert variant="error" title="Couldn't tag the contexts">
              {apiErrorMessage(updateMutation.error, 'Bulk tag failed.')}
            </Alert>
          )}
        </Form>
      </Modal>

      <Modal
        open={dialog === 'move'}
        onClose={close}
        title={`Move ${count} ${noun(count)} to another project`}
        size="sm"
        footer={
          <div className={styles.editActions}>
            <Button variant="subtle" onClick={close} disabled={updateMutation.isPending}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={() => doMove()}
              disabled={!moveTo}
              loading={updateMutation.isPending}
            >
              Move
            </Button>
          </div>
        }
      >
        <Form className={styles.bulkForm} onSubmit={doMove}>
          <Field label="Project">
            <Select
              options={moveTargets.map((p) => ({ value: p.id, label: p.name }))}
              value={moveTo}
              onChange={setMoveTo}
              placeholder="Pick a project"
              aria-label="Move to project"
              searchable={moveTargets.length > 8}
            />
          </Field>
          {updateMutation.isError && (
            <Alert variant="error" title="Couldn't move the contexts">
              {apiErrorMessage(updateMutation.error, 'Bulk move failed.')}
            </Alert>
          )}
        </Form>
      </Modal>
    </div>
  );
};

export default BulkToolbar;
