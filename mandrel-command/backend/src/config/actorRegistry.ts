/**
 * actorRegistry (Command backend) — the first-party principal taxonomy, mirrored from the
 * mcp-server's single source so `GET /api/tasks/actor-options` can label the built-in half
 * of its suggestion list.
 *
 * ── WHY THIS IS A MIRROR AND NOT AN IMPORT ────────────────────────────────────────────
 * The taxonomy is declared ONCE, in `mcp-server/src/config/actorRegistry.ts`
 * (`BUILTIN_ACTOR_KINDS`, `ACTOR_PREFIX_RULES`). This backend cannot import or read it:
 *   - the two are separate services with no shared package (the same constraint
 *     `config/sessionActor.ts` states for `normalizeActor`);
 *   - `mandrel-command/backend/Dockerfile` copies `backend/` and `backend/dist` into the
 *     runtime image and nothing else, so `mcp-server/src/...` does not exist at this
 *     process's runtime — a `readFileSync` derivation would return the C1 third state
 *     ("could not measure") in the container and would have to guess what to do with it.
 *
 * So the copy is unavoidable, and the anti-drift job moves to a GUARD instead of to
 * discipline: `__tests__/actorRegistryDrift.test.ts` parses the mcp-server file off disk
 * and asserts SET EQUALITY with the maps below, in BOTH directions. Adding, removing,
 * renaming or re-kinding an actor over there turns this repo RED and names the actor.
 * (Same technique as `__tests__/mcpReadAllowlist.guard.test.ts` against `opRegistry.ts`.)
 *
 * ── TRUST MODEL ───────────────────────────────────────────────────────────────────────
 * This is ATTRIBUTION, never authorization. Nothing here restricts what a caller may
 * write into `tasks.assigned_to`: that column is free-form varchar and stays free-form.
 * These values are SUGGESTIONS and LABELS only.
 */

/** The three principal kinds an actor can classify to. Mirrors the mcp-server `ActorKind`. */
export type ActorKind = 'human' | 'agent' | 'automation';

/**
 * MIRROR of `BUILTIN_ACTOR_KINDS` in `mcp-server/src/config/actorRegistry.ts`.
 * Keys are already normalized (lowercase slugs). Pinned by actorRegistryDrift.test.ts.
 *
 * ⚠️ WHAT THIS MIRROR DOES NOT COVER — read before assuming the list is the whole roster
 * (the reviewer N2 on documented rather than closed, and here is why).
 *
 * The mcp-server's EFFECTIVE registry is `BUILTIN_ACTOR_KINDS` overlaid with the env var
 * `MANDREL_ACTOR_REGISTRY_EXTRA` ("name:kind,…"), applied by its `resolveRegistry()`. This
 * mirror carries only the CODE-DECLARED half, because the env var is read in a DIFFERENT
 * PROCESS: the mcp-server container's environment, not this backend's. Reading our own
 * `process.env` for it would answer a question about someone else's process — a confidently
 * wrong instrument, and it would silently disagree with the real registry the moment the two
 * containers' env differ, which is exactly the kind of second representation the rest of
 * this file exists to prevent. So the drift guard deliberately compares code to code.
 *
 * THE ONLY OBSERVABLE CONSEQUENCE is a MISSING SUGGESTION, never a wrong or blocked value:
 * an env-extended actor does not appear in the `builtin` half of `GET /api/tasks/actor-options`
 * until it has actually held a session or a task in scope, at which point the `sessions` /
 * `tasks` halves surface it with real usage counts. Nothing rejects it in the meantime —
 * `tasks.assigned_to` is free-form and the Assignee control accepts free text by design.
 *
 * IT WOULD MATTER if the combobox were ever expected to present a customer's CONFIGURED
 * roster rather than their OBSERVED one. That is a different feature (a real actors table
 * or an endpoint the mcp-server serves from its own env) — not a wider mirror.
 */
export const BUILTIN_ACTOR_KINDS: Readonly<Record<string, ActorKind>> = {
  operator: 'human',
  carol: 'human',
  coordinator: 'agent',
  reviewer: 'agent',
  researcher: 'agent',
  'ops-bot': 'agent',
  auditor: 'agent',
  builder: 'agent',
  anonymous: 'agent',
  tick: 'automation',
  'deploy-smoke': 'automation',
  cron: 'automation',
  // Mirror of the same line in the mcp-server source. Adding it in ONE
  // of the two files turns actorRegistryDrift.test.ts RED by design — that guard is the
  // reason this pair cannot silently diverge.
  'coordinator-alert-sink': 'automation',
} as const;

