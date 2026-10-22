/**
 * JSON-RPC error code → HTTP status classification, and — since
 * an earlier task added Part 2 below — THE single point at which a tool call's HTTP status is
 * decided at all.
 *
 * ENTRY POINT: `httpStatusForToolOutcome`, at the bottom of this file. `httpStatusForError`
 * documented here in Part 1 is still exported and still correct, but it now answers only the
 * THREW half of the question; calling it directly gets you a status for an exception and
 * silently no opinion about the far more common case, a refusal returned IN BAND. Part 2
 * explains why that half existed unclassified for so long.
 *
 * THE DEFECT THIS FIXES
 *   `POST /mcp/tools/task_update` with ONE undeclared param returned **HTTP 500** carrying
 *   `MCP error -32602: … Unknown parameter(s): 'notes'. This tool rejects undeclared params
 *   (strict mode)`. `-32602` is literally JSON-RPC "Invalid params" — an unambiguous CLIENT
 *   error reported as a SERVER error. That is not cosmetic:
 *
 *     1. Every well-behaved HTTP client treats 5xx as RETRYABLE and 4xx as TERMINAL. A 500
 *        tells an SDK with retry/backoff to try again — forever — for a request that can
 *        never succeed. Our clients are AGENTS across 7 tenant containers: exactly the kind
 *        that retry automatically. The customer sees a Mandrel outage; we get self-inflicted
 *        load.
 *     2. It poisons our own alerting. 5xx rate IS the incident signal; client mistakes
 *        inflating it is how a real incident hides in the noise.
 *
 *   This is a RECURRENCE, not a one-off: contextStoreLongContent.contract.test.ts already
 *   documents the same shape on the content-storage path ("catches the thrown validation
 *   error → res.status(500)"). Both are the SAME thrown-validation-error-becomes-5xx class,
 *   so the fix lives in ONE place that every tool call funnels through rather than N call
 *   sites (fix the class, not the instance).
 *
 * WHAT IS DELIBERATELY *NOT* CHANGED
 *   The error MESSAGE and strict-mode validation are excellent and fail closed — untouched.
 *   This module only classifies an ALREADY-THROWN error into a transport status.
 *
 * FAIL CLOSED — THE LOAD-BEARING PROPERTY
 *   An UNRECOGNISED error is 500. Not 200, not 400. Absent / zero / empty / NaN / a
 *   non-numeric `code` (a Postgres error's `code` is the string '23505'; a Node syscall
 *   error's is 'ECONNREFUSED') all fall to 500, because the ONLY thing that earns a 4xx is
 *   an EXPLICIT entry in the table below. Silently downgrading an unknown fault to a 4xx
 *   would hide a real incident from the same 5xx alerting this fix exists to protect —
 *   strictly worse than the bug. Zero/empty/absent are the values that historically slip
 *   through a guard (a past incident rule 7), so they are asserted directly in
 *   mcpErrorStatus.contract.test.ts.
 *
 * COMPILER OVER TEST (two structural guarantees, neither of which a test can drift from)
 *   1. EXHAUSTIVENESS. The table is typed `Record<ErrorCode, HttpErrorStatus>` over the MCP
 *      SDK's own `ErrorCode` enum. If the SDK adds a code and we do not classify it, this
 *      file FAILS TO COMPILE. A code cannot be silently forgotten.
 *   2. NO ACCIDENTAL SUCCESS. The value type is `HttpErrorStatus` — a union of ERROR statuses
 *      only. Mapping a code to `200`/`0`/`204` does not compile, so the "silently swallow a
 *      real fault as a success" failure mode is structurally unreachable rather than
 *      guarded by a reviewable convention.
 *
 * WHY THIS IS NOT ENV-CONFIGURABLE (configs-not-hardcoded, read correctly)
 *   That standing rule targets TUNABLES — timeouts, limits, header names, feature flags.
 *   This is a PROTOCOL mapping fixed by the JSON-RPC 2.0 and HTTP specs, not a knob: there
 *   is no deployment for which `-32602` is legitimately a server fault. Making it settable
 *   would add exactly one thing — a way to misconfigure prod back into this incident.
 */

