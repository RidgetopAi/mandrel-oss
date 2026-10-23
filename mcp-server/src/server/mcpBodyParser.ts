/**
 * Route-scoped JSON body parsing for the MCP surfaces.
 *
 * Each MCP route is mounted as `auth, ...mcpJsonBody(limit, shape), handler` so the body is
 * parsed only after the caller has authenticated, and only up to that route's own limit
 * (config/mcpRequestLimitsConfig.ts). See the note in HealthServer.setupMiddleware for the
 * app-wide parser this replaced.
 *
 * A body the parser refuses (over the limit → 413, malformed JSON → 400, unsupported
 * encoding/charset → 415) is answered here in the surface's own error shape instead of
 * falling through to Express's default HTML error page.
 */

import express, { type ErrorRequestHandler, type RequestHandler } from 'express';

/** JSON-RPC 2.0 error codes the SDK transport itself uses for the same refusals. */
const JSONRPC_PARSE_ERROR = -32700;
const JSONRPC_INVALID_REQUEST = -32600;

/** Which error envelope the surface speaks: JSON-RPC (/mcp) or the flat `{success:false}` shape. */
export type McpBodyErrorShape = 'jsonrpc' | 'flat';

interface BodyParserError {
  status?: number;
  statusCode?: number;
  type?: string;
}

function bodyParserStatus(err: unknown): number | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const e = err as BodyParserError;
  // body-parser stamps every refusal it raises with a `type` (entity.too.large,
  // entity.parse.failed, encoding.unsupported, charset.unsupported, request.aborted, …) and
  // a 4xx status. Anything without both is not ours to answer — pass it on.
  const status = e.status ?? e.statusCode;
  if (typeof e.type !== 'string' || typeof status !== 'number' || status < 400 || status >= 500) {
    return undefined;
  }
  return status;
}

function bodyErrorHandler(shape: McpBodyErrorShape, limitBytes: number): ErrorRequestHandler {
  return (err, _req, res, next) => {
    const status = bodyParserStatus(err);
    if (status === undefined || res.headersSent) {
      next(err);
      return;
    }
    const message =
      status === 413
        ? `Payload Too Large: Request body must not exceed ${limitBytes} bytes`
        : status === 400 && (err as BodyParserError).type === 'entity.parse.failed'
          ? 'Parse error: request body is not valid JSON'
          : `Bad Request: ${(err as Error).message}`;
    if (shape === 'jsonrpc') {
      const code = (err as BodyParserError).type === 'entity.parse.failed' ? JSONRPC_PARSE_ERROR : JSONRPC_INVALID_REQUEST;
      res.status(status).json({ jsonrpc: '2.0', error: { code, message }, id: null });
    } else {
      res.status(status).json({ success: false, error: message });
    }
  };
}

/**
 * The two middlewares a body-reading MCP route mounts after its auth guard: the bounded
 * parser first, then (after the route handler, where Express looks for error handlers) the
 * refusal mapper. Usage: `app.post(path, auth, body.parse, handler, body.onError)`.
 */
export function mcpJsonBody(
  limitBytes: number,
  shape: McpBodyErrorShape
): { parse: RequestHandler; onError: ErrorRequestHandler } {
  return {
    parse: express.json({ limit: limitBytes }),
    onError: bodyErrorHandler(shape, limitBytes),
  };
}
