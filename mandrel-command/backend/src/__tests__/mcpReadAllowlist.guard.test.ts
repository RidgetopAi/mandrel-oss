/**
 * mcpReadAllowlist.guard.test.ts — the DRIFT GUARD for the /api/mcp passthrough's
 * read-only allow-list and its project-scope classification
 *.
 *
 * config/mcpReadAllowlist.ts is a hand-kept list, and hand-kept lists drift.
 * This test pins it to the mcp-server's OWN single source for op effects —
 * mcp-server/src/config/opRegistry.ts, read off disk — the exact technique the frontend
 * identity guard uses. The assertion: EVERY tool on the allow-list is registered with
 * effect 'read'. An op absent from the registry counts as 'write' (mirrors opEffect()'s
 * fail-closed default), so a deleted/renamed tool also turns RED here rather than
 * silently riding the passthrough.
 *
 * The reverse direction (a read tool NOT on the list) is intentionally NOT asserted:
 * the list is deny-by-default on purpose — new read tools must be added by a human.
 *
 * THE SCOPE CLASSIFICATION is guarded in both checkable directions:
 *   (a) machine-derived: an allow-listed tool whose registry entry DECLARES a
 *       project-reference param (projectId/project in humanDescriptions) must be
 *       classified 'project-scoped' — the registry is the product's own statement that
 *       the tool resolves a project;
 *   (b) value-pinned: the 'global' set is restated here literally (the
 *       opEffectClassification pattern — a test that only re-read the config could not
 *       detect a change to it, a past incident #7), so WIDENING the unbound population is a
 *       deliberate two-file diff with this comment staring at the author.
 * Direction (a) cannot catch an ambient reader that declares NO param (project_current
 * is the canonical one) — that half is a written per-entry judgment in the config, and
 * (b) is what keeps it from silently eroding.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  MCP_READ_TOOL_ALLOWLIST,
  MCP_READ_TOOL_SCOPES,
  isAllowedReadTool,
  isProjectScopedReadTool,
} from '../config/mcpReadAllowlist';

const OP_REGISTRY_RELPATH = join('mcp-server', 'src', 'config', 'opRegistry.ts');

/** Walk UP until the ancestor containing the op registry (worktree/container-safe, C4). */
function findRepoRoot(): string {
  let dir = __dirname;
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(dir, OP_REGISTRY_RELPATH))) return dir;
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    `Could not locate ${OP_REGISTRY_RELPATH} in any ancestor. ` +
      'This guard derives its population from that file; refusing to pass vacuously.'
  );
}

/** `opId: 'x',` followed (within a few lines) by `effect: 'y',` — mirrors the frontend guard. */
function parseOpEffects(source: string): Map<string, string> {
  const effects = new Map<string, string>();
  const re = /opId:\s*'([^']+)'\s*,[\s\S]{0,200}?effect:\s*'([\w-]+)'\s*,/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) effects.set(m[1], m[2]);
  return effects;
}

/**
 * Per-op source block: from its `opId:` line to the next op's (or EOF). Used to ask a
 * question parseOpEffects cannot: does THIS op's entry declare a given parameter?
 */
function parseOpBlocks(source: string): Map<string, string> {
  const blocks = new Map<string, string>();
  const re = /opId:\s*'([^']+)'/g;
  const hits: Array<{ opId: string; index: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) hits.push({ opId: m[1], index: m.index });
  for (let i = 0; i < hits.length; i++) {
    const end = i + 1 < hits.length ? hits[i + 1].index : source.length;
    blocks.set(hits[i].opId, source.slice(hits[i].index, end));
  }
  return blocks;
}