import { ErrorCode } from '@modelcontextprotocol/sdk/types.js';

/**
 * HTTP statuses this module is allowed to emit: 4xx/5xx only, never a success code.
 * Guarantee #2 above — mapping a JSON-RPC code to a 2xx is a COMPILE error, so a real
 * fault can never be silently swallowed as a success by a future edit to the table.
 */
export type HttpErrorStatus = 400 | 403 | 404 | 409 | 500;

/**
 * THE STATUSES A POLICY REFUSAL MAY CARRY — 4xx only, by type.
 *
 * A policy refusal is a statement about the CALLER: it named a project that does not
 * exist, it presented no connection identity, it contradicted its own binding. The
 * server is healthy and the answer is stable, so 5xx is not merely unhelpful here — it
 * is false, and it tells a retrying client to retry something that can never succeed.
 * Excluding 500 from this union is what makes "a policy refusal reported as a server
 * fault" a COMPILE error rather than a convention.
 *
 * A server-side MISCONFIGURATION is a different animal and is deliberately NOT in this
 * union: see ProjectBindingUnresolvedError, which picks its status from the binding's
 * ORIGIN (a client header → 400; this host's own env var → 500, because the operator
 * broke it and it should page).
 */
export type PolicyRefusalStatus = 400 | 403 | 404 | 409;

/** The fail-closed default for anything not explicitly classified below. */
export const UNCLASSIFIED_ERROR_STATUS: HttpErrorStatus = 500;

/**
 * The classification table. EXHAUSTIVE over the SDK's `ErrorCode` by type (guarantee #1):
 * a code added to the SDK enum breaks the build here until it is classified.
 *
 * CLIENT ERRORS (4xx — terminal, do NOT retry: the same request can never succeed):
 *   -32700 ParseError    the client sent malformed JSON
 *   -32600 InvalidRequest  the client sent a structurally invalid request
 *   -32602 InvalidParams   the client sent bad/undeclared params  ← THE reported defect
 *   -32601 MethodNotFound  → 404, the resource-shaped client error
 *
 * SERVER FAULTS (5xx — retry is legitimate, and these are the ones that SHOULD move our
 * incident signal):
 *   -32603 InternalError   a genuine internal fault
 *   -32000 ConnectionClosed / -32001 RequestTimeout — server-side transport conditions,
 *          not something the caller got wrong.
 *   -32042 UrlElicitationRequired — deliberately 500. Mandrel never emits it (verified by
 *          grep across src/), so classifying it as a client error would be a claim about
 *          semantics we have not exercised. Unexercised ⇒ fail closed.
 */
const STATUS_BY_JSONRPC_CODE: Readonly<Record<ErrorCode, HttpErrorStatus>> = {
  [ErrorCode.ParseError]: 400,
  [ErrorCode.InvalidRequest]: 400,
  [ErrorCode.InvalidParams]: 400,
  [ErrorCode.MethodNotFound]: 404,
  [ErrorCode.InternalError]: 500,
  [ErrorCode.ConnectionClosed]: 500,
  [ErrorCode.RequestTimeout]: 500,
  [ErrorCode.UrlElicitationRequired]: 500,
};

/**
 * Classify a thrown error into the HTTP status the transport should report.
 *
 * Duck-typed on a numeric `code` rather than `instanceof McpError` on purpose: the error
 * may cross module/realm boundaries (bundled vs hoisted SDK copy), where `instanceof` is
 * unreliable — and the check is still fail-closed either way, because a numeric code only
 * earns a 4xx when it has an EXPLICIT entry in the table.
 *
 * @returns 400/404 for a classified client error; 500 for everything else.
 */
