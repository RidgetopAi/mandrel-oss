/**
 * MCP Response Formatter
 * Standardizes response format across all MCP tools
 */

import { actionableErrorText } from './actionableError.js';
import { declaredFaultStatus, type HttpErrorStatus } from './mcpErrorStatus.js';

export interface McpResponse {
  content: Array<{
    type: 'text' | 'resource';
    text?: string;
    resource?: string;
  }>;
  isError?: boolean;
  /**
   * THE TRANSPORT CLASSIFICATION OF A REFUSAL. Set by `formatMcpError`, and
   * ONLY when the underlying error declared one (a `MandrelClassifiedError` — the binding
   * gate, the identity guards, the actor requirement). Read by the ONE status authority,
   * `httpStatusForToolOutcome`.
   *
   * ABSENT IS THE NORMAL CASE and means `200 + isError` — the ordinary MCP tool error, where
   * the tool RAN and answered "not found". Present means the tool NEVER RAN: the call was
   * refused at a gate before dispatch, nothing was read or written, and an identical retry is
   * refused identically. That distinction is the whole reason this field exists; it is not a
   * severity, it is "did the call happen".
   *
   * Why it is declared here rather than hidden: see the "HOW THE CLASSIFICATION CROSSES THE
   * IN-BAND SEAM" note in utils/mcpErrorStatus.ts. A non-enumerable stamp was built first and
   * was silently erased by `{ ...resp }` in ensureStructuredContent — failing OPEN, back to
   * 200. A declared field survives a spread and shows up in the type.
   */
  transportStatus?: HttpErrorStatus;
  /**
   * Legacy structured-data sibling for API consumers. Kept for back-compat; the
   * dual-channel seam (routes/index.ts) promotes it to `structuredContent` when a
   * handler set it. Prefer setting `structuredContent` directly in new code.
   */
  data?: any;
  /**
   * MCP DUAL-CHANNEL OUTPUT: the machine-readable JSON object that
   * conforms to the tool's declared `outputSchema`. RAW field values only — NEVER
   * marked-up text (that is the root-cause fix for the markdown-in-values class).
   * Every tool emits one; the seam in routes/index.ts guarantees it's present.
   */
  structuredContent?: Record<string, any>;
}

/**
 * THE ONE predicate for "this tool result is a FAILURE".
 *
 * `isError` is AUTHORITATIVE, and `structuredContent.ok` is NOT a second opinion — it is
 * DERIVED from this flag (routes/index.ts ensureStructuredContent: `const ok = !isErrorResult(resp)`),
 * and only when the handler left `ok` unset. Two reasons `ok` cannot be the predicate:
 *   1. it is not always PRESENT — the gateway's own rejections return `formatMcpError(...)`
 *      directly (routes/gateway.ts:75, :98, :116) without passing through routeExecutor, so
 *      they carry `isError: true` and NO structuredContent at all. Keying on `ok === false`
 *      would read those as successes.
 *   2. where both exist and a handler pre-set `ok`, the handler's value wins over the stamp,
 *      so `ok` can disagree with `isError`. `isError` is the flag every producer sets
 *      (formatMcpError, idErrorResponse, flatRejectionError) and the flag the MCP protocol
 *      itself defines for a tool error; `ok` is the machine-channel mirror of it.
 *
 * Defined here, next to `McpResponse`, so the HTTP envelope and the dual-channel seam cannot
 * drift into two different answers to the same question.
 */
export function isErrorResult(resp: unknown): boolean {
  return (resp as McpResponse | null | undefined)?.isError === true;
}

/**
 * Strip lightweight markdown emphasis from a RAW value so structuredContent never
 * carries presentation markup (the markdown-in-values root-cause fix). Conservative:
 * only removes `**bold**`/`__bold__`/`*italic*`/`_italic_` wrappers and backticks;
 * leaves all other characters intact. Non-strings pass through unchanged.
 */
export function rawValue<T>(value: T): T {
  if (typeof value !== 'string') return value;
  return value
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/`(.+?)`/g, '$1') as unknown as T;
}

export interface FormatOptions {
  emoji?: string;
  includeDetails?: boolean;
  detailFormatter?: (data: any) => string;
}

/**
 * Format successful MCP response with data
 */
export function formatMcpResponse(
  result: any,
  successMessage: string,
  options?: FormatOptions
): McpResponse {
  const emoji = options?.emoji || '✅';
  const includeDetails = options?.includeDetails ?? true;

  let text = `${emoji} ${successMessage}\n`;

  if (includeDetails && result) {
    if (options?.detailFormatter) {
      text += '\n' + options.detailFormatter(result);
    } else {
      text += '\n' + formatDefaultDetails(result);
    }
  }

  return {
    content: [{ type: 'text', text }]
  };
}

/**
 * Format error MCP response
 */
export function formatMcpError(
  error: Error | string,
  context?: string
): McpResponse {
  const rawMessage = typeof error === 'string' ? error : error.message;
  // SECURE + ACTIONABLE: this is the central handler/route
  // error seam. Sanitize the raw message so a leaky handler error can NEVER expose SQL,
  // stack frames, connection strings, secret values, or internal paths to the model;
  // an already-actionable validator message (Validation failed for …) passes through
  // intact. The hand-built not-found messages (e.g. decision_get) are richer and live
  // handler-side; this is the safe central fallback for everything else.
  const message = actionableErrorText(rawMessage);
  const contextStr = context ? `\n\nContext: ${context}` : '';

  const result: McpResponse = {
    content: [{
      type: 'text',
      text: `❌ Error: ${message}${contextStr}`
    }],
    isError: true
  };

  // CARRY THE TRANSPORT CLASSIFICATION ACROSS THE IN-BAND SEAM.
  //
  // This is the ONE place a thrown error becomes a tool result, and it is exactly where the
  // information used to be destroyed: `routeExecutorInner` catches a policy refusal, calls
  // this, and returns the result — so by the time the HTTP layer saw it, the only thing left
  // of "this was a refusal, whose fault it was, and that it is not retryable" was PROSE. The
  // HTTP layer then hardcoded 200, and every refused write was reported to the transport as
  // a completed one (measured; see utils/mcpErrorStatus.ts Part 2 for the four cases).
  //
  // Deriving it back out of the text was the alternative and it is the thing C3 forbids: a
  // verdict is never read out of a message. So the status the error DECLARED at construction
  // rides along on the result instead. An error that declared nothing sets nothing and stays a
  // plain `200 + isError` MCP tool error, which is what an ordinary tool failure should be.
  const declared = declaredFaultStatus(error);
  if (declared !== undefined) result.transportStatus = declared;
  return result;
}

/**
 * Default detail formatter
 */
function formatDefaultDetails(data: any): string {
  if (typeof data === 'string') return data;
  if (typeof data === 'number' || typeof data === 'boolean') return String(data);

  // Format object properties
  const lines: string[] = [];
  for (const [key, value] of Object.entries(data)) {
    if (value !== null && value !== undefined) {
      const label = key.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
      lines.push(`${label}: ${formatValue(value)}`);
    }
  }
  return lines.join('\n');
}

function formatValue(value: any): string {
  if (Array.isArray(value)) return `[${value.length} items]`;
  if (typeof value === 'object') return JSON.stringify(value, null, 2);
  return String(value);
}
