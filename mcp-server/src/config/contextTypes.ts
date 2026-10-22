/**
 * CONTEXT TYPE DOMAIN — the one list every enum copy in this server derives from.
 *
 * Before this file the list lived three times in mcp-server alone (handlers/context.ts
 * type literal, two z.enum() calls in middleware/validation.ts) plus the prose in
 * opRegistry.ts; adding a type meant finding every copy. Now: the tuple below, the DB CHECK
 * constraint (contexts_context_type_check — see the migration that added the newest type),
 * and mandrel-command's ContextTypeSchema are the three copies that MUST agree, and each
 * names the others.
 *
 * `note` (the auditor rec b53c213f): the GENERIC capture type. In the Phase-3 eval
 * 5/7 stores guessed `type: "fact"` — an invalid value — because nothing generic existed.
 * The auditor's constraints, which this file encodes: NO server-side alias (a `fact` is REJECTED,
 * with a message that names `note`), and NO server-side default (a silent mislabel corrupts
 * durable memory). A model that reaches for a generic type gets a real one.
 */

import { z } from 'zod';

export const CONTEXT_TYPES = [
  'code',
  'decision',
  'error',
  'discussion',
  'planning',
  'completion',
  'milestone',
  'reflections',
  'handoff',
  'lessons',
  'note',
] as const;

export type ContextType = (typeof CONTEXT_TYPES)[number];

/** The generic capture type — what a caller wants when nothing more specific fits. */
export const GENERIC_CONTEXT_TYPE: ContextType = 'note';

/**
 * Values callers have been MEASURED reaching for that are NOT types and never will be
 * (aliasing them would let a mislabel through silently). Rejected with a hint naming the
 * generic type instead. Listed so the hint is grounded in what actually happened, not a
 * guess at synonyms.
 */
export const REJECTED_GENERIC_SYNONYMS: readonly string[] = ['fact'];

/** The comma-joined list for tool descriptions (opRegistry) — never hand-typed. */
export const CONTEXT_TYPES_LIST = CONTEXT_TYPES.join(', ');

/**
 * The hint appended when a caller sends an unknown type. Always names the generic type so a
 * model that guessed a synonym learns the honest answer in the same round trip.
 */
export function contextTypeRejectionHint(received: unknown): string {
  const wanted = typeof received === 'string' && REJECTED_GENERIC_SYNONYMS.includes(received)
    ? `There is no "${received}" type and it is deliberately NOT aliased. `
    : '';
  return `${wanted}For a generic capture that fits no specific type, use "${GENERIC_CONTEXT_TYPE}".`;
}

/**
 * The zod enum every context-type field uses. The errorMap replaces zod's default enum
 * message with one that carries the hint; utils/actionableError.ts detects a non-default
 * message and surfaces it after the allowed-values line.
 */
export function contextTypeEnum() {
  return z.enum(CONTEXT_TYPES, {
    errorMap: (issue, ctx) =>
      issue.code === z.ZodIssueCode.invalid_enum_value
        ? { message: contextTypeRejectionHint(ctx.data) }
        : { message: ctx.defaultError },
  });
}
