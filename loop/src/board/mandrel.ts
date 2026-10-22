import type { Board, Claim, NewTask, Outcome, Project, Stage, Task, TaskRow, TaskUpdate } from '../board.js';
import { MCP_CONFIG, SERVER_MIRRORED_PUNCH_KEYS, type GatewayCall } from '../config.js';
import { McpSession, redact, ToolError, TransportError } from './mcpSession.js';

export { AuthError, EndpointError, ToolError, TransportError, mcpEndpoint } from './mcpSession.js';

export interface MandrelBoardOptions {
  /** Base URL of the Mandrel server, e.g. http://localhost:8080 (the client appends /mcp). */
  url: string;
  authToken: string;
  connectionId: string;
  actorId: string;
  project: string;
  fetch?: typeof fetch;
  /** Per-request timeout; defaults to MCP_CONFIG.requestTimeoutMs. */
  timeoutMs?: number;
}

/** Untyped JSON from the wire; narrowed at each use. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Wire = any;

/** `task.list`, `project.list`, …: the label errors and logs name a gateway call by. */
const label = (c: GatewayCall): string => `${c.tool}.${c.action}`;

export class MandrelBoard implements Board {
  /** Every project-scoped call: carries the project binding. */
  private readonly bound: McpSession;
  /** Listing projects must work before the configured project exists, so it carries no binding. */
  private unboundSession?: McpSession;

  constructor(private readonly opts: MandrelBoardOptions) {
    this.bound = this.session(true);
  }

  private session(withProject: boolean): McpSession {
    const { headers: h } = MCP_CONFIG;
    return new McpSession({
      url: this.opts.url,
      fetch: this.opts.fetch,
      timeoutMs: this.opts.timeoutMs,
      secrets: [this.opts.authToken],
      headers: {
        Authorization: `Bearer ${this.opts.authToken}`,
        [h.connectionId]: this.opts.connectionId,
        [h.actorId]: this.opts.actorId,
        ...(withProject ? { [h.project]: this.opts.project } : {}),
      },
    });
  }

  /** Ends both MCP sessions. */
  async close(): Promise<void> {
    await Promise.all([this.bound.close(), this.unboundSession?.close()]);
  }

  async listProjects(): Promise<Project[]> {
    // No project header: listing projects must work before the configured project exists.
    const sc = await this.call(MCP_CONFIG.calls.listProjects, { limit: MCP_CONFIG.projectListLimit }, false, true);
    return (sc.results ?? []).map((p: Wire) => ({ id: p.id, name: p.name }));
  }

  async listStage(stage: Stage): Promise<TaskRow[]> {
    const rows: TaskRow[] = [];
    for (let offset = 0; ; ) {
      const sc = await this.call(MCP_CONFIG.calls.listTasks, {
        stage,
        limit: MCP_CONFIG.listPageSize,
        offset,
      }, true, true);
      const page: Wire[] = sc.results ?? [];
      rows.push(...page.map(toRow));
      offset += page.length;
      if (!sc.hasMore || page.length === 0) return rows;
    }
  }

  async get(id: string): Promise<Task | null> {
    const sc = await this.call(MCP_CONFIG.calls.getTask, { taskId: id }, true, true);
    if (sc.found === false || !sc.task) return null;
    return toTask(sc.task);
  }

  async create(input: NewTask): Promise<Task> {
    const sc = await this.call(MCP_CONFIG.calls.create, {
      title: input.title,
      description: input.description,
      stage: input.stage,
      tags: input.tags,
      dependencies: input.dependencies,
      punch: input.punch,
    });
    if (!sc.task) throw new TransportError(label(MCP_CONFIG.calls.create), 'created task missing from result');
    return toTask(sc.task);
  }

  async claim(id: string, allowedStatuses?: readonly string[]): Promise<Outcome<Claim>> {
    return this.claimOutcome(MCP_CONFIG.calls.claim, {
      taskId: id,
      ...(allowedStatuses ? { allowedStatuses: [...allowedStatuses] } : {}),
    });
  }

  async renew(id: string, claimId: string): Promise<Outcome<Claim>> {
    return this.claimOutcome(MCP_CONFIG.calls.renew, { taskId: id, claimId }, true);
  }

