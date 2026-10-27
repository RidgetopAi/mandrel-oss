/**
 * actorRegistry — the SINGLE SOURCE OF TRUTH for the session ACTOR concept: how a raw
 * actor string is normalized, and the taxonomy that maps an actor → its KIND
 * (human | agent | automation).
 *
 * WHY (the auditor review §5 "Identity & ownership" + §6 Phase 1): the
 * Sessions redesign re-keys session identity to a stable, human-meaningful ACTOR
 * (operator, coordinator, builder-<id8>, tick, deploy-smoke…). Phase 1 introduces the concept and
 * starts stamping it; the taxonomy here is used for CLASSIFICATION only (grouping /
 * analytics / future automation-day-rollover in Phase 4) — NOT yet for any behavior.
 * `agent_type` (the old free-text label) is deliberately NOT extended; the actor registry
 * is the one place a principal's kind is decided (review C6: "don't add another parallel
 * label").
 *
 * TRUST MODEL: on the single-tenant container the actor is ATTRIBUTION, not an authz
 * boundary (tenant isolation is at the container/DB level). Classification here must never
 * be treated as an access-control decision.
 *
 * configs-not-hardcoded (the operator 2026-06-20): the built-in registry is the default; ops can
 * extend it WITHOUT a code change via MANDREL_ACTOR_REGISTRY_EXTRA — comma-separated
 * `name:kind` pairs, e.g.  MANDREL_ACTOR_REGISTRY_EXTRA="scout:agent,payroll-bot:automation".
 *
 * COMPOSITE ACTORS — SHIPPED DARK behind
 * MANDREL_ACTOR_COMPOSITE_ENABLED (config/actorIdentityConfig.ts), default OFF. When enabled,
 * a verified OAuth `sub` SCOPES a declared handle (`<sub>/<handle>`) instead of overriding it,
 * so N agents under one human get N actors. With the flag OFF every function in this file is
 * byte-identical to its pre-change behavior — see the golden-fixture parity test in
 * tests/actorRegistry.unit.test.ts.
 */

import {
  ACTOR_COMPOSITE_DELIMITER,
  ACTOR_PRINCIPAL_ESCAPE,
  ACTOR_RESERVED_DELIMITER_CHARS,
  ACTOR_RESERVED_DELIMITER_REPLACEMENT,
  compositeActorEnabled,
} from './actorIdentityConfig.js';

/** The three principal kinds an actor can classify to. */
export type ActorKind = 'human' | 'agent' | 'automation';

/**
 * The flagged fallback actor stamped when NO actor is derivable (transition only). It is
 * COUNTED (sessions_created_anonymous_actor) so coverage is measurable before Phase 2
 * depends on actor resolution.
 *
 * Classifies as 'agent' (an earlier decision / ref:session-boundary). It USED to be
 * 'automation', on the reasoning that "header-less callers — curl, scripts, un-configured
 * clients — are overwhelmingly non-interactive". That reasoning is TRUE ON OUR BOX and FALSE
 * ON A CUSTOMER TENANT, where `anonymous` IS the customer's own agent doing interactive work:
 * same code, opposite population. The consequence of getting it wrong is real — 'automation'
 * triggers the same-UTC-day rollover (resolveSession.ts step (c)), so every unconfigured
 * customer's session SPLIT at 00:00 UTC (8pm EST) mid-work.
 *
 * THE PRINCIPLE: INTERACTIVE IS THE DEFAULT; AUTOMATION IS THE ENUMERATED OPT-IN. Machinery
 * declares itself — tick/deploy-smoke/cron are enumerated below, and a tenant can enumerate
 * its own via MANDREL_ACTOR_REGISTRY_EXTRA="theirbot:automation". A caller that declares
 * nothing gets the interactive (non-day-rolling) boundary, which is the safe default: the
 * failure mode of wrongly treating machinery as interactive is a slightly long-lived session;
 * the failure mode of wrongly treating a human's agent as machinery is a severed session.
 *
 * 'agent' rather than 'human' because a header-less MCP client is SOMEBODY'S AGENT, and it
 * agrees with resolveDefaultKind()'s existing 'agent' default for unknown actors — so the
 * anonymous path and the unknown-actor path classify the SAME way instead of drifting apart
 * (one rule, not two copies that diverge).
 */