export function httpStatusForError(error: unknown): HttpErrorStatus {
  // A CLASSIFIED error declared its own status at construction time (MandrelClassifiedError,
  // Part 2 below). Read first, and read the realm-safe stamp rather than `instanceof`. This
  // is the branch that fixes the string-code fall-through: 'PROJECT_BINDING_MISMATCH' is not
  // a number and never will be, so no amount of widening the numeric table below could have
  // classified it — the status has to be declared, not inferred from the code.
  const declared = stampedStatus(error);
  if (declared !== undefined) return declared;

  const code: unknown = (error as { code?: unknown } | null | undefined)?.code;
  // Absent / null / string ('23505', 'ECONNREFUSED') / NaN / Infinity → unclassified → 500.
  if (typeof code !== 'number' || !Number.isFinite(code)) return UNCLASSIFIED_ERROR_STATUS;
  // hasOwnProperty (not `in`, not `?? default`) so a prototype-chain name can never resolve
  // to a status, and so `0` — the classic value that slips through a falsy check — misses
  // the table and takes the fail-closed default like any other unknown code.
  if (!Object.prototype.hasOwnProperty.call(STATUS_BY_JSONRPC_CODE, code)) {
    return UNCLASSIFIED_ERROR_STATUS;
  }
  return STATUS_BY_JSONRPC_CODE[code as ErrorCode];
}

/** Exposed for the contract test to enumerate the table without re-stating it (no second copy). */
export const CLASSIFIED_JSONRPC_CODES: readonly number[] =
  Object.keys(STATUS_BY_JSONRPC_CODE).map(Number);

/* ══════════════════════════════════════════════════════════════════════════════════════
 * PART 2 — THE POLICY-REFUSAL HALF (the deferred half of an earlier decision).
 *
 * WHAT WAS MEASURED, AND HOW IT DIFFERS FROM WHAT WAS EXPECTED
 *   The task was written expecting policy refusals to reach the caller as HTTP 500, via
 *   the `typeof code !== 'number'` fall-through above (our policy errors carry STRING
 *   codes: 'PROJECT_BINDING_MISMATCH', 'PROJECT_AMBIENT_WRITE_UNIDENTIFIED'). Driven at
 *   the real HTTP surface, that is NOT what happens, because those errors never reach the
 *   express catch at all: `routeExecutorInner` catches everything it throws and returns
 *   `formatMcpError(...)` IN BAND. Measured on the real express app + real executor:
 *
 *     PROJECT_AMBIENT_WRITE_UNIDENTIFIED   → HTTP 200
 *     PROJECT_SCOPE_SWITCH_UNIDENTIFIED    → HTTP 200
 *     PROJECT_BINDING_UNRESOLVED           → HTTP 200
 *     the actor-requirement rejection      → HTTP 200
 *
 *   So the lie ran the OTHER way, and it is the worse direction: a refusal to write was
 *   reported to the transport as a SUCCESS. Every proxy, load balancer, status-code
 *   dashboard and `res.ok` check in the path read a refused write as a completed one, and
 *   our 4xx rate showed zero policy rejections while the guards were rejecting constantly.
 *   The string-vs-number code split is real and is fixed below — it just was not the
 *   mechanism, because nothing was reading those codes in the first place.
 *
 * THE TWO AUTHORITIES, AND WHY THERE IS NOW ONE
 *   `handleMcpToolExpress` had two independent answers to "what status is this?": the
 *   in-band branch hardcoded 200, and the catch called `httpStatusForError`. They did not
 *   merely COULD-disagree, they DID: an McpError -32602 raised by flat validation escapes
 *   to the catch and is classified 400, while the same -32602 raised on the GATEWAY path is
 *   caught by dispatchGateway and returned in band as 200. One client mistake, two answers,
 *   decided by which surface the client happened to use.
 *
 *   `httpStatusForToolOutcome` below is now the ONE function both branches call. It takes
 *   the tool call's outcome — it RETURNED something, or it THREW — and answers once.
 *
 * WHY 200 IS STILL THE ANSWER FOR AN ORDINARY IN-BAND TOOL ERROR (this is the part that is
 * a real distinction and not a hedge)
 *   Under MCP, a tool that runs and reports a failure is a SUCCESSFUL protocol call whose
 *   result carries `isError: true`. "Context not found: deadbeef" is a well-formed answer
 *   to a well-formed question. A POLICY REFUSAL is categorically different: the tool never
 *   ran. The call was refused at the binding/identity gate before dispatch, nothing was
 *   read, nothing was written, and the caller must change something before retrying. That
 *   is what a 4xx means. The classification therefore keys on WHETHER THE TOOL RAN, not on
 *   whether the response says something sad.
 *
 * WHY THE BODY IS UNCHANGED
 *   Only the STATUS moves. The body of a refusal is still `{ success:false, result:<the
 *   full CallToolResult> }`, byte for byte, so every consumer that keys on the PAYLOAD —
 *   which is what both stdio bridges do (`if (response.result !== undefined)`), and what
 *   an earlier decision taught them to do — is completely unaffected. See
 *   httpEnvelopeBridgeConsumers.contract.test.ts.
 *
 * HOW THE CLASSIFICATION CROSSES THE IN-BAND SEAM, AND THE ONE THAT DID NOT WORK
 *   It rides on the result as a DECLARED, ordinary field: `McpResponse.transportStatus`.
 *
 *   The first attempt was a non-enumerable property, on the reasoning that this is metadata
 *   about the result rather than part of it and should not touch the wire. It was built and
 *   measured, and it silently did nothing: `routes/index.ts ensureStructuredContent` returns
 *   `{ ...resp, structuredContent }`, and a spread copies only ENUMERABLE own properties. All
 *   four refusals still measured 200 — and note HOW they failed. A dropped classification
 *   falls back to 200, so the mechanism failed OPEN, invisibly, at a copy site nobody would
 *   think to look at. Re-stamping there would have fixed that one call site and left the next
 *   author's copy to fail the same way, which is precisely the "runtime rule a future edit can
 *   forget" this task was told not to build.
 *
 *   A declared field cannot be lost that way: a spread carries it, the type carries it into
 *   every reader's editor, and losing it requires deliberately deleting it. The cost is one
 *   optional key on the wire, present ONLY on a classified refusal — an ordinary success and
 *   an ordinary tool error are byte-identical to before. That cost is worth paying twice over,
 *   because the field is also the MACHINE CHANNEL for the refusal: a client learns "refused,
 *   your fault, terminal" without parsing prose, which is the same argument that justifies the
 *   `code` field on these errors. Deriving the verdict back out of the message text was the
 *   real alternative, and reading a verdict out of prose is what C3 forbids.
 * ══════════════════════════════════════════════════════════════════════════════════════ */

