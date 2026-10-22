/**
 * The ONE prop every Embedding panel takes: the project the Embedding PAGE is scoped to
 * (epic 41293984 §E).
 *
 * ════════════════════════════════════════════════════════════════════════════════════
 *  WHY A PROP AND NOT A HOOK IN EACH PANEL
 * ════════════════════════════════════════════════════════════════════════════════════
 * All seven panels used to call `useEffectiveProjectId()` independently. Seven components
 * each deciding their own scope is seven chances to disagree, and it made the page's scope
 * un-selectable by construction: there was no single place a user could change, because
 * there was no single place that knew. The spec's requirement is ONE selector on the page
 * passed down to all seven — so the panels stop deciding and start being told.
 *
 * `undefined` means the page does not know its project yet (the list is still loading). It
 * does NOT mean "every project": each panel's query is gated off, and the honest "Select a
 * project" empty state renders. The embedding routes are header-scoped and several read a
 * missing project as an error rather than a filter, so guessing here is not a wider view,
 * it is a wrong one.
 *
 * These panels are still on the antd stack; migrating them is a separate job (spec "Out of
 * scope"). The SELECTOR on the page above them is the new token-driven primitive
 * regardless — this file is the seam between the two.
 */
export interface EmbeddingPanelProps {
  /** The project the page's selector names. `undefined` while it is still resolving. */
  projectId: string | undefined;
}