export const ACTOR_ANONYMOUS = 'anonymous';

/**
 * The built-in actor → kind map. Values (keys) are ALREADY normalized (normalizeActor is
 * idempotent on them). First-party principals only; unknown actors fall to the pattern
 * rules then the default in classifyActor().
 *
 * EXPORTED (additively) because it is the ONE enumeration of first-party principals and a
 * second service now needs to name it as its source rather than invent a list. The Command
 * backend cannot `import` it — the two are separate services with no shared package, and
 * `mandrel-command/backend/Dockerfile` copies only `backend/` into the runtime image, so
 * this file does not exist at that process's runtime. Its mirror is therefore pinned to
 * THIS declaration by a drift guard that reads this file off disk
 * (`mandrel-command/backend/src/__tests__/actorRegistryDrift.test.ts`).
 */
export const BUILTIN_ACTOR_KINDS: Record<string, ActorKind> = {
  // Humans — arrive via the authenticated Command UI / interactive clients.
  operator: 'human',
  carol: 'human',
  // Agents — the Riverbend specialist roster (builder-<id8> handled by prefix rule below).
  coordinator: 'agent',
  reviewer: 'agent',
  researcher: 'agent',
  'ops-bot': 'agent',
  auditor: 'agent',
  builder: 'agent',
  // The header-less fallback: somebody's agent until it declares otherwise (see ACTOR_ANONYMOUS
  // above). Interactive is the DEFAULT — deliberately NOT in the automation block below, so it
  // does NOT get the same-UTC-day rollover.
  [ACTOR_ANONYMOUS]: 'agent',
  // Automation — non-interactive machinery, ENUMERATED (the opt-in). These KEEP the same-UTC-day
  // rollover: they run hourly and never go idle long enough for the idle closer to fire, so the
  // day-roll is their only session boundary. Do not "simplify" it away.
  tick: 'automation',
  'deploy-smoke': 'automation',
  cron: 'automation',
  // The alert sink that drains the coordinator's notification queue. Registered 2026-08-10:
  // it was the LARGEST unregistered token consumer on prod (35.4M of 30d
  // tokens, 43.6%) and classified to the DEFAULT kind rather than to automation, so the
  // Analytics user-vs-automation split counted the single biggest machine as unknown.
  'coordinator-alert-sink': 'automation',
};

/**
 * Prefix rules for parametric actor families (checked after an exact registry hit).
 * e.g. `builder-<id>` → agent. Ordered; first match wins.
 *
 * Exported for the same reason as BUILTIN_ACTOR_KINDS above — see that note.
 */
export const ACTOR_PREFIX_RULES: ReadonlyArray<{ prefix: string; kind: ActorKind }> = [
  { prefix: 'builder-', kind: 'agent' },
  { prefix: 'reviewer-', kind: 'agent' },
];

/**
 * The default kind for an actor that matches neither the registry nor a prefix rule.
 * 'agent' because the declared-actor surfaces (the Claude Code bridge + remote MCP) are
 * agent-operated; enumerated humans arrive via the authenticated Command UI and machinery
 * is enumerated automation. Env-overridable (MANDREL_ACTOR_DEFAULT_KIND).
 */
function resolveDefaultKind(): ActorKind {
  const raw = process.env.MANDREL_ACTOR_DEFAULT_KIND;
  return raw === 'human' || raw === 'agent' || raw === 'automation' ? raw : 'agent';
}