/**
 * The realm-safe carrier for a classified error's status.
 *
 * `Symbol.for` (the GLOBAL registry) rather than a fresh `Symbol()` or an `instanceof`
 * check, for the same reason the numeric classification above is duck-typed: an error can
 * cross a module/realm boundary (a bundled vs hoisted copy of this module, a worker, a
 * vitest module graph), where `instanceof` silently returns false and the error would take
 * the fail-closed 500 path while LOOKING correctly classified. A global-registry symbol is
 * the same symbol in every realm.
 */
export const MANDREL_FAULT_STATUS: unique symbol = Symbol.for('mandrel.transport.faultStatus');

/**
 * THE BASE EVERY POLICY / CLASSIFIED ERROR EXTENDS — the type-level half of this fix.
 *
 * The bad state we are eliminating is "an error whose `code` is a string, so the classifier
 * cannot recognise it, so it falls to 500". A runtime check that a future error type must
 * remember to satisfy would leave that state representable. This does not: the status is a
 * REQUIRED CONSTRUCTOR ARGUMENT, so a subclass cannot be written — cannot be compiled —
 * without declaring whose fault its refusal is. And `HttpErrorStatus` excludes every 2xx, so
 * "classified as a success" is not expressible either.
 *
 * Note what this makes irrelevant: the string `code` field on ProjectBindingError and
 * CallerIdentityError is UNCHANGED and stays a string. It is a machine-readable code for
 * CALLERS to branch on; it was never the transport's classification key, and after this
 * change it is not asked to be one.
 */
export abstract class MandrelClassifiedError extends Error {
  /** The status the transport must report for this error. Also stamped for realm safety. */
  readonly faultStatus: HttpErrorStatus;

