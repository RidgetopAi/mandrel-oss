/**
 * deploymentVocabularyConfig — the DEPLOYMENT-SPECIFIC words the advertised tool surface uses.
 *
 * WHY THIS FILE EXISTS. Every hosted customer's `tools/list` used to carry
 * descriptions written for Riverbend's own deployment: the decision `question` said "what
 * The operator is answering", task_create told agents to tag `needs-operator` and report to the coordinator, and
 * the context_store `tags` description printed our `component:` roster (prod-mandrel,
 * coordinator-ui, …) and our `class:*` guard-class registry. Those are OUR names for OUR company;
 * a tenant or an OSS install must never be shown them.
 *
 * THE RULE. The words come from ONE place — here — with a NEUTRAL default. A deployment that
 * wants its own vocabulary says so with an env override; mandrelAI's own deployment sets
 * `MANDREL_DEPLOYMENT_VOCABULARY=riverbend` and its descriptions read exactly as before.
 *
 * ENV KEY (the only one): `MANDREL_DEPLOYMENT_VOCABULARY`
 *   - unset / empty            → NEUTRAL_DEPLOYMENT_VOCABULARY (the default)
 *   - `riverbend`             → RIVERBEND_DEPLOYMENT_VOCABULARY (today's wording)
 *   - a JSON object            → NEUTRAL with the named fields overridden (see the interface)
 *   - anything else / bad JSON → THROWS at load. A typo must not silently fall back to a
 *     vocabulary the operator did not choose (in either direction).
 *
 * SCOPE. This is DESCRIPTION vocabulary (and the matching needs-<human> tag the agent
 * fold-in guard enforces, so the description and the enforcement cannot disagree). It does
 * not change which lens-axis values the tag validator accepts — that closed set lives in
 * config/threadingVocabConfig.ts, which this file deliberately does not import (no cycle).
 */

export const DEPLOYMENT_VOCABULARY_ENV = 'MANDREL_DEPLOYMENT_VOCABULARY';

/** The preset name that selects today's Riverbend wording. */
export const RIVERBEND_PRESET_NAME = 'riverbend';

export interface DeploymentVocabulary {
  /** The human a decision/question is put to, as it reads in "what <X> is answering". */
  humanName: string;
  /** The agent-coordinator a sub-agent reports to, as it reads in "report it to <X>". */
  coordinatorName: string;
  /** The tag marking a task as needing the human's decision (the fold-in guard's exemption). */
  needsHumanTag: string;
  /**
   * True → the `component:` axis is advertised with its full enforced roster
   * (threadingVocabConfig.COMPONENT_VALUES); false → a neutral `component:<component>`.
   */
  listComponentValues: boolean;
  /** Same switch for the `class:` guard-class registry (GUARD_CLASS_VALUES). */
  listGuardClassValues: boolean;
  /** Actor names quoted as examples where the `actor:` axis is explained. Empty → none quoted. */
  actorNames: readonly string[];
}

/** The default: no deployment-specific word anywhere. What tenants and OSS installs get. */
export const NEUTRAL_DEPLOYMENT_VOCABULARY: DeploymentVocabulary = {
  humanName: 'the human decider',
  coordinatorName: 'your coordinator',
  needsHumanTag: 'needs-human',
  listComponentValues: false,
  listGuardClassValues: false,
  actorNames: ['builder', 'reviewer', 'tick'],
};

/** Riverbend's own deployment — today's wording, byte for byte. */
export const RIVERBEND_DEPLOYMENT_VOCABULARY: DeploymentVocabulary = {
  humanName: 'Operator',
  coordinatorName: 'Coordinator',
  needsHumanTag: 'needs-operator',
  listComponentValues: true,
  listGuardClassValues: true,
  actorNames: ['operator', 'coordinator', 'builder', 'reviewer', 'ops-bot', 'tick'],
};

const STRING_FIELDS = ['humanName', 'coordinatorName', 'needsHumanTag'] as const;
const BOOL_FIELDS = ['listComponentValues', 'listGuardClassValues'] as const;

