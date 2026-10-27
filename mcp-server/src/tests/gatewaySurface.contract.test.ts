/**
 * GATEWAY SURFACE + `discover` contract — MCP-2026 rebuild PHASE 2.
 *
 * DB-free, deterministic guards for the DARK gateway machinery (plan §1–§3, §9):
 *   1. LEGACY BYTE-IDENTITY  — at surface=legacy (the DEFAULT), buildAdvertisedTools is the exact
 *      67-tool flat surface (the byte-identity guard the whole "dark" invariant rests on).
 *   2. 67/67 PARITY          — every one of the 67 registry ops is reachable BOTH via a
 *      (gateway,action) resolution AND via its flat name in the routeExecutor switch; the reverse
 *      (no dangling resolver entry) also holds; and the resolver agrees with the §2 mapping table.
 *   3. STRICT-KEY PER BRANCH — an undeclared key on a gateway branch is rejected with an
 *      actionable message that names discover.explain (one branch per CRUD gateway).
 *   4. GATEWAY SURFACE SHAPE — surface=gateway lazy = 7 gateway envelopes + 3 flat tools, each
 *      gateway a minimal honest `{action:{enum}}` envelope with additionalProperties:true and NO
 *      outputSchema; full mode = whole-tool oneOf.
 *   5. DISCOVER              — catalog covers every op; explain(one op) + explain(whole tool, oneOf)
 *      + the whole-tool outputSchema oneOf; unknown action/tool → actionable error.
 *
 * The mutation-probe for the ACTION-gate (risk a) and the token-meter (o200k_base) live in their
 * own files (gatewayActionGate / gatewayTokenMeter) because they need a DB / the tokenizer.
 */

import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { OP_REGISTRY, ALL_OP_IDS, OP_BY_ID } from '../config/opRegistry.js';
import { AIDIS_TOOL_DEFINITIONS } from '../config/toolDefinitions.js';
import { buildAdvertisedTools } from '../server/registerMcpHandlers.js';
import {
  resolveGatewayAction,
  actionsForGateway,
  FLAT_OP_IDS,
  allGatewayActionKeys,
} from '../config/gatewayResolver.js';
import {
  GATEWAY_ORDER,
  WRITE_ACTIONS,
  IDENTIFIER_PARAMS,
  UNGUESSABLE_READ_ACTIONS,
} from '../config/gatewayConfig.js';
import { buildInputSchema } from '../config/toolDefinitions.js';
import { dispatchGateway } from '../routes/gateway.js';
import { dispatchDiscover } from '../handlers/discover.js';

const here = dirname(fileURLToPath(import.meta.url));
const ROUTES_INDEX = resolve(here, '../routes/index.ts');

function textOf(resp: any): string {
  return resp?.content?.map((c: any) => c.text).join('\n') ?? '';
}

// ───────────────────────── 1. LEGACY BYTE-IDENTITY ─────────────────────────
describe('legacy surface is byte-identical to HEAD (the dark invariant)', () => {
  test('surface=legacy (default) advertises exactly the 67-tool flat definitions', () => {
    const legacy = buildAdvertisedTools(true, 'legacy');
    expect(JSON.stringify({ tools: legacy })).toBe(JSON.stringify({ tools: AIDIS_TOOL_DEFINITIONS }));
    // 54 -> 57 with the atomic task claim: task_claim/renew/release.
    // 57 -> 58 with the first-class artifact reference: context_artifact.
    // 58 -> 60 with the session IDENTITY read model: session_list/session_get.
    // 60 -> 63 with PHASE 1 positional membership: branch_open /
    // branch_current / branch_close (thread_* stay as deprecated delegating aliases).
    // 63 -> 64 with WS2 living summary: project_briefing.
    // 64 -> 65 with SK2: branch_history — read a branch's members back
    // after it is closed (a READ; the other three branch tools are unchanged).
    // 65 -> 67 with P3: branch_assign / branch_unassign — membership stops
    // being write-once, and both are WRITES that append to branch_membership_moves.
    // 67 -> 68 with P4 L1: mandrel_contract — discover({action:'contract'}).
    // 68 -> 69 with reproject: project_move_record —
    // project({action:'move'}), a WRITE that moves a record between projects.
    // 69 -> 70 with the tag census: project_tags — project({action:'tags'}),
    // a READ that enumerates which tag values exist and how many records carry each.
    // 70 -> 72 with the decision inbox:
    // decision_answer / decision_discuss.
    // 72 -> 67: the five code-scan ops removed.
    expect(legacy).toHaveLength(67);
  });

  test('the module default (no surface arg) is the legacy surface', () => {
    // getToolSurface() must default to legacy in a clean env (no MANDREL_TOOL_SURFACE set).
    delete process.env.MANDREL_TOOL_SURFACE;
    expect(JSON.stringify(buildAdvertisedTools())).toBe(JSON.stringify(AIDIS_TOOL_DEFINITIONS));
  });
});

