import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport, StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CallToolResultSchema, ErrorCode, McpError, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { MCP_CONFIG } from '../config.js';
import { readVersion } from '../version.js';

/** A Mandrel tool answered with `isError: true` (or a JSON-RPC error). Distinct from a transport failure. */
export class ToolError extends Error {
  constructor(
    readonly tool: string,
    message: string,
    readonly structured?: Record<string, unknown>,
  ) {
    super(`${tool}: ${message}`);
    this.name = 'ToolError';
  }
}

/** The request never produced a usable tool result (refused connection, bad status/body, timeout). */
export class TransportError extends Error {
  constructor(
    readonly tool: string,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(`${tool}: ${message}`, options);
    this.name = 'TransportError';
  }
}

/** The server refused the token (HTTP 401/403). */
export class AuthError extends TransportError {
  constructor(tool: string, message: string, options?: { cause?: unknown }) {
    super(tool, message, options);
    this.name = 'AuthError';
  }
}

/** Nothing at the URL speaks MCP (initialize answered 400/404/405). */
export class EndpointError extends TransportError {
  constructor(tool: string, message: string, options?: { cause?: unknown }) {
    super(tool, message, options);
    this.name = 'EndpointError';
  }
}

/** `<url>/mcp`; a url that already ends in `/mcp` is kept, so the client config's MCP url also works. */
export function mcpEndpoint(url: string): URL {
  const base = url.replace(/\/+$/, '');
  return new URL(base.endsWith(MCP_CONFIG.endpointPath) ? base : `${base}${MCP_CONFIG.endpointPath}`);
}

export interface McpSessionOptions {
  /** The server's base URL (or its `/mcp` URL). */
  url: string;
  /** Sent on every request, initialize included. */
  headers: Record<string, string>;
  /** Values (the token) redacted from any server-supplied text the session surfaces. */
  secrets?: readonly string[];
  fetch?: typeof fetch;
  timeoutMs?: number;
}

interface Connection {
  client: Client;
  transport: StreamableHTTPClientTransport;
}

/**
 * One MCP session over streamable HTTP. It initializes on first use, is reused for every later
 * call, re-initializes when the server no longer holds the session, and is ended by `close`.
 */
export class McpSession {
  readonly endpoint: URL;
  /** Completed initialize handshakes. */
  initializeCount = 0;
  private conn?: Promise<Connection>;
  private readonly timeoutMs: number;

  constructor(private readonly opts: McpSessionOptions) {
    this.endpoint = mcpEndpoint(opts.url);
    this.timeoutMs = opts.timeoutMs ?? MCP_CONFIG.requestTimeoutMs;
  }

  /** One tools/call; an `isError` result rejects with ToolError carrying its structuredContent. */
  async callTool(label: string, name: string, args: Record<string, unknown>, idempotent: boolean): Promise<CallToolResult> {
    const result = await this.run(label, idempotent, (client) =>
      client.request({ method: 'tools/call', params: { name, arguments: args } }, CallToolResultSchema, { timeout: this.timeoutMs }),
    );
    if (result.isError === true) {
      const text = result.content.find((c) => c.type === 'text');
      const structured = result.structuredContent ? (JSON.parse(redact(JSON.stringify(result.structuredContent), jsonForms(this.opts.secrets ?? []))) as Record<string, unknown>) : undefined;
      throw new ToolError(label, this.clean(text && 'text' in text ? text.text : 'tool reported an error'), structured);
    }
    return result;
  }

