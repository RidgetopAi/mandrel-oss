/**
 * Shared MCP request-handler registration
 *
 * DRY: this is the SINGLE place that registers the MCP JSON-RPC request handlers
 * (ListTools / CallTool / ListResources / ReadResource) on an SDK `Server` instance.
 *
 * It is used by BOTH:
 *   - the long-lived stdio `Server` (MandrelMcpServer)
 *   - each per-session HTTP `Server` created for a Streamable HTTP connection
 *
 * The actual tool logic is NOT duplicated here — every CallTool request is delegated
 * back to the shared `executeMcpTool()` closure provided by MandrelMcpServer, which
 * funnels through `executeToolOperation()` → `routeExecutor()`. ZERO changes to tool
 * logic; this only wires the protocol surface.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { logger } from '../utils/logger.js';
import { assertToolInputWithinLimit } from '../utils/toolInputLimit.js';
import type { TransportRouteContext } from '../routes/index.js';

/**
 * The advertised-surface assembler MOVED to config/advertisedSurface.ts so the
 * handlers that must STATE the size of the surface (mandrel_help / discover.catalog headers) can
 * measure the very same array without a handler→server import. Re-exported verbatim here: this
 * module's ListTools handler and every existing importer keep reading the one assembler, so there
 * is still exactly ONE place the surface is built.
 */
export { buildAdvertisedTools } from '../config/advertisedSurface.js';
import { buildAdvertisedTools } from '../config/advertisedSurface.js';

/**
 * Collaborators injected by MandrelMcpServer so this module never owns tool logic
 * or server state directly.
 */
export interface McpHandlerDeps {
  /** Shared tool executor (validation → routeExecutor). connectionId isolates sessions;
   *  actor (Phase 1) attributes a lazily-created session. */
  executeMcpTool: (
    toolName: string,
    args: any,
    /** projectBinding: the client-declared X-Mandrel-Project scope, if any.
     *  identified: REQUIRED whenever a context is supplied — the transport
     *  must state whether the caller presented a connection identity. See
     *  routes/index.ts TransportRouteContext. */
    context?: TransportRouteContext
  ) => Promise<any>;
  /** Best-effort server status for the aidis://status resource. */
  getServerStatus: () => Promise<any>;
}

/**
 * Register the full MCP request-handler surface on a given SDK Server.
 *
 * @param server  An SDK `Server` (stdio or a per-HTTP-session instance)
 * @param deps    Shared collaborators from MandrelMcpServer
 * @param connectionId  Connection/session identifier used for session isolation.
 *                      stdio passes undefined (defaults to 'stdio' downstream);
 *                      each HTTP session passes its Mcp-Session-Id.
 */
export function registerMcpHandlers(
  server: Server,
  deps: McpHandlerDeps,
  connectionId?: string
): void {
  // Tool listing — filter disabled tools + (Phase 0) gate the outputSchema advertisement.
  // buildAdvertisedTools() reads MANDREL_ADVERTISE_OUTPUT_SCHEMAS via config; default ON =
  // byte-identical to legacy stdio behaviour.
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: buildAdvertisedTools(),
    };
  });

  // Tool execution — delegate to the shared executor (no tool logic here)
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: rawArgs } = request.params;

    try {
      // Params arrive as the client sent them; transport-stringified values are coerced
      // SCHEMA-DRIVEN inside validateToolArguments, once the per-op schema is resolved
      // (an earlier task — replaced the old name-allow-list deserializer here).
      const args = rawArgs || {};
      // TOOL-INPUT ELEMENT LIMIT — the SDK 1.32 `maxToolInputElements` check,
      // which the low-level Server does not offer. Its McpError(-32602) is re-thrown verbatim
      // by the catch below.
      assertToolInputWithinLimit(name, args);
      // Pass connectionId so HTTP sessions are isolated from stdio and each other.
      // `identified: true` — a connectionId is only non-empty here when the
      // caller's own Mcp-Session-Id (or X-Connection-ID) produced it, which IS a presented
      // identity. When it is absent this returns undefined and the decision is made one
      // layer up: the remote transport's wrapper (remoteMcpTransport.ts) or, for stdio,
      // MandrelMcpServer.executeMcpTool.
      return await deps.executeMcpTool(
        name,
        args,
        connectionId ? { connectionId, identified: true } : undefined
      );
    } catch (error) {
      // SAME CLASS AS THE HTTP 500, one layer over: this catch used to
      // re-wrap EVERY failure as ErrorCode.InternalError (-32603), so a strict-mode
      // `Unknown parameter(s)` throw — already correctly classified McpError(-32602,
      // "Invalid params") by validationMiddleware — reached the client on the streamable
      // /mcp surface as an INTERNAL SERVER ERROR. Measured, pre-fix, over the real
      // transport: `{"code":-32603,"message":"MCP error -32603: Failed to execute tool:
      // MCP error -32602: Input validation failed: …"}`. -32603 is the JSON-RPC equivalent
      // of the HTTP 5xx this task exists to stop emitting for a client mistake, and an MCP
      // client keys its retry decision off this code exactly as an HTTP client keys off the
      // status. So the classification must be PRESERVED, not flattened.
      //
      // An error that already carries a JSON-RPC code was classified by the layer that knew
      // what went wrong; re-throw it verbatim. FAIL CLOSED: anything else — a plain Error, a
      // DB fault, a thrown string — still becomes -32603 InternalError, exactly as before,
      // so an unrecognised fault is never downgraded to a client error.
      logger.error(`Error executing tool ${name}`, error as Error);
      if (error instanceof McpError) throw error;
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to execute tool: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  });

  // Resource listing
  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    return {
      resources: [
        {
          uri: 'aidis://status',
          mimeType: 'application/json',
          name: 'AIDIS Server Status',
          description: 'Current server status and configuration',
        },
      ],
    };
  });

  // Resource reading
  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const { uri } = request.params;

    if (uri === 'aidis://status') {
      const status = await deps.getServerStatus();
      return {
        contents: [
          {
            uri,
            mimeType: 'application/json',
            text: JSON.stringify(status, null, 2),
          },
        ],
      };
    }

    throw new McpError(ErrorCode.InvalidRequest, `Unknown resource: ${uri}`);
  });
}
