/**
 * RECORD SERIALIZERS — the one place per record type that enumerates wire fields
 * (the class behind the unreadable-field defect).
 *
 * ═══ THE CLASS ═══
 * The unreadable-field defect was not in a mapper. `dueAt`/`blockedOn` were stored, mapped, and
 * echoed by the write path — and task_details never returned them, because its
 * structuredContent was a HAND-WRITTEN field-by-field literal that nobody extended when the
 * columns landed. The same literal existed, unaudited, on task_list, the create/update
 * echoes, and every context and decision route: N copies of "what a <type> looks like on
 * the wire", each free to forget a field the others carry.
 *
 * ═══ THE FIX ═══
 * ONE serializer per record type. Every route that puts a task / context / decision on the
 * wire calls it. A field added here reaches every reader; a field added to a handler's read
 * model and not here is caught by taskFieldsReadable.contract.test.ts (values) and
 * recordSerializer.contract.test.ts (every record-bearing op, derived from the output-schema
 * registry, must return objects THIS module produced).
 *
 * ═══ THE MARK, AND WHY YOU MUST NOT SPREAD THE RESULT ═══
 * Each serializer registers its output in a module-private WeakSet. The contract guard walks
 * every record-bearing response and asserts each record object is a member — that is how a
 * route that reverts to a hand literal goes RED without the guard having to know what the
 * literal forgot. `{ ...serializeTask(t), extra }` builds a NEW object and drops the mark,
 * so it fails the guard on purpose: route-specific additions go through `extras`, which the
 * serializer merges BEFORE marking. The mark carries no wire bytes (WeakSet, not a property).
 *
 * WIRE COMPATIBILITY: these emit the UNION of the fields the per-route literals emitted, so
 * no existing key changes name or value; routes that emitted a subset now emit more.
 */

export type RecordKind = 'task' | 'context' | 'decision';

const MARKS: Record<RecordKind, WeakSet<object>> = {
  task: new WeakSet(),
  context: new WeakSet(),
  decision: new WeakSet(),
};

/** Register a finished record object as produced by its serializer. */
export function markSerialized<T extends object>(kind: RecordKind, record: T): T {
  MARKS[kind].add(record);
  return record;
}

/** True iff `obj` is exactly an object a `serialize<Kind>` call returned (not a copy). */
export function isSerializedRecord(kind: RecordKind, obj: unknown): boolean {
  return typeof obj === 'object' && obj !== null && MARKS[kind].has(obj);
}

/** ISO-8601 for a Date or date-string; null for null/undefined. Shared by all three. */
export function toIso(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