/**
 * Normalize a raw actor string so equivalent values collapse to one stable key:
 * trim → lowercase → whitespace runs to a single hyphen → collapse repeated hyphens →
 * strip edge hyphens. Empty/blank/undefined/null → null (no actor derivable). Idempotent.
 *
 * Slug-like normalization matches the actor naming (coordinator, tick, builder-<id8>); an OAuth
 * `sub` (email/uuid) survives unchanged apart from case-folding, which is a safe stabilizer
 * for attribution.
 *
 * IT DELIBERATELY DOES NOT TOUCH THE COMPOSITE DELIMITER, in either mode. This function runs
 * at STAMP time (SessionLifecycleService) on the ALREADY-DERIVED actor, so stripping `/` here
 * would shred a server-composed `<sub>/<handle>` back into one flat actor — re-creating the
 * exact collapse the composite exists to prevent. Delimiter hygiene belongs on the UNTRUSTED
 * DECLARED SEGMENT only, before composition — that is sanitizeDeclaredActor() below.
 */
export function normalizeActor(input?: string | null): string | null {
  if (input === undefined || input === null) return null;
  const normalized = String(input)
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized === '' ? null : normalized;
}

/**
 * Strip the RESERVED DELIMITER CHARACTERS out of a client-DECLARED actor segment, replacing
 * each with the safe slug separator. Applied to the declared half ONLY, before composition.
 *
 * THIS IS THE FORGERY GUARD, and it is the whole reason the composite can be trusted:
 * because a declared segment can never CONTAIN the delimiter, an actor string that DOES
 * contain it can only have been assembled SERVER-SIDE from a verified principal. A client
 * therefore cannot spell `<someone-elses-sub>/<handle>` and land in another principal's
 * namespace, and cannot assert a `sub` it did not authenticate as. (the
 * client sends ONLY the handle; clients must never construct composites.)
 *
 * What a client CAN still do is claim to be a DIFFERENT AGENT UNDER ITS OWN principal. That
 * is accepted and unchanged — see the trust-model note on deriveActor().
 */
export function sanitizeDeclaredActor(declared: string): string {
  let out = declared;
  for (const ch of ACTOR_RESERVED_DELIMITER_CHARS) {
    out = out.split(ch).join(ACTOR_RESERVED_DELIMITER_REPLACEMENT);
  }
  return out;
}

/**
 * Percent-ENCODE the reserved delimiters out of a VERIFIED PRINCIPAL segment (Reviewer N1).
 *
 * The declared half is merely stripped (it is untrusted say-so — losing information in it costs
 * nothing). The principal is verified identity, so it is encoded instead: the mapping is
 * INJECTIVE, so two distinct principals can never land on the same actor string. `%` is escaped
 * first, or a literal `%2f` in a sub would be indistinguishable from an encoded `/`.
 *
 * THIS IS WHAT MAKES THE *COMPOSITE* NAMESPACE UNFORGEABLE rather than merely claimed to be.
 * Without it, `sub='a/b'` alone and `sub='a' + declared='b'` both produce the actor `a/b`. It is
 * a NO-OP for every delimiter-free principal — i.e. for every ordinary email / uuid / `auth0|…`
 * sub — so the common path is untouched by construction.
 *
 * SCOPE, STATED HONESTLY (Reviewer B2): this protects COMPOSITE actors. It does NOT separate the
 * FLAT namespace — see the residual documented on deriveActor().
 */
export function encodePrincipalActor(principal: string): string {
  let out = principal.split(ACTOR_PRINCIPAL_ESCAPE).join(`${ACTOR_PRINCIPAL_ESCAPE}25`);
  for (const ch of ACTOR_RESERVED_DELIMITER_CHARS) {
    const hex = ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0');
    out = out.split(ch).join(`${ACTOR_PRINCIPAL_ESCAPE}${hex}`);
  }
  return out;
}

/**
 * The HANDLE half of a (possibly composite) actor — everything AFTER THE FIRST delimiter, i.e.
 * the grammar `<principal>/<handle>` read literally. `operator@x/builder-abc` → `builder-abc`; a
 * non-composite actor is returned unchanged.
 *
 * FIRST, not last (Reviewer N1): the principal is ONE segment by construction, because
 * encodePrincipalActor() guarantees it contains no raw delimiter. For every actor this system
 * can PRODUCE the two readings are identical (a well-formed composite holds exactly one
 * delimiter — asserted structurally in the unit tests); first-split is the one that stays
 * faithful to the grammar on a malformed or hand-written legacy value.
 *
 * A value that is ALL delimiter falls back to the input, so this never returns '' and never
 * throws.
 */
