/**
 * THE PROJECT-REFERENCE PARAMETER CONTRACT.
 *
 * ONE sentence of product truth, written down once so the docs and the guard read the
 * SAME string instead of two programs agreeing by discipline:
 *
 *   **Every parameter that references a project accepts EITHER the project's UUID or its
 *   name, and says so in its own description.**
 *
 * WHY THIS FILE EXISTS. `config/opRegistry.ts` documented `projectId` as "Project ID or
 * name" on 31 parameters. On 2026-07-24 that was a CONTRACT LIE for at least twelve of them
 * — a name reached `AND project_id = $n` against a `uuid` column and Postgres raised
 * `invalid input syntax for type uuid` (an earlier task closed the behavioural half at the
 * routeExecutor choke point). But the DOCUMENTED half was still unguarded in both
 * directions: nothing tied a description's promise to the resolver's population, and
 * fifteen other project-reference params silently UNDERSTATED the capability
 * (`task_bulk_update.projectId` said "Project ID to validate ownership against", which a
 * reading agent takes as "id only"; `decision_update.projectId` and `task_update.projectId`
 * documented NOTHING at all). An agent client reads these descriptions AS the contract, so
 * a description that is narrower than the behaviour costs the same turn as one that is
 * wider — it just fails in the direction of the agent not trying.
 *
 * So the rule is an IFF, not an implication, and it is enforced as a gate:
 * `src/tests/projectNameContract.contract.test.ts` walks every project-reference parameter
 * of every op in OP_REGISTRY and REDs unless BOTH halves hold —
 *   (a) the description carries {@link PROJECT_REF_CONTRACT_PHRASE}, and
 *   (b) the parameter actually resolves a NAME (proven at the choke point for `scoped`
 *       params, and end-to-end for the `exempt` administration params).
 * The population is DERIVED from the registry + each op's own zod schema, so an op added
 * tomorrow is inside the guard the day it is born and there is no list to maintain.
 *
 * IF YOU ADD A PROJECT-REFERENCE PARAM: put PROJECT_REF_CONTRACT_PHRASE in its description
 * verbatim, and make sure it resolves a name. Both are checked; neither is optional.
 */

/**
 * The canonical, verbatim phrase every project-reference parameter description must
 * contain. Case-sensitive substring — a paraphrase ("project name (or id)") is NOT
 * accepted, deliberately: an agent scanning 60 tool schemas benefits far more from one
 * recognisable token than from fifteen equivalent English sentences, and an exact token is
 * a thing a gate can actually enforce.
 */
export const PROJECT_REF_CONTRACT_PHRASE = 'Project ID or name';

/**
 * The single, caller-facing sentence for what an UNRESOLVABLE or BLANK project reference
 * does. Lives here rather than in each error class so the promise and the failure mode are
 * described in one place.
 */
export const PROJECT_REF_FAILURE_CONTRACT =
  'A project reference that names no existing project is refused with a typed error naming ' +
  'the value — never a raw database error and never a silent fall-back to another project.';