/** Does this op's registry block declare a project-reference parameter? */
function declaresProjectParam(block: string): boolean {
  return /^\s*(projectId|project):\s*['"`]/m.test(block);
}

describe('mcpReadAllowlist stays a strict subset of opRegistry READ ops', () => {
  const registrySource = readFileSync(join(findRepoRoot(), OP_REGISTRY_RELPATH), 'utf8');
  const effects = parseOpEffects(registrySource);

  it('derives a NON-EMPTY op-effect population from opRegistry.ts (self-check)', () => {
    // If the registry's shape changes and the regex goes blind, every allow-list entry
    // would look 'write' (absent) and the next test fails loudly — but assert emptiness
    // separately so the failure names the real cause.
    expect(effects.size).toBeGreaterThan(20);
  });

  it('every allow-listed tool is registered with effect "read" (absent ⇒ write ⇒ RED)', () => {
    const offenders: string[] = [];
    for (const tool of MCP_READ_TOOL_ALLOWLIST) {
      const effect = effects.get(tool) ?? 'write (ABSENT from opRegistry — fail-closed default)';
      if (effect !== 'read') offenders.push(`${tool} → ${effect}`);
    }
    expect(offenders).toEqual([]);
  });

  it('deny-by-default: a write tool, a scope-switch tool, an unknown tool, and the empty string are all refused', () => {
    // The values that slip through (C3): representative write + scope-switch drawn from
    // the registry itself (so this stays true even if specific tool names change), plus
    // the absent and empty populations.
    const writes = [...effects.entries()].filter(([, e]) => e === 'write').map(([op]) => op);
    const switches = [...effects.entries()].filter(([, e]) => e === 'scope-switch').map(([op]) => op);
    expect(writes.length).toBeGreaterThan(0);
    expect(switches.length).toBeGreaterThan(0);
    expect(isAllowedReadTool(writes[0])).toBe(false);
    expect(isAllowedReadTool(switches[0])).toBe(false);
    expect(isAllowedReadTool('no_such_tool_ever')).toBe(false);
    expect(isAllowedReadTool('')).toBe(false);
  });
});

describe('the project-scope classification', () => {
  const registrySource = readFileSync(join(findRepoRoot(), OP_REGISTRY_RELPATH), 'utf8');
  const blocks = parseOpBlocks(registrySource);

  it('every allow-listed tool carries a classification (totality — the absent population)', () => {
    for (const tool of MCP_READ_TOOL_ALLOWLIST) {
      expect(['project-scoped', 'global']).toContain(MCP_READ_TOOL_SCOPES[tool]);
    }
    // And the two views are the SAME object population — no second list to drift.
    expect(new Set(Object.keys(MCP_READ_TOOL_SCOPES))).toEqual(new Set(MCP_READ_TOOL_ALLOWLIST));
  });

  it('(a) a tool whose registry entry declares a project param MUST be project-scoped', () => {
    const offenders: string[] = [];
    for (const tool of MCP_READ_TOOL_ALLOWLIST) {
      const block = blocks.get(tool);
      if (!block) continue; // absence is the read-effect guard's finding, not this one's
      if (declaresProjectParam(block) && !isProjectScopedReadTool(tool)) {
        offenders.push(tool);
      }
    }
    expect(offenders).toEqual([]);
    // Self-check: the derivation is not blind — the registry DOES declare the param on
    // the two tools we know carry it, so an all-pass above cannot be vacuous.
    expect(declaresProjectParam(blocks.get('context_search') ?? '')).toBe(true);
    expect(declaresProjectParam(blocks.get('context_get_recent') ?? '')).toBe(true);
  });

  it('(b) the GLOBAL (unbound-forwardable) set is EXACTLY mandrel_ping + mandrel_status — widening it is a deliberate two-file diff', () => {
    const globals = Object.entries(MCP_READ_TOOL_SCOPES)
      .filter(([, scope]) => scope === 'global')
      .map(([tool]) => tool)
      .sort();
    // Read the handlers before touching this pin: a 'global' tool forwards with NO
    // project binding, so it must resolve no project on ANY handler path
    // (system.routes.ts handlePing/handleStatus are the two that qualify today).
    expect(globals).toEqual(['mandrel_ping', 'mandrel_status']);
  });

  it('fail-closed: an unclassified/unknown tool is treated as project-scoped, never global', () => {
    expect(isProjectScopedReadTool('no_such_tool_ever')).toBe(true);
    expect(isProjectScopedReadTool('')).toBe(true);
  });
});