  constructor(message: string, faultStatus: HttpErrorStatus) {
    super(message);
    this.faultStatus = faultStatus;
    // Non-enumerable so it never appears in a JSON serialisation of the error object.
    Object.defineProperty(this, MANDREL_FAULT_STATUS, {
      value: faultStatus,
      enumerable: false,
      writable: false,
      configurable: false,
    });
  }
}

/**
 * Is this value usable as an HTTP error status?
 *
 * `typeof x === 'number'` is NOT enough and this is not hypothetical — it was caught by
 * §4 of policyRefusalStatus.contract.test.ts while the check was that loose: `NaN` is a
 * number, and `res.status(NaN)` is a broken response for what may well be a routine
 * refusal. Same family as the `0` / `''` / `NaN` cases the numeric table above already
 * defends against, so it is defended the same way: an integer, in the error range, or
 * nothing. Everything that is not is treated as absent and takes the caller's safe default.
 */
function isUsableErrorStatus(raw: unknown): raw is HttpErrorStatus {
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= 400 && raw < 600;
}

/** Read a stamped fault status off anything, in any realm. `undefined` if unstamped. */
function stampedStatus(value: unknown): HttpErrorStatus | undefined {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return undefined;
  const raw = (value as Record<PropertyKey, unknown>)[MANDREL_FAULT_STATUS];
  return isUsableErrorStatus(raw) ? raw : undefined;
}

/**
 * The status a classified error declared, or `undefined` for anything unclassified.
 *
 * Called by `formatMcpError` — the ONE place an error becomes a tool result — so no call
 * site has to remember to carry it.
 */
export function declaredFaultStatus(error: unknown): HttpErrorStatus | undefined {
  return stampedStatus(error);
}

/**
 * What a tool call produced. A call either RETURNED a result or THREW. There is no third.
 *
 * `failed` is PASSED IN rather than re-derived. `isErrorResult` (utils/mcpFormatter.ts) is
 * the single definition of "this result reports a failure", and it decides the envelope's
 * `success` field at the same call site. Re-reading `.isError` here would be a second copy
 * of that rule in a lower-level module, free to drift from the one the envelope uses — the
 * exact two-answers-to-one-question shape this whole change exists to remove. Importing it
 * instead would make utils/mcpFormatter.ts and this module mutually dependent, so the
 * caller hands us its verdict.
 */
export type ToolOutcome =
  | { readonly kind: 'returned'; readonly result: unknown; readonly failed: boolean }
  | { readonly kind: 'threw'; readonly error: unknown };

/** Every status this authority can emit, including the success case. */
export type HttpToolStatus = 200 | HttpErrorStatus;

/**
 * ★ THE SINGLE AUTHORITY. Both branches of `handleMcpToolExpress` call this and nothing
 * else decides a tool call's status.
 *
 * - THREW → the numeric JSON-RPC / stamped classification above, fail-closed at 500.
 * - RETURNED a non-error result → 200.
 * - RETURNED an error result that carries a stamped POLICY status → that status. The tool
 *   never ran; the caller must change something.
 * - RETURNED an error result with NO stamp → 200. This is the ordinary MCP tool error
 *   ("context not found", "unknown action"): the tool ran and answered. Defaulting these to
 *   a 4xx would relabel every well-formed negative answer as a client mistake, and would
 *   break the `200 + isError` shape that MCP specifies and that every consumer expects. It
 *   is a conservative default, not a fail-open: a genuine THROWN fault cannot reach this
 *   branch at all — it lands in `kind:'threw'`, where the default is 500.
 */
export function httpStatusForToolOutcome(outcome: ToolOutcome): HttpToolStatus {
  if (outcome.kind === 'threw') return httpStatusForError(outcome.error);
  // A SUCCEEDING call is 200 no matter what is hanging off it. Checked before the stamp so
  // a stamp that somehow reached a successful result — nothing can produce one today; only
  // formatMcpError stamps, and it always sets isError — could not turn a success into a 4xx.
  if (!outcome.failed) return 200;
  const declared = (outcome.result as { transportStatus?: unknown } | null | undefined)?.transportStatus;
  return isUsableErrorStatus(declared) ? declared : 200;
}
