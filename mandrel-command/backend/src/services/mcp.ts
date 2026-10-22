/**
 * MCP Service - Interface to AIDIS MCP Server
 * 
 * This service handles communication with the AIDIS MCP server
 * via HTTP endpoints at localhost:8080/mcp/tools/{toolName}
 */

import http from 'http';
import { logger } from '../config/logger';
import config from '../config/environment';

export interface McpResult {
  success: boolean;
  data?: any;
  error?: string;
}

export class McpService {
  private static readonly REQUEST_TIMEOUT = 10000; // 10 seconds

  /**
   * Resolve the MCP server hostname + port.
   *
   * Prefer an explicit MCP base URL (MANDREL_MCP_URL) — required in containerized
   * deploys where the MCP server is a sibling container reachable by service name
   * (e.g. http://mcp-server:8080), NOT localhost. Fall back to host:port form for
   * same-namespace/dev deploys. This mirrors the MCP_BASE logic in routes/index.ts.
   */
  private static resolveMcpTarget(): { hostname: string; port: number } {
    const url = process.env.MANDREL_MCP_URL || process.env.AIDIS_MCP_URL;
    if (url) {
      try {
        const parsed = new URL(url);
        return {
          hostname: parsed.hostname,
          port: parseInt(parsed.port, 10) || 8080
        };
      } catch {
        logger.warn(`[MCP] Invalid MANDREL_MCP_URL "${url}", falling back to host:port`);
      }
    }

    const port = parseInt(
      (process.env.MANDREL_MCP_PORT || process.env.AIDIS_MCP_PORT || process.env.AIDIS_MCP_HOST_PORT || '8080') as string,
      10
    ) || 8080;

    // Log deprecation warning if old var is used
    if (process.env.AIDIS_MCP_PORT && !process.env.MANDREL_MCP_PORT) {
      logger.warn('⚠️  AIDIS_MCP_PORT is deprecated. Use MANDREL_MCP_PORT instead.');
    }

    return { hostname: 'localhost', port };
  }

  /**
   * The Authorization header this backend presents to the mcp-server, or {} when no token is
   * configured. A static Bearer token (config.mcp.authToken ← MCP_AUTH_TOKEN) — the INTERNAL
   * SERVICE TOKEN for the trust boundary between this backend (:5000, authenticates the USER)
   * and the mcp-server (:8080). It authenticates BOTH:
   *   - the on-box /mcp/tools/* bridge calls, once MCP_BRIDGE_AUTH_ENABLED is on; and
   *   - the /api/v2/sessions/* REST proxy, whose mcp-server gate is UNCONDITIONAL
   *     (bearerAuth) — so this header is REQUIRED there, not optional, or the mcp-server returns 401.
   * Empty token → NO header → byte-identical to the pre-shield request (safe while the bridge gate is
   * OFF; on the now-gated session family an empty token correctly yields a 401 fail-closed). PUBLIC so
   * the session proxy reuses the exact same builder — ONE token source, no drifting copies.
   * Never logged.
   */
  static authHeader(): Record<string, string> {
    const token = config.mcp.authToken;
    return token && token.trim() !== '' ? { Authorization: `Bearer ${token.trim()}` } : {};
  }

