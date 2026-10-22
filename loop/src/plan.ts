import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Board, Task } from './board.js';
import {
  APPLY_STAGE,
  CLAUDE_RUN_CONFIG,
  PLAN_CONFIG,
  PUNCH_SOURCE_MACHINE,
  REPO_TAG_PREFIX,
  SIZE_TAG_PREFIX,
} from './config.js';
import { parseClaudeResult, type CostSink } from './claudeRun.js';
import { formatViolation, lintPunches, type PlannedPunch } from './lint.js';
import { DEFAULT_LINT_CONFIG, type LintConfig } from './lint.config.js';

/** Thrown when `plan --apply` is handed punches that fail the authoring rules; nothing is created. */
export class LintRefusal extends Error {
  constructor(readonly violations: ReturnType<typeof lintPunches>) {
    super(`refusing to apply: ${violations.length} lint violation(s)\n${violations.map(formatViolation).join('\n')}`);
    this.name = 'LintRefusal';
  }
}

/** Creates every punch as a draft, resolving `dependsOnIndex` to the ids created earlier. No model call. */
export async function applyPunches(
  board: Board,
  punches: unknown,
  repoKeys: readonly string[],
  lintConfig: LintConfig = DEFAULT_LINT_CONFIG,
): Promise<Task[]> {
  const violations = lintPunches(punches, lintConfig, repoKeys);
  if (violations.length > 0) throw new LintRefusal(violations);
  const created: Task[] = [];
  for (const p of punches as PlannedPunch[]) {
    const repoTag = p.repo.startsWith(REPO_TAG_PREFIX) ? p.repo : `${REPO_TAG_PREFIX}${p.repo}`;
    created.push(
      await board.create({
        title: p.title,
        description: p.description,
        stage: APPLY_STAGE,
        tags: [repoTag, `${SIZE_TAG_PREFIX}${p.size}`],
        dependencies: p.dependsOnIndex.map((i) => created[i]!.id),
        punch: { doneWhen: p.doneWhen, proofKind: p.proofKind, source: PUNCH_SOURCE_MACHINE },
      }),
    );
  }
  return created;
}

/** Pulls the JSON array out of model output, tolerating a code fence or surrounding prose. */
export function extractJsonArray(output: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(output);
  const candidates = [output.trim(), fenced?.[1]?.trim() ?? ''];
  const start = output.indexOf('[');
  const end = output.lastIndexOf(']');
  if (start !== -1 && end > start) candidates.push(output.slice(start, end + 1));
  for (const c of candidates) {
    try {
      const v: unknown = JSON.parse(c);
      if (Array.isArray(v)) return v;
    } catch {
      /* try the next candidate */
    }
  }
  throw new Error('planner output contained no JSON array');
}

export type PlannerRunner = (prompt: string) => string;

/** Runs the configured claude binary with the prompt on stdin and returns its result text; the run's cost goes to `onCost`. */
export function claudeRunner(env: NodeJS.ProcessEnv = process.env, onCost?: CostSink): PlannerRunner {
  const bin = env[PLAN_CONFIG.binEnv] || PLAN_CONFIG.defaultBin;
  return (prompt) => {
    const r = spawnSync(bin, [...PLAN_CONFIG.args], {
      input: prompt,
      encoding: 'utf8',
      timeout: PLAN_CONFIG.timeoutMs,
      maxBuffer: PLAN_CONFIG.maxBufferBytes,
    });
    if (r.error) throw new Error(`could not run ${bin}: ${r.error.message}`);
    const result = parseClaudeResult(r.stdout ?? '');
    onCost?.(CLAUDE_RUN_CONFIG.roles.plan, CLAUDE_RUN_CONFIG.noPunch, result.costUsd);
    if (r.status !== 0) throw new Error(`${bin} exited ${r.status}: ${r.stderr.trim()}`);
    return result.text;
  };
}

export function readPlannerCard(): string {
  return readFileSync(fileURLToPath(new URL(`../${PLAN_CONFIG.cardPath}`, import.meta.url)), 'utf8');
}

/** The full planner prompt: card, the configured repo keys the `repo` field must come from, then the spec. */
export function buildPlannerPrompt(spec: string, repoKeys: readonly string[], card: string = readPlannerCard()): string {
  const repos =
    repoKeys.length === 1
      ? `The only configured repo key is \`${repoKeys[0]}\`. Every punch's "repo" MUST be exactly \`${repoKeys[0]}\`.`
      : `The configured repo keys are: ${repoKeys.map((k) => `\`${k}\``).join(', ')}. Every punch's "repo" MUST be exactly one of them.`;
  return `${card}\n\n---\n\n# CONFIGURED REPOS\n\n${repos} Never use a directory name or any other value.\n\n---\n\n# SPEC\n\n${spec}\n`;
}

/** Turns a spec into a punch list via the planner card. Not linted here — the caller lints. */
export function planFromSpec(
  spec: string,
  run: PlannerRunner,
  repoKeys: readonly string[],
  card: string = readPlannerCard(),
): unknown {
  return extractJsonArray(run(buildPlannerPrompt(spec, repoKeys, card)));
}