export function actorHandleSegment(normalized: string): string {
  const at = normalized.indexOf(ACTOR_COMPOSITE_DELIMITER);
  if (at < 0) return normalized;
  const handle = normalized.slice(at + ACTOR_COMPOSITE_DELIMITER.length);
  return handle === '' ? normalized : handle;
}

/** Parse MANDREL_ACTOR_REGISTRY_EXTRA ("name:kind,...") into overrides (best-effort). */
function parseExtraRegistry(raw: string | undefined): Record<string, ActorKind> {
  const out: Record<string, ActorKind> = {};
  if (!raw || raw.trim() === '') return out;
  for (const pair of raw.split(',')) {
    const [nameRaw, kindRaw] = pair.split(':');
    const name = normalizeActor(nameRaw);
    const kind = (kindRaw ?? '').trim();
    if (name && (kind === 'human' || kind === 'agent' || kind === 'automation')) {
      out[name] = kind;
    }
  }
  return out;
}

/** Effective registry = built-ins overlaid with the env extras (env wins). */
function resolveRegistry(): Record<string, ActorKind> {
  return { ...BUILTIN_ACTOR_KINDS, ...parseExtraRegistry(process.env.MANDREL_ACTOR_REGISTRY_EXTRA) };
}

/**
 * Classify an actor → its kind. Resolution order: normalize → (composite mode: take the LAST
 * segment) → exact registry hit → prefix rule → default kind. A blank/undefined actor is
 * treated as `anonymous`. Classification ONLY (Phase 1) — never an authz or behavior decision.
 *
 * WHY THE HANDLE SEGMENT (composite mode only): the KIND lives in the agent
 * handle, not the principal. A composite `operator@example.com/builder-abc` classified whole
 * would miss the `builder-` prefix rule and fall to the default kind — and, worse, an
 * enumerated automation like `tick` running under an OAuth principal would stop classifying
 * as automation and silently lose its same-UTC-day session rollover. Classifying the handle
 * makes an actor's kind IDENTICAL whether it arrived over the static-bearer surface
 * (`tick`) or the OAuth surface (`<sub>/tick`) — one rule, one answer, both auth modes.
 *
 * With the flag OFF this is the pre-change whole-string classification, unchanged.
 */
export function classifyActor(actor?: string | null): ActorKind {
  const normalized = normalizeActor(actor) ?? ACTOR_ANONYMOUS;
  const subject = compositeActorEnabled() ? actorHandleSegment(normalized) : normalized;
  const registry = resolveRegistry();
  // `Object.hasOwn`, NEVER `in`. `resolveRegistry()` returns an object LITERAL, so it has
  // Object.prototype, and `in` walks it: `'constructor' in registry` is true and
  // `registry['constructor']` is the Object CONSTRUCTOR FUNCTION — which this line would
  // then return as an `ActorKind`, a value outside the union the signature promises, with
  // no type error anywhere because the index read is typed `ActorKind` by declaration.
  // Measured 2026-08-28 (Reviewer): classifyActor('constructor') returned
  // that function. Same door reopened isRegisteredActor below; one edit closes both.
  if (Object.hasOwn(registry, subject)) return registry[subject];
  for (const rule of ACTOR_PREFIX_RULES) {
    if (subject.startsWith(rule.prefix)) return rule.kind;
  }
  return resolveDefaultKind();
}