/**
 * Resolve the vocabulary from a raw env value. Pure (the env read is a default argument, the
 * readProjectScopeGuardMode pattern) so a test can drive every branch without process.env.
 */
export function resolveDeploymentVocabulary(
  raw: string | undefined = process.env[DEPLOYMENT_VOCABULARY_ENV], // env-read: MANDREL_DEPLOYMENT_VOCABULARY
): DeploymentVocabulary {
  const text = (raw ?? '').trim();
  if (text === '') return NEUTRAL_DEPLOYMENT_VOCABULARY;
  if (text.toLowerCase() === RIVERBEND_PRESET_NAME) return RIVERBEND_DEPLOYMENT_VOCABULARY;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(
      `${DEPLOYMENT_VOCABULARY_ENV} must be "${RIVERBEND_PRESET_NAME}" or a JSON object; got an unparseable value`,
    );
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${DEPLOYMENT_VOCABULARY_ENV} JSON must be an object`);
  }
  const obj = parsed as Record<string, unknown>;
  const known = new Set<string>([...STRING_FIELDS, ...BOOL_FIELDS, 'actorNames']);
  for (const key of Object.keys(obj)) {
    if (!known.has(key)) {
      throw new Error(`${DEPLOYMENT_VOCABULARY_ENV}: unknown field "${key}" (known: ${[...known].join(', ')})`);
    }
  }
  const out: DeploymentVocabulary = { ...NEUTRAL_DEPLOYMENT_VOCABULARY };
  for (const f of STRING_FIELDS) {
    if (obj[f] === undefined) continue;
    if (typeof obj[f] !== 'string' || (obj[f] as string).trim() === '') {
      throw new Error(`${DEPLOYMENT_VOCABULARY_ENV}: "${f}" must be a non-empty string`);
    }
    out[f] = (obj[f] as string).trim();
  }
  for (const f of BOOL_FIELDS) {
    if (obj[f] === undefined) continue;
    if (typeof obj[f] !== 'boolean') throw new Error(`${DEPLOYMENT_VOCABULARY_ENV}: "${f}" must be a boolean`);
    out[f] = obj[f] as boolean;
  }
  if (obj.actorNames !== undefined) {
    if (!Array.isArray(obj.actorNames) || obj.actorNames.some(a => typeof a !== 'string' || a.trim() === '')) {
      throw new Error(`${DEPLOYMENT_VOCABULARY_ENV}: "actorNames" must be an array of non-empty strings`);
    }
    out.actorNames = (obj.actorNames as string[]).map(a => a.trim());
  }
  return out;
}

/** The vocabulary in force for this process (resolved once at load). */
export const DEPLOYMENT_VOCABULARY: DeploymentVocabulary = resolveDeploymentVocabulary();

/** The "what <human> is answering" sentence tail used by the decision `question` description. */
export function decisionQuestionDescription(v: DeploymentVocabulary = DEPLOYMENT_VOCABULARY): string {
  return `Required when answerStatus:"open" (else optional/ignored). The one sentence being decided — what ${v.humanName} is answering in seconds.`;
}

/** The task_create tool description, with the deployment's human / coordinator / tag. */
export function taskCreateDescription(v: DeploymentVocabulary = DEPLOYMENT_VOCABULARY): string {
  return (
    'Create a new task for agent coordination. Set `type` to the right kind (e.g. "bug", "feature") at creation time; task_update can re-classify it later. ' +
    'AGENTS: on deployments that list your actor in MANDREL_AGENT_ACTORS, a create is REFUSED with [TASK_CREATE_AGENT_FOLD_IN] ' +
    `unless tagged \`${v.needsHumanTag}\` — fold the finding into your lane or report it to ${v.coordinatorName} in your return; ` +
    `only an item needing ${possessive(v.humanName)} decision becomes a task.`
  );
}

function possessive(name: string): string {
  return name.endsWith('s') ? `${name}'` : `${name}'s`;
}

export { possessive as humanPossessive };