// ───────────────────────── 2. 67/67 PARITY ─────────────────────────
describe('67/67 parity — every op reachable via BOTH the gateway path and the flat name', () => {
  const routesSrc = readFileSync(ROUTES_INDEX, 'utf8');

  test('every registry op resolves via its (gateway,action) — flat ops resolve as flat', () => {
    for (const op of OP_REGISTRY) {
      if (op.kind === 'flat') {
        expect(FLAT_OP_IDS, `flat op '${op.opId}' should be advertised flat`).toContain(op.opId);
        continue;
      }
      if (op.gatewayActions) {
        // session_pin: reachable via EACH sub-action; the base action is NOT a discriminator.
        for (const [gatewayAction, nested] of Object.entries(op.gatewayActions)) {
          const res = resolveGatewayAction(op.gateway, gatewayAction);
          expect(res, `${op.gateway}.${gatewayAction} did not resolve`).toBeDefined();
          expect(res!.opId).toBe(op.opId);
          expect(res!.nestedAction).toBe(nested);
        }
      } else {
        const res = resolveGatewayAction(op.gateway, op.action as string);
        expect(res, `${op.gateway}.${op.action} did not resolve`).toBeDefined();
        expect(res!.opId).toBe(op.opId);
      }
    }
  });

  test('every registry op has a `case ` in the routeExecutor switch (flat-name reachability)', () => {
    for (const opId of ALL_OP_IDS) {
      expect(
        routesSrc.includes(`case '${opId}':`),
        `routeExecutor switch is missing 'case ${opId}:' — flat name unreachable`,
      ).toBe(true);
    }
  });

  test('no dangling resolver entry — every (gateway,action) key points at a real op', () => {
    for (const key of allGatewayActionKeys()) {
      const [gateway, action] = key.split('.');
      const res = resolveGatewayAction(gateway, action)!;
      expect(OP_BY_ID.has(res.opId), `resolver key '${key}' → unknown op '${res.opId}'`).toBe(true);
    }
    // Total resolvable keys = (gateway ops, expanding session_pin's 3 sub-actions).
    const expected = OP_REGISTRY.filter((o) => o.kind === 'gateway').reduce(
      (n, o) => n + (o.gatewayActions ? Object.keys(o.gatewayActions).length : 1),
      0,
    );
    expect(allGatewayActionKeys()).toHaveLength(expected);
  });

  test('the resolver agrees with the §2 old→new mapping in the registry', () => {
    for (const op of OP_REGISTRY) {
      const mapped = op.kind === 'flat' ? 'FLAT' : `${op.gateway}.${op.action}`;
      if (op.kind === 'flat') {
        expect(mapped).toBe('FLAT');
      } else if (op.gatewayActions) {
        // covered by the sub-action resolution above; assert the base gateway is a known gateway.
        expect(GATEWAY_ORDER).toContain(op.gateway);
      } else {
        expect(resolveGatewayAction(op.gateway, op.action as string)!.opId).toBe(op.opId);
      }
    }
    // 60 -> 63: PHASE 1 positional membership.
    // 63 -> 64: WS2 living summary: project_briefing.
    // 64 -> 65: SK2: branch_history.
    // 65 -> 67: P3: branch_assign / branch_unassign.
    // 67 -> 68: P4 L1: mandrel_contract.
    // 68 -> 69: reproject: project_move_record.
    // 69 -> 70: the tag census: project_tags.
    // 70 -> 72: the decision inbox:
    // decision_answer / decision_discuss.
    // 72 -> 67: the five code-scan ops removed.
    expect(ALL_OP_IDS).toHaveLength(67);
  });
});