/**
 * Is this string a KNOWN actor — i.e. does the registry (built-ins + the env extras) or a
 * prefix family actually name it?
 *
 * DELIBERATELY NOT `classifyActor(x) !== undefined`: classifyActor answers a DIFFERENT
 * question and answers it for every input, because an unknown actor falls through to the
 * default kind. That fallback is right for classification (a stranger is still somebody's
 * agent) and useless as a membership test — it would call every typo a valid actor.
 *
 * The `actor:` threading axis (config/threadingVocabConfig.ts) is the caller: it needs
 * "is this on the roster", and it needs to get that answer from THE roster rather than
 * reprinting the names, so adding an actor here adds it to the tag vocabulary in the same
 * edit. Membership only — this is attribution, never an authz decision (see TRUST MODEL).
 *
 * Composite actors (`<sub>/<handle>`) are tested on their HANDLE segment when composite
 * mode is on, matching classifyActor: the roster names handles, not principals.
 */
export function isRegisteredActor(actor?: string | null): boolean {
  const normalized = normalizeActor(actor);
  if (!normalized) return false;
  const subject = compositeActorEnabled() ? actorHandleSegment(normalized) : normalized;
  // OWN keys only — see the note in classifyActor. `in` made this return TRUE for
  // 'constructor', '__proto__', 'toString' and every other Object.prototype key, so
  // `actor:constructor` stored unquarantined and threaded as a valid actor tag. The
  // contract test could not see it: it derives its population from Object.keys(), which is
  // own-keys, while this line read the prototype chain (CLASSES.md C3 — the guard's
  // population and the implementation's must be the same set).
  if (Object.hasOwn(resolveRegistry(), subject)) return true;
  return ACTOR_PREFIX_RULES.some(
    rule => subject.startsWith(rule.prefix) && subject.length > rule.prefix.length,
  );
}