  async release(id: string, claimId: string): Promise<Outcome<object>> {
    const tool = MCP_CONFIG.calls.release;
    const sc = await this.callRaw(tool, { taskId: id, claimId });
    return sc.ok === false || sc.claimed === false || sc.released !== true
      ? this.refusal(sc)
      : { ok: true };
  }

  async update(id: string, update: TaskUpdate, claimId: string): Promise<Outcome<{ task: Task }>> {
    const tool = MCP_CONFIG.calls.update;
    try {
      await this.call(tool, { taskId: id, claimId, ...(await this.withFullPunch(id, update)) }, true, true);
    } catch (e) {
      // Fencing refusals arrive as isError results with a typed reason; surface them as refusals.
      if (e instanceof ToolError && typeof e.structured?.reason === 'string') return this.refusal(e.structured);
      throw e;
    }
    const task = await this.get(id);
    if (!task) return { ok: false, reason: 'not-found' };
    return { ok: true, task };
  }

  /**
   * `metadata.punch` replaces the stored punch on some servers, so a write there re-sends every key
   * the task already carries (less the server-mirrored ones, which the server refuses from a caller).
   * A null clears a key; it is sent only for a key that exists.
   */
  private async withFullPunch(id: string, update: TaskUpdate): Promise<TaskUpdate> {
    const incoming = update.metadata?.punch as Record<string, unknown> | undefined;
    if (!incoming) return update;
    const current = (await this.get(id))?.metadata.punch ?? {};
    const punch: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(current)) if (!SERVER_MIRRORED_PUNCH_KEYS.includes(k)) punch[k] = v;
    for (const [k, v] of Object.entries(incoming)) {
      if (v === null && !(k in punch)) continue;
      punch[k] = v;
    }
    return { ...update, metadata: { ...update.metadata, punch } };
  }

  private async claimOutcome(tool: GatewayCall, args: Record<string, unknown>, idempotent = false): Promise<Outcome<Claim>> {
    const sc = await this.callRaw(tool, args, idempotent);
    if (sc.claimed !== true || typeof sc.claimId !== 'string') return this.refusal(sc);
    return { ok: true, claimId: sc.claimId, expiresAt: String(sc.expiresAt) };
  }

  /** Like callRaw, but a tool-level refusal (`isError`) with a typed reason is returned, not thrown. */
  private async callRaw(tool: GatewayCall, args: Record<string, unknown>, idempotent = false): Promise<Wire> {
    try {
      return await this.call(tool, args, true, idempotent);
    } catch (e) {
      if (e instanceof ToolError && typeof e.structured?.reason === 'string') return e.structured;
      throw e;
    }
  }

  /** A typed refusal; its server-written message is redacted, since it reaches notes and stdout. */
  private refusal(sc: Wire): { ok: false; reason: string; message?: string } {
    const message = typeof sc.message === 'string' ? redact(sc.message, [this.opts.authToken]) : undefined;
    // `reason` is normally a fixed code, but it reaches task notes too, so it is redacted like `message` (the reviewer n1).
    return { ok: false, reason: typeof sc.reason === 'string' ? redact(sc.reason, [this.opts.authToken]) : 'unknown', message };
  }

  /**
   * One gateway call (project-scoped unless `withProject` is false); returns structuredContent.
   * Rejects ToolError / TransportError (AuthError, EndpointError).
   */
  private async call(
    call: GatewayCall,
    args: Record<string, unknown>,
    withProject = true,
    idempotent = false,
  ): Promise<Wire> {
    const session = withProject ? this.bound : (this.unboundSession ??= this.session(false));
    const result = await session.callTool(label(call), call.tool, { action: call.action, ...args }, idempotent);
    return result.structuredContent ?? {};
  }
}



function toRow(r: Wire): TaskRow {
  return {
    id: r.id,
    title: r.title,
    stage: r.stage,
    status: r.status,
    priority: r.priority,
    tags: r.tags ?? [],
    createdAt: r.createdAt,
    claimLive: r.claimLive === true,
  };
}

function toTask(t: Wire): Task {
  return { ...toRow(t), metadata: t.metadata ?? {} };
}
