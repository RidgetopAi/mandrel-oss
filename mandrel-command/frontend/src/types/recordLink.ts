/**
 * One typed graph edge touching a record — the TreeWalker "thread box" moat, served by
 * GET /api/<record>/:id/links for a context, task, OR decision (the one shared backend
 * resolver, LinkService.getLinksForRecord). A REAL `links`-table row (structure), NOT a
 * semantic `related` result.
 *
 * `direction: 'outgoing'` reads forward from the subject record; 'incoming' points at it
 * (rendered with the reverse label). `otherKind` is the OTHER endpoint's kind for
 * colour/label — a context's `context_type` (milestone/handoff/…), or 'decision'/'task'.
 *
 * Structurally identical to the older `ContextLink` / `TaskLink` types (which pre-date this
 * shared type); new screens use `RecordLink` rather than adding another copy.
 */
export interface RecordLink {
  edgeType: string;
  direction: 'outgoing' | 'incoming';
  otherId: string;
  otherType: 'context' | 'decision' | 'task';
  otherTitle: string;
  otherKind: string;
}