/**
 * Derive the actor to stamp at an EDGE. THE ONE CHOKE POINT for actor identity — every
 * request surface funnels through it (`healthServer.actorFor`, `remoteMcpTransport.actorFor`,
 * `sessionAnalyticsController`), so the rule cannot drift.
 *
 * ── THE RULE ────────────────────────────────────────────────────────
 * A verified principal SCOPES the declared handle; it does NOT override it:
 *   sub + declared → `<encoded sub>/<sanitized declared>` — assembled SERVER-SIDE, never by a
 *                                                           client
 *   sub only       → `<encoded sub>`                (a lone human on the Claude.ai connector
 *                                                    configures nothing; encoding is a NO-OP
 *                                                    for any delimiter-free sub, which is
 *                                                    every ordinary email/uuid/`auth0|…` one)
 *   declared only  → `<sanitized declared>`         (the static-bearer path)
 *   neither        → undefined → the lifecycle service stamps the flagged `anonymous`
 *
 * WHY, not "auth wins": the old precedence returned the `sub` before the declared header was
 * ever read, so N agents authenticating as ONE human collapsed into ONE actor sharing one
 * current-project. Scoping is a degenerate-safe generalization — on the static-bearer surface
 * there IS no sub, so it collapses to exactly the old path; on OAuth, N declared handles under
 * one verified principal become N distinct, namespaced actors.
 *
 * The client sends ONLY its agent handle, in the existing `X-Actor-ID` header — no new header,
 * and a client must NEVER construct a `<sub>/<handle>` string itself (that would be ASSERTING
 * a principal, which is exactly the say-so we must not trust).
 *
 * ── THE NAMESPACE INVARIANT: WHAT IS ACTUALLY TRUE ──────────────────────────────────────
 *   "A client-supplied string can never produce another principal's COMPOSITE actor."
 * Note the word COMPOSITE. The absolute form of this sentence — "…never produce another
 * principal's actor" — is FALSE, and was written here twice before Reviewer falsified it
 * (2026-07-25). The residual is stated in full below; read it before you rely on this.
 *
 * The composite claim is about EVERY site an actor is built, not just this function, and it is
 * enforced by three things that must all hold (Reviewer falsified it when only the first
 * existed):
 *   1. sanitizeDeclaredActor() — a DECLARED segment can never contain the delimiter, so it can
 *      never spell a composite (here, and at every other actor-construction site).
 *   2. encodePrincipalActor() — an emitted PRINCIPAL never contains a raw delimiter either, so
 *      `sub='a/b'` alone and `sub='a' + declared='b'` no longer collapse to the same actor.
 *   3. EVERY other site that builds an actor from a caller-supplied value routes THROUGH this
 *      function — notably `tasks.routes.ts#claimActor`, where a client-supplied `actor` tool
 *      ARGUMENT used to outrank the derived principal outright. A site that
 *      takes the client's string and skips this function re-opens the hole no matter how
 *      careful this function is.
 * If you add a new surface that accepts a caller-declared actor, it goes through here.
 *
 * ── THE RESIDUAL: THE FLAT NAMESPACE IS SHARED, AND CANNOT BE SEPARATED HERE (Reviewer B2) ──
 * A principal with NO declared handle gets a FLAT actor (`victim@example.com`), and a caller
 * with no principal that declares that exact string gets the SAME flat actor. Measured, both
 * before and after normalizeActor folds case:
 *     sub='victim@example.com', no handle   -> "victim@example.com"
 *     no sub,  declared='victim@example.com' -> "victim@example.com"   ← IDENTICAL
 * So a declared-only caller CAN spell a bare principal's actor. This is pinned by a deliberate
 * negative test in actorRegistry.unit.test.ts so nobody re-derives the absolute reading.
 *
 * WHY IT IS NOT FIXED HERE, structurally (not a preference): an earlier decision LOCKS both flat
 * degenerate cases to the identity function — `sub only → sub` (so a lone human on the Claude.ai
 * connector configures nothing) and `declared only → declared` (so every static-bearer actor
 * keeps its name). Two identity functions over the same string domain, and a declared value is
 * arbitrary client text whose domain INCLUDES every principal string. Collisions there are not
 * merely possible, they are total. Separating the namespaces requires changing one of the two
 * locked cases — always-compose would rewrite the bare-sub actor; prefixing declared-only would
 * rename `coordinator`/`tick`/`builder-<id8>` on every runtime-plane tenant.
 *
 * WHY THAT IS ACCEPTABLE: it is exactly the trust level `X-Actor-ID` has on every static-bearer
 * tenant TODAY — anyone holding the tenant bearer can already declare `coordinator`. Composites do not
 * worsen it; they simply do not fix it. It stays acceptable ONLY while actor is ATTRIBUTION, per
 * the trust model below. If actor must ever become an authz boundary, the flat namespace is the
 * reason the answer is per-agent MINTED CREDENTIALS (an earlier decision's rejected-alternative
 * (a), kept as the named upgrade path), NOT a stronger string rule.
 *
 * ── TRUST MODEL (the same axis this file's header states at the top) ────────────────────
 * The actor is ATTRIBUTION, not an authz boundary — tenant isolation is at the container/DB
 * level, and every agent under one principal already holds that principal's full authority.
 * The honest statement of the rule is "declared data may REFINE, never REPLACE, the verified
 * identity". So: an actor is SPOOFABLE WITHIN A PRINCIPAL (an agent can claim to be a sibling
 * agent — costing attribution integrity only, which is exactly the trust level `X-Actor-ID`
 * already has on every static-bearer tenant today) and never across one INTO A COMPOSITE (the
 * prefix is applied server-side from the authenticated `sub`) — but a bare principal's FLAT
 * actor IS spellable by a declared-only caller, per the residual above. The composite does not
 * weaken the trust model; it makes OAuth tenants exactly as trustworthy as static-bearer ones,
 * which is a floor, not immunity. If actor ever becomes an
 * authz boundary, the upgrade path is per-agent minted credentials carrying the handle as a
 * verified claim — same string shape, higher trust grade.
 *
 * SHIPPED DARK: behind MANDREL_ACTOR_COMPOSITE_ENABLED, default OFF. With the
 * flag off this is the pre-change `sub > declared > undefined` ladder, byte for byte —
 * including the untouched pass-through of a declared handle containing a delimiter.
 *
 * Returns the RAW chosen string (normalization happens once at stamp time); blank strings
 * count as absent.
 */
