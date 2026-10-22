import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Board, Claim, NewTask, Outcome, Project, Task, TaskRow, TaskUpdate, Stage } from '../board.js';
import { TASK_STAGES } from '../config.js';

export interface FakeBoardOptions {
  projects?: Project[];
  tasks?: Task[];
  /** Lease length; injectable clock keeps expiry deterministic. */
  leaseMs?: number;
  now?: () => number;
}

interface Lease {
  claimId: string;
  expiresAt: number;
}

const DEFAULT_LEASE_MS = 15 * 60 * 1000;

/** The server rules the fake enforces, read from the golden the mcp-server test pins to the server. */
interface ServerRules {
  claim: { defaultAllowedStatuses: string[]; claimableStatuses: string[] };
  topLevelPunchKeys: string[];
  stageStatus: Record<string, string>;
}
const RULES_URL = new URL('../../test/fixtures/punch-contract.golden.json', import.meta.url);
const loadRules = (): ServerRules => JSON.parse(readFileSync(RULES_URL, 'utf8')) as ServerRules;

/** In-memory Board: list rows carry no metadata, claim is compare-and-swap, punch shallow-merges. */
export class FakeBoard implements Board {
  private readonly tasks = new Map<string, Task>();
  private readonly leases = new Map<string, Lease>();
  private readonly projects: Project[];
  private readonly leaseMs: number;
  private readonly now: () => number;
  private readonly rules = loadRules();

  constructor(opts: FakeBoardOptions = {}) {
    this.projects = opts.projects ?? [];
    this.leaseMs = opts.leaseMs ?? DEFAULT_LEASE_MS;
    this.now = opts.now ?? Date.now;
    for (const t of opts.tasks ?? []) this.tasks.set(t.id, structuredClone(t));
  }

  async close(): Promise<void> {}

  async listProjects(): Promise<Project[]> {
    return structuredClone(this.projects);
  }

  async listStage(stage: Stage): Promise<TaskRow[]> {
    return [...this.tasks.values()]
      .filter((t) => t.stage === stage)
      .map((t) => {
        const { metadata: _metadata, ...row } = this.view(t);
        return structuredClone(row);
      });
  }

  async get(id: string): Promise<Task | null> {
    const t = this.tasks.get(id);
    return t ? structuredClone(this.view(t)) : null;
  }

  async create(input: NewTask): Promise<Task> {
    const task: Task = {
      id: randomUUID(),
      title: input.title,
      stage: input.stage,
      status: 'todo',
      priority: 'medium',
      tags: [...input.tags],
      createdAt: new Date(this.now()).toISOString(),
      claimLive: false,
      metadata: {
        description: input.description,
        punch: { ...structuredClone(input.punch), dependsOn: [...input.dependencies] },
      },
    };
    this.tasks.set(task.id, task);
    return structuredClone(task);
  }

  async claim(id: string, allowedStatuses?: readonly string[]): Promise<Outcome<Claim>> {
    const t = this.tasks.get(id);
    if (!t) return { ok: false, reason: 'not-found' };
    if (this.liveLease(id)) return { ok: false, reason: 'held' };
    // The server narrows a requested list to its claimable ceiling, and falls back to its default.
    const { defaultAllowedStatuses, claimableStatuses } = this.rules.claim;
    const requested = allowedStatuses?.length ? allowedStatuses : defaultAllowedStatuses;
    if (!requested.filter((s) => claimableStatuses.includes(s)).includes(t.status)) {
      return { ok: false, reason: 'wrong-status', message: `status ${t.status} is not claimable` };
    }
    t.status = 'in_progress';
    const lease = { claimId: randomUUID(), expiresAt: this.now() + this.leaseMs };
    this.leases.set(id, lease);
    return { ok: true, ...this.claimOf(lease) };
  }

  async renew(id: string, claimId: string): Promise<Outcome<Claim>> {
    const lease = this.liveLease(id);
    if (!lease || lease.claimId !== claimId) return { ok: false, reason: 'claim-lost' };
    lease.expiresAt = this.now() + this.leaseMs;
    return { ok: true, ...this.claimOf(lease) };
  }

  async release(id: string, claimId: string): Promise<Outcome<object>> {
    const lease = this.liveLease(id);
    if (!lease || lease.claimId !== claimId) return { ok: false, reason: 'claim-lost' };
    this.leases.delete(id);
    return { ok: true };
  }

  async update(id: string, update: TaskUpdate, claimId: string): Promise<Outcome<{ task: Task }>> {
    const t = this.tasks.get(id);
    if (!t) return { ok: false, reason: 'not-found' };
    const lease = this.liveLease(id);
    if (!lease) return { ok: false, reason: 'held' };
    if (lease.claimId !== claimId) return { ok: false, reason: 'claim-mismatch' };
    if (update.stage !== undefined && !(TASK_STAGES as readonly string[]).includes(update.stage)) {
      return { ok: false, reason: 'invalid-stage', message: `unknown stage "${String(update.stage)}"` };
    }
    if (update.stage !== undefined) {
      t.stage = update.stage;
      t.status = this.rules.stageStatus[update.stage] ?? t.status;
    }
    if (update.tags !== undefined) t.tags = [...update.tags];
    // Server order: `metadata.punch` is folded into the punch merge; the top-level `punch` keeps only
    // the contract keys and wins on overlap; a direct `dependsOn` is refused.
    const { punch: metadataPunch, ...metadata } = (update.metadata ?? {}) as { punch?: object };
    const topLevel = Object.fromEntries(
      Object.entries(update.punch ?? {}).filter(([k]) => this.rules.topLevelPunchKeys.includes(k)),
    );
    const punchPatch = { ...metadataPunch, ...topLevel };
    if ('dependsOn' in punchPatch) {
      return { ok: false, reason: 'punch-depends-on-direct', message: 'dependsOn is set only through dependencies' };
    }
    if (update.metadata !== undefined) t.metadata = mergeNullDeletes(t.metadata, metadata);
    if (Object.keys(punchPatch).length > 0) t.metadata.punch = mergeNullDeletes(t.metadata.punch ?? {}, punchPatch);
    if (update.notes !== undefined) {
      const log = Array.isArray(t.metadata.noteLog) ? (t.metadata.noteLog as string[]) : [];
      t.metadata.noteLog = [...log, update.notes];
    }
    return { ok: true, task: structuredClone(this.view(t)) };
  }

  private liveLease(id: string): Lease | undefined {
    const lease = this.leases.get(id);
    if (!lease) return undefined;
    if (lease.expiresAt <= this.now()) {
      this.leases.delete(id);
      return undefined;
    }
    return lease;
  }

  private claimOf(lease: Lease): Claim {
    return { claimId: lease.claimId, expiresAt: new Date(lease.expiresAt).toISOString() };
  }

  private view(t: Task): Task {
    return { ...t, claimLive: this.liveLease(t.id) !== undefined };
  }
}

/** Shallow merge where an explicit null deletes the key (matches the server's punch/metadata merge). */
function mergeNullDeletes<T extends object>(base: T, patch: object): T {
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete out[k];
    else out[k] = v;
  }
  return out as T;
}
