/**
 * ContextReader — the context DETAIL: the RIGHT COLUMN of the rail+reader screen (the
 * ContextDetail container owns its data + actions). A header (kind badge, actor chip when
 * present, id link + relative time + project, a copyable ref-handle chip when the context
 * carries a `ref:<slug>`, plus the action cluster — copy-id, share/export, edit, delete), a
 * rendered markdown/code body (the shared sanitized MarkdownContent), and a footer with the
 * tag row + the typed-edge ThreadBox (the moat). Owns its loading / empty / error state.
 *
 * Actions are OPTIONAL props: the header only renders share/delete when the caller wires a
 * handler, so the same component works read-only or fully-actioned. `sections` is an
 * optional slot rendered after the thread box (the container fills it with the collapsible
 * Related / Metadata sections) so the whole detail reads as ONE reader card — the same
 * shape the Decisions reader has.
 *
 * ACTOR NOTE: the contexts read model does not currently serialise an `actor` (no such
 * column/metadata — verified). The chip renders ONLY when an actor is present, so it is
 * gracefully omitted today rather than faked (data-gap policy 10397f65).
 */
import React from 'react';
import { Link } from 'react-router-dom';
import { Badge, Spinner, Empty, Alert, cx } from '../../components/ui';
import MarkdownContent from '../../components/common/MarkdownContent';
import { CopyIcon, CheckIcon, EditIcon, TrashIcon, LinkIcon } from './icons';
import { ShareMenu } from './ShareMenu';
import { ThreadBox } from './ThreadBox';
import { kindTone, type ShareFormat } from './config';
import { formatRelative, id8 } from './parts';
import { findRefTag } from '../../utils/refHelpers';
import { buildNavHref } from '../../utils/navIdLinkify';
import type { Context, ContextLink } from '../../types/context';
import styles from './Contexts.module.css';
import { apiErrorMessage } from '../../api/request';

/** A context may carry an `actor` if a future read model serialises it (omitted if not). */
type ReaderContext = Context & { actor?: string | null; context_type?: string };

export interface ContextReaderProps {
  context: Context | undefined;
  isLoading: boolean;
  isError: boolean;
  error: unknown;
  links: ContextLink[] | undefined;
  linksLoading: boolean;
  linksError: boolean;
  linksErrorObj: unknown;
  onEdit: (ctx: Context) => void;
  /** Wire to show the Export/Share menu (client-side md/text/json). Omitted → hidden. */
  onShare?: (format: ShareFormat) => void;
  /** Wire to show the Delete (danger) action. Omitted → hidden. */
  onDelete?: (ctx: Context) => void;
  /** Optional slot rendered inside the footer, after the thread box (Related / Metadata). */
  sections?: React.ReactNode;
}

/** A tiny copy-to-clipboard icon button (copies `value`, flashes a check). */
const CopyButton: React.FC<{ value: string; title: string; label: string; refChip?: boolean }> = ({
  value,
  title,
  label,
  refChip,
}) => {
  const [copied, setCopied] = React.useState(false);
  const copy = React.useCallback(() => {
    void navigator.clipboard?.writeText(value).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    });
  }, [value]);
  return (
    <button
      type="button"
      className={styles.ricon}
      title={copied ? 'Copied' : title}
      aria-label={label}
      onClick={copy}
    >
      {copied ? <CheckIcon size={15} /> : refChip ? <LinkIcon size={15} /> : <CopyIcon size={15} />}
    </button>
  );
};

export const ContextReader: React.FC<ContextReaderProps> = ({
  context,
  isLoading,
  isError,
  error,
  links,
  linksLoading,
  linksError,
  linksErrorObj,
  onEdit,
  onShare,
  onDelete,
  sections,
}) => {


  if (isLoading) {
    return (
      <div className={cx(styles.reader, styles.readerState)}>
        <Spinner size="lg" />
      </div>
    );
  }
  if (isError) {
    return (
      <div className={cx(styles.reader, styles.readerState)}>
        <Alert variant="error" title="Couldn't load this context">
          {apiErrorMessage(error, 'Failed to load the context.')}
        </Alert>
      </div>
    );
  }
  if (!context) {
    return (
      <div className={cx(styles.reader, styles.readerState)}>
        <Empty title="Select a context" description="Choose a context from the list to read it." />
      </div>
    );
  }

  const ctx = context as ReaderContext;
  const kind = ctx.context_type ?? ctx.type ?? 'context';
  const actor = ctx.actor;
  const tags = ctx.tags ?? [];
  const refTag = findRefTag(tags);

  return (
    <div className={styles.reader}>
      <div className={styles.rhead}>
        <Badge variant={kindTone(kind)}>{kind}</Badge>
        {actor && (
          <span className={styles.actorChip}>
            <span className={styles.actorDot} aria-hidden="true" />
            {actor}
          </span>
        )}
        <span className={styles.rmeta}>
          <Link className={styles.idlink} to={buildNavHref(ctx.id)}>
            {id8(ctx.id)}
          </Link>
          <span>· {formatRelative(ctx.created_at)}</span>
          {ctx.project_name && <span>· {ctx.project_name}</span>}
          <CopyButton value={ctx.id} title="Copy id" label="Copy id" />
          {refTag && (
            <CopyButton
              value={refTag}
              title={`Copy ref handle: ${refTag}`}
              label="Copy ref handle"
              refChip
            />
          )}
          {onShare && <ShareMenu onShare={onShare} />}
          <button
            type="button"
            className={styles.ricon}
            title="Edit"
            aria-label="Edit context"
            onClick={() => onEdit(context)}
          >
            <EditIcon size={15} />
          </button>
          {onDelete && (
            <button
              type="button"
              className={cx(styles.ricon, styles.riconDanger)}
              title="Delete"
              aria-label="Delete context"
              onClick={() => onDelete(context)}
            >
              <TrashIcon size={15} />
            </button>
          )}
        </span>
      </div>

      <MarkdownContent content={ctx.content} className={styles.readerBody} />

      <div className={styles.rfoot}>
        {tags.length > 0 && (
          <div className={styles.tagRow}>
            {tags.map((t) => (
              <span key={t} className={cx(styles.tag, t.startsWith('ref:') && styles.tagRef)}>
                {t}
              </span>
            ))}
          </div>
        )}
        <ThreadBox
          links={links}
          isLoading={linksLoading}
          isError={linksError}
          error={linksErrorObj}
        />
        {sections}
      </div>
    </div>
  );
};

export default ContextReader;