// ───────────────────────── 3. STRICT-KEY PER BRANCH ─────────────────────────
describe('strict-key per branch — undeclared keys rejected, actionable, name discover.explain', () => {
  // One PASSIVE branch per CRUD gateway (passive → no session side effects → DB-free: the
  // strict-key rejection fires in validateToolArguments BEFORE any routeExecutor delegation).
  const cases: Array<[string, Record<string, any>]> = [
    ['context', { action: 'update', id: '12345678', bogusKey: 1 }],
    ['task', { action: 'update', id: '12345678', bogusKey: 1 }],
    ['decision', { action: 'update', id: '12345678', bogusKey: 1 }],
    ['project', { action: 'update', project: 'x', bogusKey: 1 }],
  ];

  for (const [gateway, args] of cases) {
    test(`${gateway}.${args.action}: undeclared 'bogusKey' → actionable error naming discover.explain`, async () => {
      const resp = await dispatchGateway(gateway, args);
      expect(resp.isError).toBe(true);
      const text = textOf(resp);
      expect(text).toMatch(/bogusKey/);
      expect(text).toContain('discover.explain');
    });
  }

  test('missing action discriminator → actionable error listing valid actions + discover', async () => {
    const resp = await dispatchGateway('context', {});
    expect(resp.isError).toBe(true);
    const text = textOf(resp);
    expect(text).toMatch(/action/i);
    expect(text).toContain('discover.explain');
  });

  test('unknown action → actionable error listing valid actions', async () => {
    const resp = await dispatchGateway('context', { action: 'frobnicate' });
    expect(resp.isError).toBe(true);
    expect(textOf(resp)).toContain('store'); // a real context action is listed
  });
});

// ───────────────────────── 4. GATEWAY SURFACE SHAPE ─────────────────────────
describe('gateway surface shape (surface=gateway)', () => {
  test('lazy = 7 gateway envelopes + 3 flat tools, honest envelopes (action first), no outputSchema', () => {
    const tools = buildAdvertisedTools(true, 'gateway', 'lazy');
    expect(tools).toHaveLength(10);
    const names = tools.map((t) => t.name);
    expect(names.slice(0, 7)).toEqual([...GATEWAY_ORDER]);
    expect(names.slice(7)).toEqual(['recall_thread', 'smart_search', 'get_recommendations']);

    for (const gw of GATEWAY_ORDER) {
      const t = tools.find((x) => x.name === gw)!;
      const props = t.inputSchema.properties as any;
      // `action` is ALWAYS the first prop (the discriminator); lazy+core MAY add required-param
      // hints after it, but the top-level `required` stays JUST the discriminator.
      expect(Object.keys(props)[0]).toBe('action');
      expect(props.action.enum).toEqual([...actionsForGateway(gw)]);
      expect(t.inputSchema.required).toEqual(['action']);
      expect(t.inputSchema.additionalProperties).toBe(true);
      expect('outputSchema' in t).toBe(false); // §1.2 — never on the lazy list
    }

    // Gateways with NO un-guessable WRITE contract (discover=all reads; session start/end/pin_*
    // take no un-guessable required param) stay a PURE {action} envelope — nothing over-lifted.
    for (const gw of ['discover', 'session'] as const) {
      const props = tools.find((x) => x.name === gw)!.inputSchema.properties as any;
      expect(Object.keys(props)).toEqual(['action']);
    }
  });

  test('full mode = whole-tool action-discriminated oneOf per gateway', () => {
    const tools = buildAdvertisedTools(true, 'gateway', 'full');
    for (const gw of GATEWAY_ORDER) {
      const t = tools.find((x) => x.name === gw)!;
      const oneOf = (t.inputSchema as any).oneOf as any[];
      expect(Array.isArray(oneOf)).toBe(true);
      expect(oneOf).toHaveLength(actionsForGateway(gw).length);
      // Every branch pins its action const + is strict.
      for (const branch of oneOf) {
        expect(branch.properties.action.const).toBeDefined();
        expect(branch.additionalProperties).toBe(false);
      }
    }
  });

  test('every gateway advertises a non-empty search-optimized description', () => {
    const tools = buildAdvertisedTools(true, 'gateway', 'lazy');
    for (const gw of GATEWAY_ORDER) {
      const t = tools.find((x) => x.name === gw)!;
      expect(typeof t.description).toBe('string');
      expect(t.description.length).toBeGreaterThan(20);
    }
  });
});