  /**
   * Call an AIDIS MCP tool via HTTP endpoint.
   *
   * `actor` (Sessions Foundation — human attribution) is the logged-in
   * principal (`req.user.username`) forwarded as the `X-Actor-ID` header so the session
   * the mcp-server lazily creates for this connection is attributed to the human who
   * clicked, instead of the flagged `anonymous`. It MIRRORS the already-wired seam at
   * routes/index.ts:157 (POST /api/v2/sessions/start). Since callTool is a stateless
   * static seam with no request, the actor is threaded in by each authenticated caller.
   * Omitted/blank actor → no header → byte-identical to the pre-attribution behavior
   * (a pure agent / no-logged-in-user call through the proxy still works).
   */
  static async callTool(toolName: string, params: any, actor?: string): Promise<McpResult> {
    logger.info(`[MCP] Calling ${toolName} with params`, { params });

    try {
      const result = await this.makeRequest(toolName, params, actor);
      logger.info(`[MCP] ${toolName} result`, { result });
      return {
        success: true,
        data: result
      };
    } catch (error) {
      logger.error(`[MCP] ${toolName} failed`, { error });
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  /**
   * Make HTTP request to AIDIS MCP server
   */
  private static async makeRequest(toolName: string, params: any, actor?: string): Promise<any> {
    return new Promise((resolve, reject) => {
      const postData = JSON.stringify({ arguments: params });

      // Resolve MCP target (prefers MANDREL_MCP_URL service name in containers,
      // falls back to localhost:MANDREL_MCP_PORT for dev). MANDREL_MCP_PORT is the
      // MCP server, NOT MANDREL_HTTP_PORT (which is the backend).
      const { hostname, port: mcpPort } = McpService.resolveMcpTarget();

      const headers: Record<string, string | number> = {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
        ...McpService.authHeader()
      };

      // Sessions Foundation — human attribution: forward the logged-in
      // principal as X-Actor-ID so the mcp-server bridge (healthServer.ts deriveActor)
      // attributes this connection's session to the human. Same guard as the wired seam
      // at routes/index.ts:157 — set ONLY when a non-blank actor is present, so an absent
      // actor leaves the request byte-identical to before (unattributed → anonymous).
      if (actor && actor.trim() !== '') {
        headers['X-Actor-ID'] = actor.trim();
      }

      const options = {
        hostname,
        port: mcpPort,
        path: `/mcp/tools/${toolName}`,
        method: 'POST',
        headers
      };

      const req = http.request(options, (res) => {
        let data = '';
        
        res.on('data', (chunk) => {
          data += chunk;
        });
        
        res.on('end', () => {
          try {
            // ── PAYLOAD FIRST, TRANSPORT STATUS SECOND ─────────────────────────────
            // The successor to KEY ON THE PAYLOAD, NOT THE FLAG,
            // which fixed the same defect one signal over: `/mcp/tools/*`
            // answers an in-band tool error with a real CallToolResult under `result`,
            // and `result` is present in BOTH envelope shapes — so neither the `success`
            // flag nor the HTTP status may decide whether it is read.
            //
            // WAS: every branch below sat inside `if (res.statusCode === 200)`, and any
            // other status became `HTTP <n>: <raw body>` — the JSON envelope stringified
            // into an error message. That made the status code, not the payload, decide
            // whether the tool's own answer was allowed to exist.
            //
            // WHY IT MATTERS HERE: the mcp-server answers a POLICY REFUSAL (actor required,
            // PROJECT_SCOPE_SWITCH_UNIDENTIFIED, PROJECT_AMBIENT_WRITE_UNIDENTIFIED, a
            // strict-mode param rejection) with a real CallToolResult under `result`
            // carrying the actionable prose that tells the operator what to do. Keying on
            // `success` threw that prose away; keying on the STATUS throws away exactly the
            // same prose the moment the server starts classifying those refusals as 4xx
            // (which is correct of it — a client error must not read as 5xx to a retrying
            // client). This backend sends no X-Connection-ID, so it IS inside the identity
            // guards' population: those refusals are a thing its users will actually see.
            //
            // So read the PAYLOAD first, exactly as both stdio bridges already do
            // (`response.result !== undefined` before any status inspection). A genuine
            // transport/auth failure carries no `result` and still rejects — with the
            // status-bearing message when the status is the only signal we have.
            // The resolved value's SHAPE is unchanged; only the gate in front of it moved.
            const parsed = JSON.parse(data);

            if (parsed?.result === undefined) {
              // No tool answer in the body. NOW the transport status is the best (only)
              // thing we know, so a non-200 keeps its original `HTTP <n>: <body>` message.
              reject(new Error(
                res.statusCode === 200
                  ? (parsed?.error || parsed?.message || 'Mandrel MCP tool error')
                  : `HTTP ${res.statusCode}: ${data}`
              ));
              return;
            }

            // Extract the actual result from AIDIS response
            let result = parsed.result;

            // Legacy `data` sibling (write tools: context_store, decision_record,
            // naming_register, …). Preserved as-is — those callers read result.data.
            if (result && result.data) {
              resolve(result.data);
              return;
            }

            // CANONICAL MACHINE CHANNEL (search consolidation, parser
            // deletion): the MCP bridge guarantees `structuredContent`
            // on EVERY response (routes/index.ts ensureStructuredContent). Read the
            // structured fields — NEVER re-derive machine facts from the rendered
            // prose. The old TEXT_PARSE_TOOLS exemption + its six regex parsers are
            // DELETED: every field they scraped either already rides
            // the `data` sibling above (decision_search / decision_stats), exists in
            // structuredContent (project_insights), or belongs to a tool the server
            // no longer ships (naming_*, which now fail validation before any
            // response body exists — the parsers were unreachable dead code).
            if (
              result &&
              typeof result === 'object' &&
              result.structuredContent !== undefined
            ) {
              resolve(result.structuredContent);
              return;
            }

            // Legacy text-only response (a pre-dual-channel server). Return the prose
            // VERBATIM — no field extraction. Machine facts must come from the
            // structured channel; a rendered string is a human representation and the
            // renderer is free to change it.
            if (result && result.content && result.content[0] && result.content[0].text) { // mcp-text-passthrough-allowed: presence check for the verbatim passthrough below; nothing extracted
              result = result.content[0].text; // mcp-text-passthrough-allowed: verbatim passthrough of the prose as an opaque string; no field is parsed out of it
            }

            resolve(result);
          } catch (parseError) {
            // A body we could not parse tells us nothing about the tool's answer, so the
            // status is again all we have: a non-200 reports the transport failure rather
            // than a parser message that hides it.
            reject(new Error(
              res.statusCode === 200
                ? `Failed to parse response: ${parseError}`
                : `HTTP ${res.statusCode}: ${data}`
            ));
          }
        });
      });

      req.on('error', (error: NodeJS.ErrnoException) => {
        const errorDetails = error.code ? `${error.code}: ${error.message}` : error.message || 'Unknown socket error';
        logger.error(`[MCP] Tool call connection error to ${hostname}:${mcpPort}/mcp/tools/${toolName}`, {
          code: error.code,
          message: error.message,
          syscall: error.syscall,
          errno: error.errno
        });
        reject(new Error(`Request failed: ${errorDetails}`));
      });

      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Request timeout'));
      });

      req.setTimeout(this.REQUEST_TIMEOUT);
      req.write(postData);
      req.end();
    });
  }


