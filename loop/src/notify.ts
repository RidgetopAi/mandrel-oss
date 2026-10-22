import type { Board, Claim, NewTask, Outcome, Project, Stage, Task, TaskRow, TaskUpdate } from './board.js';
import { NOTIFY_CONFIG as N } from './config.js';
import type { LoopConfig } from './settings.js';

/** One stage transition, as written to stdout and POSTed to the webhook. */
export interface Transition {
  event: typeof N.event;
  at: string;
  id: string;
  title: string;
  from: Stage;
  to: Stage;
  note?: string;
}

/** A claim the board refused (wrong-status, held, ...). Callers treat it as skip-and-go-on; this makes it visible. */
export interface ClaimRefused {
  event: typeof N.claimRefusedEvent;
  at: string;
  id: string;
  reason: string;
  message?: string;
}

export interface NotifyDeps {
  out: (line: string) => void;
  err: (line: string) => void;
  env: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  now?: () => Date;
}

export type Notifier = (t: Transition | ClaimRefused) => Promise<void>;

/**
 * One JSON line per transition on stdout; the same object POSTed to the URL named by
 * `notify.webhookUrlEnv` when it is set. A webhook failure is logged and never thrown.
 */
export function makeNotifier(config: LoopConfig, deps: NotifyDeps): Notifier {
  const doFetch = deps.fetch ?? fetch;
  return async (t) => {
    deps.out(JSON.stringify(t));
    const urlEnv = config.notify.webhookUrlEnv;
    const url = urlEnv ? deps.env[urlEnv] : undefined;
    if (!url) return;
    try {
      const res = await doFetch(url, {
        method: 'POST',
        headers: N.webhookHeaders,
        body: JSON.stringify(t),
        signal: AbortSignal.timeout(N.webhookTimeoutMs),
      });
      if (!res.ok) deps.err(`notify: webhook answered ${res.status} for ${t.id}`);
    } catch (e) {
      deps.err(`notify: webhook failed for ${t.id}: ${(e as Error).message}`);
    }
  };
}

/** Wraps a board so every successful stage change is announced. Everything else passes through. */
export function notifyingBoard(inner: Board, notify: Notifier, now: () => Date = () => new Date()): Board {
  return {
    close: (): Promise<void> => inner.close(),
    listProjects: (): Promise<Project[]> => inner.listProjects(),
    listStage: (stage: Stage): Promise<TaskRow[]> => inner.listStage(stage),
    get: (id: string): Promise<Task | null> => inner.get(id),
    async claim(id: string, allowedStatuses?: readonly string[]): Promise<Outcome<Claim>> {
      const res = await inner.claim(id, allowedStatuses);
      if (!res.ok) {
        await notify({
          event: N.claimRefusedEvent,
          at: now().toISOString(),
          id,
          reason: res.reason,
          ...(res.message ? { message: res.message } : {}),
        });
      }
      return res;
    },
    renew: (id: string, claimId: string): Promise<Outcome<Claim>> => inner.renew(id, claimId),
    release: (id: string, claimId: string): Promise<Outcome<object>> => inner.release(id, claimId),
    create: (task: NewTask): Promise<Task> => inner.create(task),
    async update(id: string, update: TaskUpdate, claimId: string): Promise<Outcome<{ task: Task }>> {
      const before = update.stage === undefined ? null : await inner.get(id);
      const res = await inner.update(id, update, claimId);
      if (res.ok && before && update.stage !== undefined && before.stage !== res.task.stage) {
        await notify({
          event: N.event,
          at: now().toISOString(),
          id,
          title: res.task.title,
          from: before.stage,
          to: res.task.stage,
          ...(update.notes ? { note: update.notes } : {}),
        });
      }
      return res;
    },
  };
}
