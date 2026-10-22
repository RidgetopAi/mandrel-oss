/**
 * actorRegistryDrift — pins `config/actorRegistry.ts` (this backend's mirror) to the ONE
 * declaration of the actor taxonomy, `mcp-server/src/config/actorRegistry.ts`, read off
 * disk.
 *
 * WHY A GUARD AND NOT AN IMPORT: stated in full at the top of `config/actorRegistry.ts`.
 * Short form — separate services, no shared package, and the backend's runtime image does
 * not contain `mcp-server/`.
 *
 * Same technique as `mcpReadAllowlist.guard.test.ts` against `opRegistry.ts`.
 *
 * THE POPULATION, AND WHY IT IS THE WHOLE ONE (C3): every key of `BUILTIN_ACTOR_KINDS`
 * and every entry of `ACTOR_PREFIX_RULES` in that file, compared as SETS in BOTH
 * directions. An actor added over there and not here is RED; an actor invented here and
 * absent over there is RED; a re-kinded actor is RED. There is no third state — the parse
 * either finds the file and both blocks, or it throws rather than passing vacuously.
 *
 * PARSING A LITERAL, NOT A STRUCTURE: these two blocks are flat object/array literals of
 * quoted strings, which is a BYTES-shaped property, so a byte-level parse is the right
 * instrument. It is made honest by a NON-EMPTY TRAP (a parse that finds nothing FAILS,
 * it does not pass with an empty set) and by the both-directions comparison.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  BUILTIN_ACTOR_KINDS,
  ACTOR_PREFIX_RULES,
  knownActorKind,
} from '../config/actorRegistry';

const REGISTRY_RELPATH = join('mcp-server', 'src', 'config', 'actorRegistry.ts');

/** Walk UP until the ancestor containing the mcp-server registry (worktree/CI-safe, C4). */
function findRepoRoot(): string {
  let dir = __dirname;
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(dir, REGISTRY_RELPATH))) return dir;
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    `Could not locate ${REGISTRY_RELPATH} in any ancestor of ${__dirname}. This guard ` +
      'derives its population from that file; refusing to pass vacuously.'
  );
}

const SOURCE = readFileSync(join(findRepoRoot(), REGISTRY_RELPATH), 'utf8');

/** The body of a named `export const X: T = { … };` / `= [ … ];` block. */
function declarationBody(name: string, open: '{' | '['): string {
  const close = open === '{' ? '}' : ']';
  const start = SOURCE.indexOf(`export const ${name}`);
  if (start < 0) {
    throw new Error(
      `${REGISTRY_RELPATH} no longer exports \`${name}\`. The mirror in ` +
        'config/actorRegistry.ts has lost its source of truth — re-point this guard ' +
        'rather than deleting it.'
    );
  }
  const from = SOURCE.indexOf(open, start);
  const to = SOURCE.indexOf(`${close};`, from);
  if (from < 0 || to < 0) throw new Error(`Could not delimit \`${name}\` in ${REGISTRY_RELPATH}`);
  return SOURCE.slice(from + 1, to);
}

/**
 * `name: 'kind',` / `'quoted-name': 'kind',` / `[ACTOR_ANONYMOUS]: 'kind',`.
 * The computed key is resolved from its own `export const ACTOR_ANONYMOUS = '…'`, so the
 * anonymous actor is compared by VALUE and not skipped.
 */
function parseUpstreamBuiltins(): Map<string, string> {
  const anonMatch = SOURCE.match(/export const ACTOR_ANONYMOUS\s*=\s*'([^']+)'/);
  if (!anonMatch) throw new Error(`Could not read ACTOR_ANONYMOUS from ${REGISTRY_RELPATH}`);

  const body = declarationBody('BUILTIN_ACTOR_KINDS', '{');
  const out = new Map<string, string>();
  const re = /(?:^|\n)\s*(?:\[([A-Z_]+)\]|'([^']+)'|([A-Za-z0-9_-]+))\s*:\s*'(human|agent|automation)'\s*,/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    const key = m[1] === 'ACTOR_ANONYMOUS' ? anonMatch[1] : (m[2] ?? m[3]);
    if (m[1] && m[1] !== 'ACTOR_ANONYMOUS') {
      throw new Error(`Unresolvable computed key [${m[1]}] in BUILTIN_ACTOR_KINDS — teach this guard about it.`);
    }
    out.set(key, m[4]);
  }
  return out;
}

/** `{ prefix: 'builder-', kind: 'agent' },` — order preserved (first match wins). */
function parseUpstreamPrefixRules(): Array<{ prefix: string; kind: string }> {
  const body = declarationBody('ACTOR_PREFIX_RULES', '[');
  const out: Array<{ prefix: string; kind: string }> = [];
  const re = /\{\s*prefix:\s*'([^']+)'\s*,\s*kind:\s*'(human|agent|automation)'\s*,?\s*\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) out.push({ prefix: m[1], kind: m[2] });
  return out;
}

describe('config/actorRegistry mirrors mcp-server/src/config/actorRegistry.ts', () => { // db-gate-exempt: reads a SOURCE FILE off disk, opens no connection
  const upstreamBuiltins = parseUpstreamBuiltins();
  const upstreamPrefixes = parseUpstreamPrefixRules();

  it('parsed a non-empty population from the upstream file', () => {
    // THE NON-EMPTY TRAP. Without this, a rename upstream turns both maps empty and every
    // set comparison below passes while comparing nothing.
    expect(upstreamBuiltins.size).toBeGreaterThanOrEqual(10);
    expect(upstreamPrefixes.length).toBeGreaterThanOrEqual(2);
  });

  it('declares exactly the same built-in actors, with the same kinds, in both directions', () => {
    expect(Object.fromEntries([...upstreamBuiltins.entries()].sort())).toEqual(
      Object.fromEntries(Object.entries(BUILTIN_ACTOR_KINDS).sort())
    );
  });

  it('declares exactly the same prefix rules, in the same order', () => {
    expect(upstreamPrefixes).toEqual(ACTOR_PREFIX_RULES.map((r) => ({ ...r })));
  });

  it('classifies via the mirrored rules, case-insensitively, and answers null for the unknown', () => {
    // Exercises the mirror rather than only re-reading it (a past incident #7): a test that
    // compares two data structures cannot notice that the LOOKUP is broken.
    expect(knownActorKind('Builder')).toBe('agent');
    expect(knownActorKind('  OPERATOR ')).toBe('human');
    expect(knownActorKind('tick')).toBe('automation');
    expect(knownActorKind('builder-0544d878')).toBe('agent'); // prefix rule
    expect(knownActorKind('Operator + Coordinator')).toBeNull();
    expect(knownActorKind('')).toBeNull();
    expect(knownActorKind('   ')).toBeNull();
  });
});