  /**
   * Call an arbitrary MCP server endpoint (not a tool endpoint)
   * Used for REST API calls like /api/v2/projects/:id/set-primary
   */
  static async callMcpEndpoint(path: string, method: string = 'GET', body?: any, actor?: string): Promise<any> {
    return new Promise((resolve, reject) => {
      const postData = body ? JSON.stringify(body) : '';

      // Resolve MCP target (prefers MANDREL_MCP_URL service name in containers,
      // falls back to localhost:MANDREL_MCP_PORT for dev).
      const { hostname, port: mcpPort } = McpService.resolveMcpTarget();

      const headers: Record<string, string | number> = {
        'Content-Type': 'application/json',
        ...(postData ? { 'Content-Length': Buffer.byteLength(postData) } : {}),
        ...McpService.authHeader()
      };
      // Forward the authenticated principal as X-Actor-ID — the SAME guard as callTool /
      // makeRequest (only when non-blank) — so a logged-in user's endpoint call (e.g.
      // surveyor_scan) attributes to them instead of `anonymous`. Absent/blank → omitted →
      // request identical to before (finishes the attribution class).
      if (actor && actor.trim() !== '') headers['X-Actor-ID'] = actor.trim();

      const options = {
        hostname,
        port: mcpPort,
        path: path,
        method: method,
        headers
      };

      const req = http.request(options, (res) => {
        let data = '';

        res.on('data', (chunk) => {
          data += chunk;
        });

        res.on('end', () => {
          try {
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
              const parsed = JSON.parse(data);
              resolve(parsed);
            } else {
              reject(new Error(`HTTP ${res.statusCode}: ${data}`));
            }
          } catch (parseError) {
            reject(new Error(`Failed to parse response: ${parseError}`));
          }
        });
      });

      req.on('error', (error: NodeJS.ErrnoException) => {
        const errorDetails = error.code ? `${error.code}: ${error.message}` : error.message || 'Unknown socket error';
        logger.error(`[MCP] REST API connection error to ${hostname}:${mcpPort}${path}`, {
          code: error.code,
          message: error.message,
          syscall: error.syscall,
          errno: error.errno
        });
        reject(new Error(`Request failed: ${errorDetails}`));
      });

      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Request timeout'));
      });

      req.setTimeout(this.REQUEST_TIMEOUT);

      if (postData) {
        req.write(postData);
      }

      req.end();
    });
  }

  /**
   * Test AIDIS server connectivity
   */
  static async testConnection(): Promise<boolean> {
    try {
      // mcp-write-scope: read — a connectivity probe; aidis_ping is the deprecated alias of
      // mandrel_ping and is classified 'read' explicitly in opRegistry's alias table.
      await this.callTool('aidis_ping', { message: 'Connection test' });
      return true;
    } catch (error) {
      logger.error('[MCP] Connection test failed', { error });
      return false;
    }
  }
}