export function deriveActor(authSub?: string | null, declared?: string | null): string | undefined {
  const a = authSub?.trim();
  const d = declared?.trim();

  // LEGACY (the shipped default): auth > declared > none. Do not touch — the golden-fixture
  // parity test pins this branch to the behavior captured from the pre-change commit.
  if (!compositeActorEnabled()) {
    if (a) return a;
    if (d) return d;
    return undefined;
  }

  // SCOPED COMPOSITION. The declared half is untrusted → SANITIZED on every path it can reach
  // (including the sub-less static-bearer path, where an un-sanitized declared value could
  // otherwise spell another principal's composite). The principal half is verified → ENCODED on
  // every path it is emitted (including the sub-only path, or a delimiter-bearing sub would
  // still collide with a composite — Reviewer N1).
  const safePrincipal = a ? encodePrincipalActor(a) : '';
  const safeDeclared = d ? sanitizeDeclaredActor(d) : '';
  if (safePrincipal && safeDeclared) {
    return `${safePrincipal}${ACTOR_COMPOSITE_DELIMITER}${safeDeclared}`;
  }
  if (safePrincipal) return safePrincipal;
  if (safeDeclared) return safeDeclared;
  return undefined;
}

/**
 * Refine an ALREADY-DERIVED actor with a caller-declared handle — the operation every
 * DOWNSTREAM site needs (closing an earlier context).
 *
 * ⚠️ THIS EXISTS BECAUSE `deriveActor` IS THE WRONG FUNCTION DOWNSTREAM. deriveActor's first
 * argument is a RAW VERIFIED PRINCIPAL, and it ENCODES it. An already-derived
 * `operator@example.com/coordinator` fed back through it comes out as `operator@example.com%2Fcoordinator/…` —
 * the composite shredded and re-nested. That double-derivation is a real trap: it is why the
 * stdio path (`MandrelMcpServer.ts`) must NOT be "cleaned up" to call deriveActor either.
 * Raw principal → deriveActor. Already-derived actor → refineActor. One rule, two entry points,
 * neither of which can be used for the other's job.
 *
 * THE RULE, which is an earlier decision's rule read literally — declared data may REFINE, never
 * REPLACE, the verified identity:
 *   no derived actor    → the sanitized declared handle (the static-bearer / dispatcher path)
 *   no declared handle  → the derived actor, untouched
 *   composites OFF      → the DERIVED actor wins; the declared handle never replaces it
 *   composites ON       → `<the derived actor's PRINCIPAL>/<sanitized declared handle>`
 *
 * Note the last case carefully: the declared value replaces the HANDLE segment, never the
 * PRINCIPAL segment. A caller can say "attribute this to a different agent OF MINE"; it can
 * never say "attribute this to somebody else". That preserves the legitimate dispatcher
 * use-case (the coordinator claiming on behalf of `builder-<id8>`) while making impersonation
 * unrepresentable, and it keeps the actor grammar at exactly two segments.
 */
export function refineActor(derived?: string | null, declared?: string | null): string | undefined {
  const base = derived?.trim();
  const d = declared?.trim();
  if (!base) return deriveActor(undefined, d);
  if (!d) return base;
  if (!compositeActorEnabled()) return base;
  const principal = base.split(ACTOR_COMPOSITE_DELIMITER)[0];
  return `${principal}${ACTOR_COMPOSITE_DELIMITER}${sanitizeDeclaredActor(d)}`;
}

/*
 * REMOVED: isKnownActor() (Reviewer N5, 2026-07-25). It answered "is this exact actor string
 * enumerated?" on the WHOLE string while classifyActor() answers the neighbouring question on
 * the HANDLE segment — two readings of one concept, guaranteed to drift the moment composites
 * are enabled. It had ZERO product consumers (tests only), so the fix is deletion, not a second
 * copy of the segment rule. If an enumeration check is ever genuinely needed, derive it from
 * classifyActor's subject so there is exactly one answer.
 */
