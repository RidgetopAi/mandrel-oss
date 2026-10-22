import {
  PROOF_REQUIRED_OWNER,
  PROOF_WALKTHROUGH_LITERAL,
  PUNCH_CLAUSE_OWNERS,
  PUNCH_PROOF_KINDS,
  PUNCH_SIZES,
  CRITIC_CONFIG,
  REPO_TAG_PREFIX,
} from './config.js';
import { DEFAULT_LINT_CONFIG, type LintConfig } from './lint.config.js';
import type { ClauseOwner, ProofKind } from './board.js';

/** One planned punch, as `plan` writes it and `plan --apply` reads it. */
export interface PlannedClause {
  text: string;
  owner: ClauseOwner;
  proof?: string;
}

export interface PlannedPunch {
  title: string;
  description: string;
  size: string;
  repo: string;
  dependsOnIndex: number[];
  doneWhen: PlannedClause[];
  proofKind: ProofKind;
  /** Optional repo-relative paths this punch creates or edits. */
  touches?: string[];
}

export type LintRule =
  | 'shape'
  | 'unknown-repo'
  | 'missing-proof'
  | 'banned-word'
  | 'rooted-path'
  | 'process-phrase'
  | 'non-relative-proof'
  | 'dependency'
  | 'proof-created-later';

export interface Violation {
  /** Zero-based index into the punches array. */
  punch: number;
  /** Zero-based index into the punch's doneWhen, or null for a punch-level offence. */
  clause: number | null;
  rule: LintRule;
  message: string;
}