// ──────────── 4b. LAZY+CORE required-param hints (Phase 3) ────────────
describe('lazy+core: registry-derived required-param hints on un-guessable write gateways', () => {
  const lazy = buildAdvertisedTools(true, 'gateway', 'lazy');
  const propsOf = (gw: string) =>
    (lazy.find((t) => t.name === gw)!.inputSchema.properties as Record<string, any>);

  test('context lazy envelope advertises store\'s required `content` + the ContextType enum as schema-props', () => {
    const p = propsOf('context');
    expect(p.content).toBeDefined();
    expect(p.content.description).toMatch(/REQUIRED for action:store/);
    expect(Array.isArray(p.type?.enum)).toBe(true); // the enum is a real schema-prop, not prose
    expect(p.type.enum).toContain('code'); // an actual ContextType value, inline
    expect(p.type.description).toMatch(/REQUIRED for action:store/);
  });

  test('decision lazy envelope lifts record\'s 5 required names; small enum inlined, 15-value decisionType is NAME-only', () => {
    const p = propsOf('decision');
    for (const name of ['decisionType', 'title', 'description', 'rationale', 'impactLevel']) {
      expect(p[name], `decision.record required '${name}' not lifted`).toBeDefined();
      expect(p[name].description).toMatch(/REQUIRED for action:record/);
    }
    expect(p.impactLevel.enum).toEqual(['low', 'medium', 'high', 'critical']); // ≤ max → inlined
    expect(p.decisionType.enum).toBeUndefined(); // 15 values > max → name-only (budget discipline)
  });

  test('graph lazy envelope inlines the edgeType enum and MERGES the actions requiring it', () => {
    const p = propsOf('graph');
    expect(p.edgeType?.enum).toContain('decided_by');
    // edgeType is required by BOTH link and unlink → one merged prop naming both actions.
    expect(p.edgeType.description).toMatch(/action:link/);
    expect(p.edgeType.description).toMatch(/action:unlink/);
    expect(p.fromType?.enum).toEqual(['context', 'decision', 'task']);
  });

  test('guessable/optional params are NOT lifted — only UN-GUESSABLE required write params', () => {
    const c = propsOf('context');
    // store's optional params stay lazy (one discover.explain away)
    for (const opt of ['tags', 'metadata', 'relevanceScore', 'links', 'projectId', 'sessionId']) {
      expect(c[opt], `optional '${opt}' must NOT be lifted`).toBeUndefined();
    }
    // id-only writes (update/delete/switch/bulk_update/cancel) contribute nothing.
    expect(propsOf('task').taskId).toBeUndefined();
    expect(propsOf('task').status).toBeUndefined(); // task.update status is optional → not lifted
    expect(propsOf('project').project).toBeUndefined(); // switch/update/delete require only id-like project
    // graph's guessable link endpoints (from/to are identifiers) STAY lazy per rule (3).
    expect(propsOf('graph').from).toBeUndefined();
    expect(propsOf('graph').to).toBeUndefined();
  });

  test('lazy+core stays REGISTRY-DERIVED: every lifted prop is a required param of a full-mode branch, enums agree (no drift)', () => {
    const full = buildAdvertisedTools(true, 'gateway', 'full');
    for (const gw of GATEWAY_ORDER) {
      const lazyProps = propsOf(gw);
      const oneOf = (full.find((t) => t.name === gw)!.inputSchema as any).oneOf as any[];
      for (const [name, lp] of Object.entries(lazyProps)) {
        if (name === 'action') continue;
        // The lifted param must be REQUIRED in ≥1 full-mode branch (the real per-branch contract).
        const branches = oneOf.filter((b) => (b.required ?? []).includes(name));
        expect(branches.length, `${gw}.${name} lifted but required in no full branch`).toBeGreaterThan(0);
        // If lazy inlined an enum, it must be byte-equal to the full branch's enum (single source).
        if (Array.isArray((lp as any).enum)) {
          expect(branches[0].properties[name].enum).toEqual((lp as any).enum);
        }
      }
    }
  });
});

