/**
 * Client-side Export/Share for a single context — ported from the OLD UI's share
 * dropdown (handleContextShare). Every format is built IN-BROWSER from the already-loaded
 * record; there is NO backend/endpoint call (dependency-free, matches the old behavior).
 *   - `markdown` → a formatted `.md` file download
 *   - `text`     → the raw content copied to the clipboard
 *   - `json`     → a `.json` export file download
 */
import type { Context } from '../../types/context';
import type { BulkExportFormat, ShareFormat } from './config';

type ShareContext = Context & { context_type?: string };

function kindOf(ctx: ShareContext): string {
  return ctx.context_type ?? ctx.type ?? 'context';
}

function tagsLine(ctx: Context): string {
  return ctx.tags && ctx.tags.length > 0 ? ctx.tags.join(', ') : 'None';
}

/** The Markdown document for a context (front-matter-ish header + body). */
export function buildMarkdown(ctx: ShareContext): string {
  const lines = [
    `# Context ${ctx.id}`,
    '',
    `**Type**: ${kindOf(ctx)}`,
    `**Created**: ${ctx.created_at ?? 'unknown'}`,
    ctx.project_name ? `**Project**: ${ctx.project_name}` : undefined,
    `**Tags**: ${tagsLine(ctx)}`,
    '',
    '---',
    '',
    ctx.content ?? '',
  ].filter((l) => l !== undefined);
  return lines.join('\n');
}

/** The JSON export record for a context (shared by the single and the bulk export). */
function jsonRecord(ctx: ShareContext, exportedAt: string): Record<string, unknown> {
  return {
    id: ctx.id,
    type: kindOf(ctx),
    project: ctx.project_name ?? ctx.project_id ?? null,
    created_at: ctx.created_at ?? null,
    tags: ctx.tags ?? [],
    content: ctx.content ?? '',
    metadata: ctx.metadata ?? {},
    export_timestamp: exportedAt,
  };
}

/** The JSON export payload for a context. */
export function buildJson(ctx: ShareContext): string {
  return JSON.stringify(jsonRecord(ctx, new Date().toISOString()), null, 2);
}

/** The JSON export payload for a SELECTION of contexts: an array of the single-record shape. */
export function buildBulkJson(ctxs: Context[]): string {
  const exportedAt = new Date().toISOString();
  return JSON.stringify(
    ctxs.map((c) => jsonRecord(c as ShareContext, exportedAt)),
    null,
    2,
  );
}

/** The Markdown document for a SELECTION of contexts: each record's document, rule-separated. */
export function buildBulkMarkdown(ctxs: Context[]): string {
  return ctxs.map((c) => buildMarkdown(c as ShareContext)).join('\n\n---\n\n');
}

/** Trigger a browser download of `text` as `filename` with the given MIME type. */
export function triggerDownload(filename: string, text: string, mime: string): void {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** Copy `text` to the clipboard (best-effort — returns the clipboard promise). */
export function copyToClipboard(text: string): Promise<void> {
  return navigator.clipboard?.writeText(text) ?? Promise.resolve();
}

/**
 * Run a share/export for a context in the requested format. Returns a promise that
 * resolves once the action is dispatched (download started or clipboard written).
 */
export function shareContext(ctx: Context, format: ShareFormat): Promise<void> {
  const c = ctx as ShareContext;
  const stub = c.id.slice(0, 8);
  switch (format) {
    case 'markdown':
      triggerDownload(`context-${stub}.md`, buildMarkdown(c), 'text/markdown;charset=utf-8');
      return Promise.resolve();
    case 'json':
      triggerDownload(`context-${stub}.json`, buildJson(c), 'application/json;charset=utf-8');
      return Promise.resolve();
    case 'text':
    default:
      return copyToClipboard(c.content ?? '');
  }
}

/**
 * Bulk export for a selection — built in-browser from the already-loaded
 * rows, like `shareContext`. This deliberately does NOT call `api.contexts.export`: that
 * endpoint (backend controllers/context.ts exportContexts) selects by search filter —
 * query/type/tags/dates — and has no `ids` parameter, so it cannot export "these N rows".
 * Filename carries the row count so two exports of different selections do not collide.
 */
export function exportContexts(ctxs: Context[], format: BulkExportFormat): void {
  const stem = `contexts-${ctxs.length}`;
  if (format === 'markdown') {
    triggerDownload(`${stem}.md`, buildBulkMarkdown(ctxs), 'text/markdown;charset=utf-8');
    return;
  }
  triggerDownload(`${stem}.json`, buildBulkJson(ctxs), 'application/json;charset=utf-8');
}