export function formatViolation(v: Violation): string {
  const where = v.clause === null ? `punch ${v.punch}` : `punch ${v.punch} clause ${v.clause}`;
  return `${where}: [${v.rule}] ${v.message}`;
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

function rootedPathRe(roots: readonly string[]): RegExp {
  const alt = roots.map(escapeRe).join('|');
  // a configured top-level directory not glued to a preceding word/path char, `~/...`, or a Windows drive path.
  return new RegExp(`(?<![\\w./:~-])(?:/(?:${alt})(?![\\w-])[\\w./-]*|~/[\\w./-]+)|\\b[A-Za-z]:\\\\`);
}

function isRepoRelative(proof: string): boolean {
  if (proof.startsWith('/') || proof.startsWith('~') || proof.startsWith('\\')) return false;
  if (/^[A-Za-z]:[\\/]/.test(proof) || /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(proof)) return false;
  return !proof.split(/[\\/]/).includes('..');
}

function lintClause(punch: number, clause: number, c: unknown, cfg: LintConfig, out: Violation[]): void {
  const add = (rule: LintRule, message: string): void => void out.push({ punch, clause, rule, message });
  if (typeof c !== 'object' || c === null) return add('shape', 'clause is not an object');
  const { text, owner, proof } = c as Record<string, unknown>;
  if (!nonEmpty(text)) add('shape', 'clause text is empty');
  if (!(PUNCH_CLAUSE_OWNERS as readonly unknown[]).includes(owner)) {
    add('shape', `owner must be one of ${PUNCH_CLAUSE_OWNERS.join(', ')}`);
  }
  if (owner === PROOF_REQUIRED_OWNER && !nonEmpty(proof)) {
    add('missing-proof', `owner:${PROOF_REQUIRED_OWNER} clause has no proof`);
  }
  if (proof !== undefined && proof !== null) {
    if (!nonEmpty(proof)) add('non-relative-proof', 'proof is empty');
    else if (proof !== PROOF_WALKTHROUGH_LITERAL && !isRepoRelative(proof)) {
      add('non-relative-proof', `proof "${proof}" is not repo-relative and not the walkthrough literal`);
    }
  }
  if (!nonEmpty(text)) return;
  for (const word of cfg.bannedWords) {
    if (new RegExp(`(?<![\\w-])${escapeRe(word)}(?![\\w-])`, 'i').test(text)) {
      add('banned-word', `text contains banned word "${word}"`);
    }
  }
  const path = rootedPathRe(cfg.rootedPathRoots).exec(text);
  if (path) add('rooted-path', `text contains rooted path "${path[0]}"`);
  const lower = text.toLowerCase();
  for (const phrase of cfg.processClaimPhrases) {
    if (lower.includes(phrase.toLowerCase())) add('process-phrase', `text contains process claim "${phrase}"`);
  }
}

function lintPunch(i: number, p: unknown, cfg: LintConfig, repoKeys: readonly string[] | undefined, out: Violation[]): void {
  const add = (rule: LintRule, message: string): void => void out.push({ punch: i, clause: null, rule, message });
  if (typeof p !== 'object' || p === null || Array.isArray(p)) return add('shape', 'punch is not an object');
  const e = p as Record<string, unknown>;
  for (const key of ['title', 'description', 'repo'] as const) {
    if (!nonEmpty(e[key])) add('shape', `${key} must be a non-empty string`);
  }
  if (repoKeys !== undefined && nonEmpty(e.repo)) {
    const key = e.repo.startsWith(REPO_TAG_PREFIX) ? e.repo.slice(REPO_TAG_PREFIX.length) : e.repo;
    if (!repoKeys.includes(key)) {
      const title = nonEmpty(e.title) ? ` "${e.title}"` : '';
      const valid = repoKeys.length === 0 ? 'the config declares no repos' : `valid repos: ${repoKeys.join(', ')}`;
      add('unknown-repo', `punch${title} names repo "${e.repo}", which is not a key in the config's repos (${valid})`);
    }
  }
  if (!(PUNCH_SIZES as readonly unknown[]).includes(e.size)) add('shape', `size must be one of ${PUNCH_SIZES.join(', ')}`);
  if (!(PUNCH_PROOF_KINDS as readonly unknown[]).includes(e.proofKind)) {
    add('shape', `proofKind must be one of ${PUNCH_PROOF_KINDS.join(', ')}`);
  }
  const deps = e.dependsOnIndex;
  if (!Array.isArray(deps)) add('dependency', 'dependsOnIndex must be an array');
  else {
    for (const d of deps) {
      if (!Number.isInteger(d) || (d as number) < 0 || (d as number) >= i) {
        add('dependency', `dependsOnIndex ${String(d)} must name an earlier punch (0..${i - 1})`);
      }
    }
  }
  if (!Array.isArray(e.doneWhen) || e.doneWhen.length === 0) return add('shape', 'doneWhen must be a non-empty array');
  e.doneWhen.forEach((c, ci) => lintClause(i, ci, c, cfg, out));
}

/**
 * Applies the authoring rules to a parsed punches.json; an empty result means clean.
 * When `repoKeys` is given (the keys of the config's `repos`), a punch naming any other repo is a violation.
 */
export function lintPunches(
  punches: unknown,
  cfg: LintConfig = DEFAULT_LINT_CONFIG,
  repoKeys?: readonly string[],
): Violation[] {
  const out: Violation[] = [];
  if (!Array.isArray(punches)) {
    return [{ punch: 0, clause: null, rule: 'shape', message: 'punches.json must be an array' }];
  }
  if (punches.length === 0) {
    return [{ punch: 0, clause: null, rule: 'shape', message: 'punches.json is empty' }];
  }
  punches.forEach((p, i) => lintPunch(i, p, cfg, repoKeys, out));
  lintProofOrdering(punches, out);
  return out;
}

/** Text in a punch that declares which paths it creates: its description plus any `touches` entries. */
function creationText(p: unknown): string {
  if (typeof p !== 'object' || p === null) return '';
  const { description, touches } = p as Record<string, unknown>;
  const parts: string[] = [];
  if (typeof description === 'string') parts.push(description);
  if (Array.isArray(touches)) parts.push(...touches.filter((t): t is string => typeof t === 'string'));
  return parts.join('\n');
}

/**
 * Cross-punch rule: a lane proof path that no punch at or before the citing one creates, but a later punch does,
 * cannot exist when the citing punch is verified.
 */
function lintProofOrdering(punches: unknown[], out: Violation[]): void {
  const created = punches.map(creationText);
  punches.forEach((p, i) => {
    const doneWhen = (p as Record<string, unknown> | null)?.doneWhen;
    if (!Array.isArray(doneWhen)) return;
    doneWhen.forEach((c, ci) => {
      const proof = (c as Record<string, unknown> | null)?.proof;
      if (!nonEmpty(proof) || proof === PROOF_WALKTHROUGH_LITERAL || !isRepoRelative(proof)) return;
      if (created.slice(0, i + 1).some((t) => t.includes(proof))) return;
      const later = created.findIndex((t, j) => j > i && t.includes(proof));
      if (later === -1) return;
      out.push({
        punch: i,
        clause: ci,
        rule: 'proof-created-later',
        message: `proof "${proof}" is only created by punch ${later}, which comes after punch ${i}; keep the code and its test in one punch`,
      });
    });
  });
}

/** A non-fatal authoring note: `lint` prints it but its exit status is unchanged. */
export interface LintWarning {
  punch: number;
  rule: 'missing-mutation-clause';
  message: string;
}

export function formatWarning(w: LintWarning): string {
  return `punch ${w.punch}: warning [${w.rule}] ${w.message}`;
}

/** Warns on every test-proof punch with no clause containing the critic's mutation-clause text. */
export function lintWarnings(punches: unknown): LintWarning[] {
  if (!Array.isArray(punches)) return [];
  const marker = CRITIC_CONFIG.mutationClauseText;
  const out: LintWarning[] = [];
  punches.forEach((p, punch) => {
    if (typeof p !== 'object' || p === null) return;
    const { proofKind, doneWhen } = p as Record<string, unknown>;
    if (proofKind !== 'test' || !Array.isArray(doneWhen)) return;
    const has = doneWhen.some((c) => typeof (c as Record<string, unknown> | null)?.text === 'string' && ((c as { text: string }).text).includes(marker));
    if (!has) {
      out.push({
        punch,
        rule: 'missing-mutation-clause',
        message: `test-proof punch has no "${marker}: <mutation>; <mutation>. Unmutated control GREEN." clause`,
      });
    }
  });
  return out;
}