// ──────── 4c. LAZY+CORE COMPLETENESS — no un-guessable action escapes ────────
/**
 * The inverse of the §4b drift guard (fail-closed). §4b proves NO OVER-LIFT (every
 * lifted prop is required in a full-mode branch); this section proves NO UNDER-LIFT: every
 * gateway action whose required params include ≥1 un-guessable name is ACCOUNTED FOR —
 *   - classified WRITE (WRITE_ACTIONS)            ⇒ lifted, asserted on the advertised wire, or
 *   - classified excused READ (UNGUESSABLE_READ_ACTIONS) ⇒ deliberately lazy,
 *   - in NEITHER (a novel verb like archive/publish)     ⇒ RED, never a silent coverage hole.
 * Anchored on the choke point every action passes through (the resolver key set + the SAME
 * buildInputSchema/IDENTIFIER_PARAMS derivation liftCoreParams uses), so a new registry op
 * cannot enter the surface unclassified. The 3 flat headline tools are OUT of this class by
 * construction: their lazy form advertises the full zod-derived schema, nothing is deferred.
 */
describe('lazy+core completeness: every un-guessable action is lifted or explicitly excused (fail-closed)', () => {
  const lazy = buildAdvertisedTools(true, 'gateway', 'lazy');
  const propsOf = (gw: string) =>
    (lazy.find((t) => t.name === gw)!.inputSchema.properties as Record<string, any>);

  /** Every (gateway,action) with its un-guessable required params, derived exactly like liftCoreParams. */
  function unguessableByKey(): Map<string, string[]> {
    const out = new Map<string, string[]>();
    for (const key of allGatewayActionKeys()) {
      const [gateway, action] = key.split('.');
      const res = resolveGatewayAction(gateway, action)!;
      const base = buildInputSchema(res.opId as any, {});
      const required = (base.required ?? []).filter((k) => k !== 'action');
      const unguessable = required.filter((k) => !IDENTIFIER_PARAMS.has(k));
      if (unguessable.length > 0) out.set(key, unguessable);
    }
    return out;
  }

  test('every action with an un-guessable required param is classified; classified WRITES are lifted on the wire', () => {
    const inClass = unguessableByKey();
    // Fail-loud floor: the derivation pipeline itself must be alive. If buildInputSchema stopped
    // reporting `required` (or IDENTIFIER_PARAMS swallowed everything) this guard would pass
    // VACUOUSLY — anchor one known write and one known excused read so an empty class is RED.
    expect(inClass.has('context.store'), 'derivation broken: context.store not in class').toBe(true);
    expect(inClass.has('discover.explain'), 'derivation broken: discover.explain not in class').toBe(true);

    for (const [key, unguessable] of inClass) {
      const [gateway, action] = key.split('.');
      if (WRITE_ACTIONS.has(action)) {
        // A write with an un-guessable contract MUST be lifted — verified on the ADVERTISED lazy
        // surface (the wire), not by re-running liftCoreParams against itself.
        const props = propsOf(gateway);
        for (const name of unguessable) {
          expect(
            props[name],
            `${key}: un-guessable required '${name}' is MISSING from the lazy+core envelope — write action not lifted`,
          ).toBeDefined();
          // Description format is `REQUIRED for action:a, action:b.` — match this action exactly
          // (delimiter-bounded so e.g. action:link never matches inside action:unlink).
          expect(
            props[name].description,
            `${key}: lifted '${name}' does not name action:${action} as requiring it`,
          ).toMatch(new RegExp(`action:${action}(,|\\.)`));
        }
      } else {
        expect(
          UNGUESSABLE_READ_ACTIONS.has(action),
          `${key} requires un-guessable [${unguessable.join(', ')}] but verb '${action}' is in NEITHER ` +
            `WRITE_ACTIONS nor UNGUESSABLE_READ_ACTIONS — classify the new verb (lift it or excuse it) ` +
            `in gatewayConfig.ts`,
        ).toBe(true);
      }
    }
  });

  test('the two classification vocabularies are disjoint — a verb cannot be write AND excused read', () => {
    for (const verb of UNGUESSABLE_READ_ACTIONS) {
      expect(
        WRITE_ACTIONS.has(verb),
        `'${verb}' is in BOTH WRITE_ACTIONS and UNGUESSABLE_READ_ACTIONS — ambiguous classification`,
      ).toBe(false);
    }
  });

  test('no dead excuses — every UNGUESSABLE_READ_ACTIONS verb matches a live un-guessable registry action', () => {
    // A stale entry (its op removed/renamed) would silently pre-excuse a FUTURE action reusing the
    // verb — exactly the allow-list rot a past incident warns about. Excuses must stay live or go RED.
    const inClass = unguessableByKey();
    for (const verb of UNGUESSABLE_READ_ACTIONS) {
      const live = [...inClass.keys()].some((key) => key.split('.')[1] === verb);
      expect(
        live,
        `excused verb '${verb}' matches no current registry action with un-guessable required params — remove the dead excuse`,
      ).toBe(true);
    }
  });
});

