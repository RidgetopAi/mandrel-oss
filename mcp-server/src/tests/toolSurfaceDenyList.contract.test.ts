/**
 * Hosted tool surface carries none of Riverbend's internal vocabulary.
 *
 * (1) DEFAULT config → the gateway tools/list (lazy AND full) and the flat definitions contain
 *     none of the deny-listed words, case-insensitive whole-word. Every offender is printed.
 * (2) MANDREL_DEPLOYMENT_VOCABULARY=riverbend → today's wording is back, so our own
 *     deployment is unchanged once the env is set.
 */
import { describe, test, expect, vi, afterEach } from 'vitest';

const DENY = ['Operator', 'Coordinator', 'prod-mandrel', 'coordinator-ui', 'needs-operator'];
const DENY_RE = new RegExp(`\\b(${DENY.map(w => w.replace(/-/g, '\\-')).join('|')})\\b`, 'i');

function offenders(v: unknown, path: string, out: string[]): void {
  if (typeof v === 'string') {
    const m = DENY_RE.exec(v);
    if (m) out.push(`${path} contains "${m[1]}"`);
  } else if (Array.isArray(v)) {
    v.forEach((x, i) => offenders(x, `${path}[${i}]`, out));
  } else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) offenders(x, `${path}.${k}`, out);
  }
}

async function loadSurfaces() {
  vi.resetModules();
  const { AIDIS_TOOL_DEFINITIONS } = await import('../config/toolDefinitions.js');
  const { buildGatewaySurface } = await import('../config/gatewaySurface.js');
  const named = (tools: any[], label: string) => tools.map(t => ({ label: `${label}:${t.name}`, t }));
  return [
    ...named(AIDIS_TOOL_DEFINITIONS as any[], 'flat'),
    ...named(buildGatewaySurface('lazy') as any[], 'gateway-lazy'),
    ...named(buildGatewaySurface('full') as any[], 'gateway-full'),
  ];
}

const textOf = (surfaces: { t: any }[]) => JSON.stringify(surfaces.map(s => s.t));

afterEach(() => {
  delete process.env.MANDREL_DEPLOYMENT_VOCABULARY;
});

describe('hosted tool surface deny-list (default config)', () => {
  test('no deployment vocabulary env → no internal word on any surface', async () => {
    delete process.env.MANDREL_DEPLOYMENT_VOCABULARY;
    const surfaces = await loadSurfaces();
    const bad: string[] = [];
    for (const s of surfaces) offenders(s.t, s.label, bad);
    expect(bad, `offending tool/field:\n${bad.join('\n')}`).toEqual([]);
  });

  test('default also hides the class:* registry and component roster', async () => {
    const text = textOf(await loadSurfaces());
    expect(text).not.toContain('guards-need-guarding');
    expect(text).not.toContain('fixture-vacuity');
    expect(text).not.toContain('mandrel-command|');
  });
});

describe('MANDREL_DEPLOYMENT_VOCABULARY=riverbend restores today\'s wording', () => {
  test('descriptions carry the Riverbend vocabulary', async () => {
    process.env.MANDREL_DEPLOYMENT_VOCABULARY = 'riverbend';
    const surfaces = await loadSurfaces();
    const text = textOf(surfaces);
    expect(text).toContain('what the operator is answering in seconds');
    expect(text).toContain('unless tagged `needs-operator`');
    expect(text).toContain('report it to the coordinator in your return');
    expect(text).toContain("only an item needing the operator's decision becomes a task");
    expect(text).toContain('component:prod-mandrel|mandrel-command|cockpit|coordinator-ui|');
    expect(text).toContain('class:backwards-belief-edge|');
  });

  test('task_create description is byte-identical to the pre-change literal', async () => {
    process.env.MANDREL_DEPLOYMENT_VOCABULARY = 'riverbend';
    const { taskCreateDescription, decisionQuestionDescription, resolveDeploymentVocabulary } =
      await import('../config/deploymentVocabularyConfig.js');
    const v = resolveDeploymentVocabulary();
    expect(taskCreateDescription(v)).toBe(
      'Create a new task for agent coordination. Set `type` to the right kind (e.g. "bug", "feature") at creation time; task_update can re-classify it later. AGENTS: on deployments that list your actor in MANDREL_AGENT_ACTORS, a create is REFUSED with [TASK_CREATE_AGENT_FOLD_IN] unless tagged `needs-operator` — fold the finding into your lane or report it to the coordinator in your return; only an item needing the operator\'s decision becomes a task.',
    );
    expect(decisionQuestionDescription(v)).toBe(
      'Required when answerStatus:"open" (else optional/ignored). The one sentence being decided — what the operator is answering in seconds.',
    );
  });
});

describe('resolveDeploymentVocabulary', () => {
  test('JSON override layers on the neutral default; bad input throws', async () => {
    const m = await import('../config/deploymentVocabularyConfig.js');
    expect(m.resolveDeploymentVocabulary(undefined)).toBe(m.NEUTRAL_DEPLOYMENT_VOCABULARY);
    expect(m.resolveDeploymentVocabulary('{"humanName":"Dana","needsHumanTag":"needs-dana"}')).toMatchObject({
      humanName: 'Dana',
      needsHumanTag: 'needs-dana',
      coordinatorName: m.NEUTRAL_DEPLOYMENT_VOCABULARY.coordinatorName,
    });
    expect(() => m.resolveDeploymentVocabulary('ridgtopai')).toThrow();
    expect(() => m.resolveDeploymentVocabulary('{"nope":1}')).toThrow(/unknown field/);
  });
});