/**
 * MIRROR of `ACTOR_PREFIX_RULES` in `mcp-server/src/config/actorRegistry.ts`. Ordered;
 * first match wins. Pinned by actorRegistryDrift.test.ts.
 */
export const ACTOR_PREFIX_RULES: ReadonlyArray<{ prefix: string; kind: ActorKind }> = [
  { prefix: 'builder-', kind: 'agent' },
  { prefix: 'reviewer-', kind: 'agent' },
];

/**
 * The dedup key for two spellings of the same assignee: trim + lowercase, and NOTHING
 * else. This is the rule the operator approved ("matched case-insensitively"), and the narrowness
 * is deliberate:
 *   - `builder` / `the builder` and `coordinator` / `the coordinator` collapse — the measured drift;
 *   - `the operator + the coordinator` and `the coordinator + the operator` do NOT collapse, and `builder (P3 Insight)`
 *     does not collapse into `builder`. They are different strings and we have no
 *     evidence they mean the same principal; inventing that equivalence would silently
 *     rewrite a human's label.
 * Deliberately NOT `sessionActor.normalizeActor` (which slugifies whitespace and hyphens):
 * that is the WRITE-time stamping rule for session actors, and applying it to a free-form
 * assignee would render `the operator + the coordinator` as `operator-+-coordinator` in the UI.
 */
export function actorMatchKey(raw: string): string {
  return raw.trim().toLowerCase();
}

/**
 * The kind of an actor when it is KNOWN, else `null`.
 *
 * Returns null rather than the mcp-server's default kind on purpose. `classifyActor()`
 * over there must always answer something because it stamps a metrics label; here an
 * honest "we do not know what this is" is the useful answer, and it keeps this mirror from
 * needing a second copy of `MANDREL_ACTOR_DEFAULT_KIND`. Empty/blank input is `null` too —
 * the empty population, not a fabricated 'agent'.
 */
export function knownActorKind(raw: string): ActorKind | null {
  const key = actorMatchKey(raw);
  if (key === '') return null;
  // OWN KEY ONLY. A bare index read walks Object.prototype, and `actorMatchKey` is just
  // trim+lowercase, so every all-lowercase prototype key reaches this line as a candidate
  // actor. Measured before this guard existed (the reviewer):
  //   knownActorKind('constructor') -> typeof 'function'  (the Object constructor)
  //   knownActorKind('__proto__')   -> typeof 'object'
  // Both are outside the declared `ActorKind | null` return type, and neither survives
  // JSON.stringify — a function serializes to nothing, so `actor_kind` VANISHED from the
  // API response, and `{}` for __proto__. The input is user-controlled: task.ts:209 reaches
  // here from a FREE-TEXT task assignee, so a task assigned to `constructor` was enough.
  //
  // The mcp-server original carried the same defect through `in` and was fixed in the same
  // change; this is the third door of the same family (own-vs-inherited access). Note the
  // drift guard next door CANNOT catch this: it pins the two literal BLOCKS, not how they
  // are READ, so the population it compares is identical either way.
  // `Object.prototype.hasOwnProperty.call`, NOT `Object.hasOwn`: this package compiles at
  // `"lib": ["ES2020"]` (tsconfig.json) and `Object.hasOwn` is ES2022, so it is a TS2550
  // here while being perfectly fine in mcp-server, which targets ES2022. Measured — the
  // ES2022 spelling typechecks in one package and not the other, and vitest transpiles
  // WITHOUT typechecking, so the tests go green either way. Called off Object.prototype
  // rather than off the object, so a registry entry named `hasOwnProperty` could not
  // shadow the check.
  const exact = Object.prototype.hasOwnProperty.call(BUILTIN_ACTOR_KINDS, key)
    ? BUILTIN_ACTOR_KINDS[key]
    : undefined;
  if (exact !== undefined) return exact;
  for (const rule of ACTOR_PREFIX_RULES) {
    if (key.startsWith(rule.prefix)) return rule.kind;
  }
  return null;
}

/** The built-in actors as rows, in declaration order. */
export function listBuiltinActors(): ReadonlyArray<{ actor: string; kind: ActorKind }> {
  return Object.entries(BUILTIN_ACTOR_KINDS).map(([actor, kind]) => ({ actor, kind }));
}