// ───────────────────────── 5. DISCOVER ─────────────────────────
describe('discover', () => {
  test('catalog covers every gateway + flat tool and lists actions', async () => {
    const resp = await dispatchDiscover({ action: 'catalog' });
    const sc: any = resp.structuredContent;
    expect(sc.ok).toBe(true);
    // Every gateway present with its full action list.
    for (const gw of GATEWAY_ORDER) {
      const g = sc.gateways.find((x: any) => x.tool === gw);
      expect(g, `catalog missing gateway ${gw}`).toBeDefined();
      expect(g.actions.map((a: any) => a.action)).toEqual([...actionsForGateway(gw)]);
    }
    // The 3 flat tools present.
    expect(sc.flat.map((f: any) => f.tool).sort()).toEqual(
      ['get_recommendations', 'recall_thread', 'smart_search'],
    );
  });

  test('catalog query filter narrows the result', async () => {
    const resp = await dispatchDiscover({ action: 'catalog', query: 'graph' });
    const sc: any = resp.structuredContent;
    const tools = sc.gateways.map((g: any) => g.tool);
    expect(tools).toContain('graph');
    // A gateway with no matching action/description drops out.
    expect(sc.gateways.every((g: any) => g.actions.length > 0 || /graph/i.test(g.tool + g.description))).toBe(true);
  });

  test('explain(one op) returns the full branch input + output schema', async () => {
    const resp = await dispatchDiscover({ action: 'explain', tool: 'context', op: 'store' });
    const sc: any = resp.structuredContent;
    expect(sc.ok).toBe(true);
    expect(sc.inputSchema.properties.action.const).toBe('store');
    expect(sc.inputSchema.properties.content).toBeDefined(); // real op param surfaced
    expect(sc.inputSchema.additionalProperties).toBe(false);
    expect(sc.outputSchema).toBeDefined();
  });

  test('explain(whole tool) walks the oneOf branches (input + output oneOf)', async () => {
    const resp = await dispatchDiscover({ action: 'explain', tool: 'context' });
    const sc: any = resp.structuredContent;
    expect(sc.inputSchema.oneOf).toHaveLength(actionsForGateway('context').length);
    expect(sc.outputSchema.oneOf).toHaveLength(actionsForGateway('context').length);
  });

  test('explain session pin_set hides the nested action param (flattened discriminator)', async () => {
    const resp = await dispatchDiscover({ action: 'explain', tool: 'session', op: 'pin_set' });
    const sc: any = resp.structuredContent;
    expect(sc.inputSchema.properties.action.const).toBe('pin_set');
    // session_pin's OWN `action` (set|get|clear) is implied by the discriminator — not re-listed.
    // (the const IS `action` with value pin_set; there must be no SECOND enum action param)
    expect(sc.inputSchema.properties.action.enum).toBeUndefined();
  });

  test('explain(flat tool) resolves recall_thread directly', async () => {
    const resp = await dispatchDiscover({ action: 'explain', tool: 'recall_thread' });
    const sc: any = resp.structuredContent;
    expect(sc.tool).toBe('recall_thread');
    expect(sc.inputSchema.properties.anchor).toBeDefined();
  });

  test('unknown action + unknown tool are actionable errors', async () => {
    const a = await dispatchDiscover({ action: 'nope' });
    expect(a.isError).toBe(true);
    const b = await dispatchDiscover({ action: 'explain', tool: 'not_a_tool' });
    expect(b.isError).toBe(true);
    expect(textOf(b)).toMatch(/catalog/);
  });
});
