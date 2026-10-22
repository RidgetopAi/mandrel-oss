/**
 * A param name that `task_update` genuinely does NOT declare — DERIVED from the live zod
 * schema, never typed in.
 *
 * WHY THIS EXISTS: two contract suites prove that strict mode rejects an undeclared param
 * and that the rejection is classified as a CLIENT error, not a 5xx. Both used the literal
 * string `notes`, because that is the param from the prod report the contract was written
 * against. an earlier Task then DECLARED `notes` on task_update — correctly; it is now the
 * append affordance — and in the same stroke made five assertions in those two files stop
 * exercising anything: the request became VALID, so there was no rejection left to
 * classify. Nobody edited a guard; a guard's SUBJECT was legalised out from under it.
 *
 * Deriving the subject makes that impossible. Declaring one candidate re-points the guards;
 * declaring all of them fails loudly here instead of passing silently.
 *
 * Shared by both suites on purpose — a second copy of this rule is the drift it prevents.
 */
import { validationSchemas } from '../../middleware/validation.js';

/** Candidates, in order. Each is a plausible-but-unclaimed name on the task write surface. */
const CANDIDATES = ['statusNote', 'annotation', 'commentary', 'sidecar', 'scratch'] as const;

export function undeclaredTaskUpdateParam(): string {
  let schema: any = (validationSchemas as any).task_update;
  // The schema is wrapped by .refine(), so `.shape` is not on the outer object — same
  // unwrap the shipped declaredParamKeys/requiredKeys use.
  while (schema?._def?.typeName === 'ZodEffects') schema = schema._def.schema;
  const declared = new Set(Object.keys(schema.shape));
  const found = CANDIDATES.find((c) => !declared.has(c));
  if (!found) {
    throw new Error(
      `undeclaredTaskUpdateParam: task_update now declares every candidate ` +
      `(${CANDIDATES.join(', ')}). Add a new one — do not delete the tests that use this.`,
    );
  }
  return found;
}