  /** Ends the session (best effort, bounded) and frees its connections. Safe to call twice. */
  async close(): Promise<void> {
    const pending = this.conn;
    this.conn = undefined;
    if (!pending) return;
    const c = await pending.catch(() => undefined);
    if (!c) return;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      c.transport.terminateSession().catch(() => undefined),
      new Promise<void>((done) => (timer = setTimeout(done, MCP_CONFIG.closeTimeoutMs))),
    ]);
    clearTimeout(timer);
    await c.client.close().catch(() => undefined);
  }

  private connection(): Promise<Connection> {
    if (!this.conn) {
      const p = this.open();
      // A failed initialize must not be cached: the next call tries again.
      p.catch(() => this.forget(p));
      this.conn = p;
    }
    return this.conn;
  }

  private async open(): Promise<Connection> {
    const transport = new StreamableHTTPClientTransport(this.endpoint, {
      requestInit: { headers: this.opts.headers },
      ...(this.opts.fetch ? { fetch: this.opts.fetch } : {}),
      // The loop needs no server-initiated messages; never keep re-opening the optional SSE stream.
      reconnectionOptions: { initialReconnectionDelay: 1000, maxReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1, maxRetries: 0 },
    });
    const client = new Client({ name: MCP_CONFIG.clientName, version: readVersion() });
    // The optional GET stream reports its own failures here; tool calls report theirs to the caller.
    client.onerror = () => undefined;
    try {
      await client.connect(transport, { timeout: this.timeoutMs });
    } catch (e) {
      await client.close().catch(() => undefined);
      throw e;
    }
    this.initializeCount++;
    return { client, transport };
  }

  /** Drops `p` if it is still the live connection, and closes it without waiting on the server. */
  private forget(p: Promise<Connection>): void {
    if (this.conn === p) this.conn = undefined;
    p.then((c) => c.client.close()).catch(() => undefined);
  }

  private async run<T>(label: string, idempotent: boolean, op: (client: Client) => Promise<T>): Promise<T> {
    let sessionRetries = 0;
    let socketRetries = 0;
    for (;;) {
      const p = this.connection();
      let c: Connection;
      try {
        c = await p;
      } catch (e) {
        if (isRetryableSocketError(e) && socketRetries++ < MCP_CONFIG.socketRetries) continue;
        throw this.classify(label, e, true);
      }
      try {
        return await op(c.client);
      } catch (e) {
        // The server refused the request before running it, so a retry is safe for any call.
        if (isSessionExpired(e) && sessionRetries++ < MCP_CONFIG.sessionRetries) {
          this.forget(p);
          continue;
        }
        if (idempotent && isRetryableSocketError(e) && socketRetries++ < MCP_CONFIG.socketRetries) continue;
        // A timed-out request may still be in flight; dropping the session aborts it.
        if (isTimeout(e)) this.forget(p);
        throw this.classify(label, e, false);
      }
    }
  }

  /**
   * Server-supplied text (an HTTP error body, a tool's error text, a JSON-RPC message) can echo the
   * request, Authorization header included. Everything that text reaches (doctor, logs, task notes)
   * gets it through here: the session's secrets and any `Bearer <x>` are redacted, then it is capped.
   */
  private clean(text: string): string {
    return capText(redact(text, this.opts.secrets ?? []), MCP_CONFIG.serverTextMaxChars);
  }

  private classify(label: string, e: unknown, initializing: boolean): Error {
    if (e instanceof ToolError || e instanceof TransportError) return e;
    const where = this.endpoint.href;
    if (isTimeout(e)) return new TransportError(label, `no answer from ${where} within ${this.timeoutMs} ms`);
    // No `cause` below for server-originated errors: the raw error carries the unredacted body.
    if (e instanceof StreamableHTTPError) {
      const status = e.code ?? -1;
      const detail = this.clean(firstLine(e.message.replace(/^Streamable HTTP error: (Error POSTing to endpoint: )?/, '')));
      if (e.message.includes(MCP_CONFIG.hostRefusedText)) {
        return new TransportError(label, `HTTP ${status}: ${where} refused the Host header (${detail})`);
      }
      if ((MCP_CONFIG.authFailureStatuses as readonly number[]).includes(status)) {
        return new AuthError(label, `HTTP ${status}, token refused (${detail})`);
      }
      if (initializing && (MCP_CONFIG.noEndpointStatuses as readonly number[]).includes(status)) {
        return new EndpointError(label, `HTTP ${status}: no MCP endpoint at ${where}${detail ? ` (${detail})` : ''}`);
      }
      return new TransportError(label, `HTTP ${status}: ${detail || 'no body'}`);
    }
    if (e instanceof McpError) return new ToolError(label, this.clean(e.message.replace(/^(MCP error -?\d+: )\1+/, '$1')));
    // Local failures (refused connection, socket reset): keep the cause, whose codes drive retries.
    return new TransportError(label, `request to ${where} failed: ${this.clean(describeCause(e))}`, { cause: e });
  }
}

const firstLine = (s: string): string => s.trim().split('\n')[0] ?? '';

/** What a redacted value is replaced with. */
export const REDACTED = '<redacted>';

/** Replaces every occurrence of each secret, and any `Bearer <credential>`, with REDACTED. */
export function redact(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (!secret) continue;
    // The raw value plus the forms a server echo can take: URL-encoded and JSON-escaped (the reviewer n2).
    for (const form of new Set([secret, encodeURIComponent(secret), JSON.stringify(secret).slice(1, -1)])) {
      out = out.split(form).join(REDACTED);
    }
  }
  return out.replace(MCP_CONFIG.bearerPattern, `Bearer ${REDACTED}`);
}

/** Each secret as it appears inside a JSON string, so a serialized object can be redacted too. */
function jsonForms(secrets: readonly string[]): string[] {
  return secrets.flatMap((s) => [s, JSON.stringify(s).slice(1, -1)]);
}

/** Caps text AFTER redaction, so a cut can never leave half a secret visible. */
function capText(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}… (${text.length - max} more chars)`;
}

function isTimeout(e: unknown): boolean {
  return e instanceof McpError && e.code === ErrorCode.RequestTimeout;
}

function isSessionExpired(e: unknown): boolean {
  return e instanceof StreamableHTTPError && e.code === MCP_CONFIG.sessionExpiredStatus;
}

/** The error codes along an error's `cause` chain, outermost first. */
function causeCodes(e: unknown): string[] {
  const codes: string[] = [];
  for (let c: unknown = e, depth = 0; c instanceof Error && depth < 5; c = c.cause, depth++) {
    const code = (c as { code?: unknown }).code;
    if (typeof code === 'string') codes.push(code);
  }
  return codes;
}

function isRetryableSocketError(e: unknown): boolean {
  return causeCodes(e).some((c) => (MCP_CONFIG.retryableSocketCodes as readonly string[]).includes(c));
}

/** `fetch failed` hides the real reason in `cause`; name it, with its code. */
function describeCause(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  const inner = e instanceof Error && e.cause instanceof Error ? e.cause : undefined;
  const code = causeCodes(e)[0];
  const detail = inner ? inner.message : '';
  return [msg, code ? `[${code}]` : '', detail && detail !== msg ? detail : ''].filter(Boolean).join(' ');
}
