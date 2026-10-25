/**
 * TOOL-SURFACE BYTE-IDENTICAL SNAPSHOT — MCP-2026 rebuild Phase 1.
 *
 * THE SAFETY NET for a zero-surface refactor. Phase 1 replaced the hand-written
 * AIDIS_TOOL_DEFINITIONS + TOOL_CATEGORIES with artifacts DERIVED from config/opRegistry.ts.
 * The whole point is that deriving-from-the-registry changed NOTHING on the wire.
 *
 * This test serializes the full advertised surface (the tool definitions + category
 * grouping + order) and asserts it is BYTE-IDENTICAL to a golden fixture captured from the
 * PRE-refactor code (git main @e9b6025, before opRegistry.ts existed). If a future change to
 * the registry, buildInputSchema, or a zod validator shifts a single byte of the advertised
 * `tools/list`, this fails LOUD and names the exact diff.
 *
 * IF THIS FAILS: do NOT loosen the assertion or regenerate the fixture to make it pass. A
 * diff means the surface changed. Either the change is intended (a real, reviewed surface
 * change — regenerate the golden deliberately, in its own commit, with the wire delta called
 * out) or it is an accidental regression to fix. The fixture is ground truth, not a snapshot
 * to rubber-stamp.
 *
 * Regenerating the golden (only when the surface change is intentional + reviewed):
 *   the fixture shape is exactly `JSON.stringify({definitions, categoryOrder, toolCategories}, null, 2) + '\n'`.
 *
 * ── DELIBERATE REGENERATIONS (the wire delta, called out) ───────────────────────────────
 *
 * 2026-09-21 · an earlier decision (Punch List lane A, the STRUCTURED
 *   contract) — `punch.doneWhen` becomes an array of `{ text, owner: lane|human, proof? }`
 *   clauses (the legacy bare string is still accepted, unguarded, off-`ready`); `punch` gains
 *   `touches` (repo-relative paths/globs) and `dependsOn` (server-mirrored from
 *   `dependencies`, refused if set directly — [PUNCH_DEPENDS_ON_DIRECT]). No tool added,
 *   removed or renamed (70 -> 70); no existing param retyped or removed — `punch`'s shape
 *   widened (new optional sub-keys) and three `description` strings (task_create/task_update/
 *   task_bulk_update's `stage` and `punch`) were rewritten to state the clause shape and the
 *   new refusal codes, so a caller reads the rule before tripping it.
 *   MEASURED delta, `DATABASE_NAME=mandrel_builder GOLDEN_PATH=src/tests/fixtures/toolSurface.golden.json WRITE=1 npx tsx scripts/regen-tool-surface-golden.ts`:
 *     fixture      — wc -c on the pretty fixture: 263,633 -> 270,667 (+7,034, +2.67%)
 *     tools/list   — compact JSON.stringify(AIDIS_TOOL_DEFINITIONS): 139,475 -> 142,693 (+3,218, +2.31%)
 *     per-tool     — task_create 11,286 -> 13,432 (+2,146); task_update 10,731 -> 13,113
 *                    (+2,382); task_bulk_update 4,965 -> 6,847 (+1,882)
 *     TOOLS WHOSE BYTES MOVED = 3 · ADDED 0 · REMOVED 0 · tool count 70 -> 70
 *
 * 2026-09-10 · migration 101 / an earlier decision (Punch List lane A) — the seven-stage
 *   Punch List lane joins the task surface. `task_create` gains `stage`/`punch`;
 *   `task_update` gains `stage`/`punch`; `task_bulk_update` gains `stage`/`punch`;
 *   `task_list` gains a `stage` filter (single value or array). No tool added, removed or
 *   renamed (70 -> 70). Setting stage:"ready" without title + punch.doneWhen +
 *   punch.proofKind + a resolved project is refused with [PUNCH_INCOMPLETE] — the human
 *   descriptions for all four params state that rule so a caller reads it before tripping it.
 *   MEASURED delta, regen-tool-surface-golden.ts: fixture 255,829 -> 263,633 (+7,804 bytes,
 *   entirely new param declarations/descriptions — no existing param's shape changed).
 *
 * 2026-09-08 · an earlier task (REALIGN step 9, TAXONOMY) — the context-type domain gains
 *   `note`, the GENERIC capture type (eval: 5/7 stores guessed the invalid `fact`). NO tool
 *   added, removed or renamed (70 -> 70, printed by the regen script); no param retyped. TWO
 *   `description` strings change, both now derived from config/contextTypes.ts instead of
 *   hand-typed: context_store's `type` (list + the sentence naming `note` as generic and
 *   `fact` as not aliased) and context_search's `type` filter (list only).
 *   MEASURED delta, regen-tool-surface-golden.ts: fixture 254,227 -> 254,403 (+176).
 *   WHY IT HAD TO REACH THE WIRE: the enum is closed at the zod gate and the DB CHECK
 *   (migration 100); a caller cannot store a type the description omits.
 *
 * 2026-09-08 · an earlier task (REALIGN step 5) — ONE description string changes, no schema
 *   change: `task_create`'s description gains the sentence naming the agent fold-in gate
 *   (`[TASK_CREATE_AGENT_FOLD_IN]`, exempt tag `needs-operator`, roster `MANDREL_AGENT_ACTORS`).
 *   The gate refuses a listed agent's create unless the task is marked as needing a human decision;
 *   the explain line is the one place an agent reads the rule before it trips it.
 * 2026-09-08 · an earlier task round 3 — ONE new registered guard class joins the closed
 *   `class:` axis (GUARD_CLASS_VALUES, mirroring scripts/config/guard-classes.conf; the CI gate
 *   STAGE 0a22d keeps the two equal): `secret-on-child-argv`.
 *   The class: a secret is handed to a child process on its ARGV (docker -e K=V, node -e
 *   "$pw", psql -c, curl -d, sed -e), world-readable in /proc for the child's lifetime; each
 *   fix moved it off ONE child while the next child in the same pipeline still carried it.
 *   Detector: the CI gate STAGE 0a20d, scripts/test/secret-argv.test.sh (PATH-shadow argv shims).
 *   MEASURED delta, regen-tool-surface-golden.ts, which emits its own numbers:
 *     fixture      — wc -c pretty fixture: 253,928 -> 253,949 (+21, 0.01%)
 *     tool count   — 70 -> 70 (unchanged)
 *   +21 is the class id (20 characters) plus its `|` separator; one line changed / one
 *   removed in `git diff --numstat` on the fixture.
 *
 * 2026-09-07 · an earlier task round 5 — ONE new registered guard class joins the closed
 *   `class:` axis (GUARD_CLASS_VALUES, mirroring scripts/config/guard-classes.conf; the CI gate
 *   STAGE 0a22d keeps the two equal): `two-channel-answer-read-through-one`.
 *   The class: an answer that travels on two channels — a CARRIER saying the call RAN and a
 *   PAYLOAD saying what HAPPENED — is read through only one, so a claim is minted from
 *   evidence that cannot support it. It recurs on ALTERNATING channels, which is why four
 *   instances in one task read as four different bugs: a 404 carrier read as "posture
 *   broken", a failed `docker network ls` read as "zero networks", an invalid regex read as
 *   "nothing matched", a 200 carrier read as "the context was archived".
 *   ONE row deliberately, not four: filing a row per instance is what let the class recur.
 *   Detector is STAGE 0a11f plus scripts/test/two-channel-readers.test.sh.
 *   NO tool added, removed or renamed (count 70 -> 70, printed by the regen script). No
 *   param added, retyped or removed. No outputSchema touched. The delta is ONE `description`
 *   string: context_store's `tags` param, whose derived lensAxesSummary() enumerates the
 *   axis's values, 27 -> 28.
 *   WHAT AN EXISTING CONSUMER SEES ON THE WIRE: nothing structural; one prose string grew.
 *   WHY IT HAD TO REACH THE WIRE: the axis is CLOSED, so a value outside the advertised set
 *   is quarantined — a caller cannot write a valid tag for a class the description omits.
 *   MEASURED delta, regen-tool-surface-golden.ts (WRITE=1), which emits its own numbers:
 *     fixture      — wc -c pretty fixture: 253,892 -> 253,928 (+36, 0.01%)
 *     tools/list   — COMPACT wire payload:  133,774 -> 133,810 (+36, 0.03%)
 *     per-tool     — context_store [CHANGED] 10,490 -> 10,526 (+36); TOOLS MOVED = 1,
 *                    ADDED 0, REMOVED 0
 *   +36 is the class id (35 characters) plus its `|` separator; one line changed / one
 *   removed in `git diff --numstat` on the fixture.
 *
 * 2026-09-07 · an earlier task (canary S1 smoke asserted against a project that does not
 *   exist) — TWO new registered guard classes join the closed `class:` axis
 *   (GUARD_CLASS_VALUES, mirroring scripts/config/guard-classes.conf; the CI gate STAGE 0a22d keeps
 *   the two equal):
 *     `sweep-removes-without-detaching` — a cleanup sweep removes a resource without
 *       releasing what still holds it, swallows the daemon's refusal, and asserts nothing
 *       afterwards, so every run leaks one more of a finite pooled resource. Measured
 *       instance: canary-tenant script ran `docker network rm` with no preceding
 *       `docker network disconnect`, so twelve failed runs stranded twelve networks on a box
 *       whose docker defaults yield ~31. Detector is STAGE 0a11e plus
 *       the canary network-reclaim test.
 *     `verdict-from-uncontracted-status` — a check compares a status code with == so any
 *       status it has no contract for renders as a verdict about the system. Measured
 *       instance: the provisioner's step-8 write smoke expected 403 and got 404
 *       ([PROJECT_ARG_UNRESOLVED], raised ahead of the session posture gate), which it
 *       reported as "the posture is broken" — twelve confident false REDs on a healthy
 *       fleet. Detector is STAGE 0a11d plus sections 4f/4g of
 *       scripts/test/provisioner-posture.test.sh.
 *   NO tool added, removed or renamed (count 70 -> 70, printed by the regen script). No param
 *   added, retyped or removed. No outputSchema touched. The delta is ONE `description`
 *   string: context_store's `tags` param, whose derived lensAxesSummary() enumerates the
 *   axis's values, 25 -> 27.
 *   WHAT AN EXISTING CONSUMER SEES ON THE WIRE: nothing structural; one prose string grew.
 *   WHY IT HAD TO REACH THE WIRE: the axis is CLOSED, so a value outside the advertised set
 *   is quarantined — a caller cannot write a valid tag for a class the description omits.
 *   MEASURED delta, regen-tool-surface-golden.ts (WRITE=1), which emits its own numbers:
 *     fixture      — wc -c pretty fixture: 253,827 -> 253,892 (+65, 0.03%)
 *     tools/list   — COMPACT wire payload:  133,709 -> 133,774 (+65, 0.05%)
 *     per-tool     — context_store [CHANGED] 10,425 -> 10,490 (+65); TOOLS MOVED = 1,
 *                    ADDED 0, REMOVED 0
 *   +65 is the two class ids (31 + 32 characters) plus their two `|` separators, and one
 *   line changed / one removed in `git diff --numstat` on the fixture.
 *
 * 2026-09-05 · batch 15, lane H (provisioner session posture) — ONE new registered guard
 *   class, `generator-omits-fleet-posture`, joins the closed `class:` axis
 *   (GUARD_CLASS_VALUES, mirroring scripts/config/guard-classes.conf; the CI gate STAGE 0a22d keeps
 *   the two equal). The class: a GENERATOR writes an instance's config without a fleet
 *   posture key, so every instance it produces resolves that key from the permissive CODE
 *   DEFAULT and is born pre-drifted — remediating the instances leaves the generator intact.
 *   Measured instance: the hosted provisioner never wrote MANDREL_SESSION_REQUIRE_ACTOR
 *   or MANDREL_SESSION_RESOLVER_MODE, so two live tenants accepted actorless writes.
 *   Detector is STAGE 0a11d plus scripts/test/provisioner-posture.test.sh.
 *   NO tool added, removed or renamed (count 69 -> 69, printed by the regen script). No param
 *   added, retyped or removed. No outputSchema touched. The delta is ONE `description`
 *   string: context_store's `tags` param, whose derived lensAxesSummary() enumerates the
 *   axis's values, 24 -> 25.
 *     fixture    — regen script `fixture bytes`:      248,267 -> 248,297
 *     tools/list — regen script `tools/list compact`: 129,387 -> 129,417
 *   +30 bytes on both is exactly `generator-omits-fleet-posture` (29) plus its `|` separator,
 *   and `git diff --numstat` on the fixture is `1 1` — one line changed, nothing else moved.
 *   The 129,387 baseline was measured on THIS ref by deleting the new axis value, re-running
 *   the regen script, reading its printed figure and restoring both files — not carried
 *   forward from an earlier entry (a carried number is the one that is wrong).
 *   REGEN GOTCHA (recurred exactly as the entry below predicted): the regen script needs a
 *   dummy `DATABASE_NAME`; it never connects.
 *   WHAT AN EXISTING CONSUMER SEES ON THE WIRE: nothing structural; one prose string grew by
 *   the length of the new value plus its separator.
 * 2026-09-05 · an earlier task (batch 15, lane D — the task record's own lifecycle) — FIVE new
 *   public wire params across three tools, plus a description for each. Logged as ONE entry
 *   because they are one change; this branch's earlier two commits regenerated the fixture
 *   WITHOUT an entry, and that omission is what this repairs (Reviewer F-D).
 *     task_list        + createdAfter, createdBefore, closedAfter — the flow filters.
 *                        Answering "do we generate more tasks than we close?" previously cost
 *                        a 1,212-row sweep plus 1,212 task_details calls. `closedAfter` and
 *                        NOT `completedAfter`: closing has two doors, and a number counting
 *                        only completions misses bulk cancellations entirely.
 *     task_update      + dependencies — the column was WRITE-ONCE AT CREATE (declared on
 *                        task_create, absent from task_update's schema AND from the handler's
 *                        SET builder), so no task could acquire a dependency after it was
 *                        filed. It is a FULL REPLACE and its description says so: that
 *                        semantic is not guessable, which is why its neighbour `tags` spells
 *                        out the same thing.
 *     task_bulk_update + blockedOn — a board sweep blocking N tasks behind one freeze is a
 *                        real use of this tool, and status=blocked now requires a named
 *                        blocker, so without this param the rule would be unsatisfiable here.
 *   NO tool added, removed or renamed (count 69 -> 69, printed by the regen script). No
 *   existing param retyped or removed. No outputSchema touched. Every new param carries a
 *   `description` — a description-less wire param is itself the defect.
 *     fixture — `wc -c src/tests/fixtures/toolSurface.golden.json`: 248,267 -> 251,253
 *   Measured against this branch's point of departure, `git diff --numstat` on the
 *   fixture is 39/0 (added/removed) — purely additive, nothing moved.
 *   AMENDED in the same branch: `task_update.dependencies` first shipped a storage promise —
 *   "an id that names no existing task is REFUSED, never stored" — which is not a property of
 *   the param. `task_create.dependencies` goes through the identical resolver and makes no
 *   such claim, so the two params of one column contradicted each other. The clause is DELETED
 *   and the wording matches create ("resolved like every other id arg"); the existence fact
 *   now sits on the status-rule sentence, where it describes the GATE rather than storage.
 *
 * 2026-09-04 · an earlier task (batch 14, lane B — instrument accounting) — ONE new registered
 *   guard class, `unpinned-instrument-verdict`, joins the closed `class:` axis
 *   (GUARD_CLASS_VALUES, mirroring scripts/config/guard-classes.conf; the CI gate STAGE 0a22d keeps
 *   the two equal). The class: a stage's verdict is produced by an external binary whose
 *   version the gate never established, so two boxes answer differently on the same ref and
 *   the LOCAL green is the weaker measurement with nothing saying so. Detector is STAGE IN
 *   plus scripts/test/instrument-accounting.test.sh.
 *   NO tool added, removed or renamed (count 69 -> 69, printed by the regen script). No param
 *   added, retyped or removed. No outputSchema touched. The delta is ONE `description`
 *   string: context_store's `tags` param, whose derived lensAxesSummary() enumerates the
 *   axis's values, 23 -> 24.
 *     fixture — `wc -c src/tests/fixtures/toolSurface.golden.json`: 248,239 -> 248,267
 *   +28 bytes is exactly `unpinned-instrument-verdict` (27) plus its `|` separator, and
 *   `git diff --numstat` on the fixture is `1 1` — one line changed, nothing else moved.
 *   REGEN GOTCHA, recorded because it will recur: `npx tsx src/tests/regen-tool-surface-golden.ts`
 *   dies with "DATABASE_NAME environment variable is required!" — an import-time side effect of
 *   config/database.ts, not a real dependency. Any dummy value regenerates correctly; the script
 *   never connects. Run it as `DATABASE_NAME=regen_noop_not_a_real_db npx tsx …`.
 *   WHAT AN EXISTING CONSUMER SEES ON THE WIRE: nothing structural; one prose string grew by
 *   the length of the new value plus its separator.
 *
 * 2026-09-03 · BATCH 13 MERGE NOTE (Coordinator) — the two entries below landed on SEPARATE lanes
 *   (two changes, one of them the gate-exit-code fix) that each registered one guard class and each regenerated this
 *   fixture against a 21-value axis. They conflicted here, which is the correct outcome: two
 *   independent writers to a closed, customer-visible axis SHOULD collide rather than one
 *   silently overwrite the other's regeneration. Resolved by keeping both entries and
 *   REGENERATING from the merged tree, never by choosing a side — picking one would have
 *   shipped a fixture asserting 22 values against a 23-value axis.
 *   Combined on the merged ref: the axis goes 21 -> 23, count 69 -> 69, no param, no
 *   outputSchema. The per-entry byte figures below are each measured against the 21-value
 *   baseline and so do NOT sum to the merged delta; the merged numbers are the ones the
 *   regen script printed on this ref:
 *     fixture      — wc -c pretty fixture: 248,217 -> 248,239 (+22, 0.01%)
 *     tools/list   — COMPACT wire payload:  129,337 -> 129,359 (+22, 0.02%)
 *     per-tool     — context_store [CHANGED] 10,345 -> 10,367 (+22)
 *     TOOLS MOVED = 1 · ADDED 0 · REMOVED 0 · count 69 -> 69
 *   (the 248,217 baseline is lane F's already-regenerated fixture, so the +22 here is lane
 *    H's class alone; against the pre-batch 248,186 baseline the combined delta is +53.)
 *
 * 2026-09-03 · an earlier task (batch 13, single-FILE bind mounts) — ONE new registered guard
 *   class, `stale-file-bind-mount`, joins the closed `class:` axis (GUARD_CLASS_VALUES,
 *   mirroring scripts/config/guard-classes.conf; the CI gate STAGE 0a22d keeps the two equal).
 *   NO tool added, removed or renamed (count 69 -> 69). No param added, retyped or removed.
 *   No outputSchema touched. The delta is ONE `description` string: context_store's `tags`
 *   param, whose derived lensAxesSummary() enumerates the axis's values, 21 -> 22.
 *   WHAT AN EXISTING CONSUMER SEES ON THE WIRE: nothing structural; one prose string grew by
 *   the length of the new value plus its separator.
 *   WHY IT HAD TO REACH THE WIRE: the axis is closed, so a caller that cannot see the value
 *   cannot write a valid tag for it — the same reason the entries below give.
 *   MEASURED delta, mcp-server/scripts/regen-tool-surface-golden.ts (WRITE=1), which emits
 *   its own numbers:
 *     fixture      — wc -c pretty fixture: 248,186 -> 248,208 (+22, 0.01%)
 *     tools/list   — COMPACT wire payload:  129,306 -> 129,328 (+22, 0.02%)
 *     per-tool     — context_store [CHANGED] 10,314 -> 10,336 (+22); TOOLS MOVED = 1, ADDED 0, REMOVED 0
 *     tool count   — AIDIS_TOOL_DEFINITIONS.length: 69 -> 69
 * 2026-09-03 · an earlier task (batch 13, lane F) — ONE new registered guard class,
 *   `renderer-drops-structured-fact`, joins the closed `class:` axis (GUARD_CLASS_VALUES,
 *   mirroring scripts/config/guard-classes.conf; the CI gate STAGE 0a22d keeps the two equal).
 *   Same shape as the 2026-09-02 entry below, and found the same way it should be: the class
 *   was registered in one commit and the fixture regenerated in the next, so the full suite
 *   was RED on a branch whose product change had nothing to do with the tool surface.
 *   NO tool added, removed or renamed (count 69 -> 69, printed by the regen script). No param
 *   added, retyped or removed. No outputSchema touched. The delta is ONE `description`
 *   string: context_store's `tags` param, whose derived lensAxesSummary() enumerates the
 *   axis's values, 21 -> 22.
 *     fixture — `wc -c src/tests/fixtures/toolSurface.golden.json`: 248,186 -> 248,217
 *   +31 bytes is exactly `renderer-drops-structured-fact` (30) plus its `|` separator, and
 *   `git diff --numstat` on the fixture is `1 1` — one line changed, nothing else moved.
 *   WHAT AN EXISTING CONSUMER SEES ON THE WIRE: nothing structural; one prose string grew by
 *   the length of the new value plus its separator.
 *
 * 2026-09-02 · an earlier task (batch 12, schema-parity) — ONE new registered guard
 *   class, `ledger-trusted-over-object`, joins the closed `class:` axis (GUARD_CLASS_VALUES,
 *   mirroring scripts/config/guard-classes.conf; the CI gate STAGE 0a22d keeps the two equal).
 *   NO tool added, removed or renamed (count 69 -> 69). No param added, retyped or removed.
 *   No outputSchema touched. The delta is ONE `description` string: context_store's `tags`
 *   param, whose derived lensAxesSummary() enumerates the axis's values, 20 -> 21.
 *   WHAT AN EXISTING CONSUMER SEES ON THE WIRE: nothing structural; one prose string grew by
 *   the length of the new value plus its separator.
 *   WHY IT HAD TO REACH THE WIRE: the axis is closed, so a caller that cannot see the value
 *   cannot write a valid tag for it — the same reason the 2026-09-01 entry below gives.
 *   MEASURED delta, regen-tool-surface-golden.ts (WRITE=1), which emits its own numbers:
 *     fixture      — wc -c pretty fixture: 248,159 -> 248,186 (+27, 0.01%)
 *     tools/list   — COMPACT wire payload:  129,279 -> 129,306 (+27, 0.02%)
 *     per-tool     — context_store [CHANGED] 10,287 -> 10,314 (+27); TOOLS MOVED = 1, ADDED 0, REMOVED 0
 *     tool count   — AIDIS_TOOL_DEFINITIONS.length: 69 -> 69
 *
 * 2026-09-01 · guard-class registry — `class:` becomes a CLOSED lens axis.
 *   NO tool added, removed or renamed (count 69 -> 69). No param added, retyped or removed.
 *   No outputSchema touched. The delta is ONE `description` string: context_store's `tags`
 *   param, which advertises the derived lensAxesSummary() and now lists the `class:` axis
 *   with its 20 registered values.
 *   WHAT AN EXISTING CONSUMER SEES ON THE WIRE: nothing structural; one prose string grew.
 *   WHY IT HAD TO REACH THE WIRE: the axis went from write-only (28 tasks under one value,
 *   `guards-need-guarding`, joined by prose) to a closed set that mirrors
 *   scripts/config/guard-classes.conf (the CI gate STAGE 0a22d keeps the two lists equal). A
 *   value outside the set is quarantined like any other lens value, so the description
 *   must say what the set IS or a caller has no way to write a valid one.
 *   MEASURED delta, regen-tool-surface-golden.ts + `git diff --numstat` (1 added / 1 removed):
 *     fixture    — 247,685 -> 248,159 (+474, +0.19%)
 *     tools/list — compact 129,279
 *
 * 2026-08-31 · an earlier task — task_list can answer "which branch was this written on".
 *   NO tool added, removed or renamed (count 69 -> 69). No param added, retyped or removed.
 *   No REQUEST schema touched at all.
 *   OUTPUT schemas touched: the shared `taskRecord`, so all SEVEN tools that return one —
 *   task_create, task_list, task_update, task_details, task_delete, task_restore,
 *   cancel_task. The change is PURELY ADDITIVE and MEASURED so: `git diff --numstat` on the
 *   fixture is 189 added / 0 removed, and the diff contains ZERO removed lines.
 *     + branchMembership: {spineId, spineType, source} | null — OPTIONAL and NULLABLE, on
 *       each of the seven (7 occurrences of each key).
 *   WHAT AN EXISTING CONSUMER SEES ON THE WIRE: nothing it did not see before. The field is
 *   optional, so no existing response becomes invalid, and no existing field changed type.
 *   WHY IT HAD TO BE DECLARED RATHER THAN RIDE `.passthrough()`: this field exists FOR a
 *   consumer to read — runtime's branch-board, which currently counts a task as
 *   branchless from the `branch:` TAG alone and so calls declared spine members loose. A
 *   field a consumer is required to read is a contract; an undeclared one is a contract
 *   nobody can see, and the next reader would have no way to know `null` and ABSENT are
 *   different answers here.
 *   Only task_list POPULATES it today (it is the reader that joins). The other six declare
 *   it and omit it, which is the honest shape: absent means nobody looked.
 *     fixture    — 241,891 -> 247,685 (+5,794, +2.4%)
 *
 * 2026-08-31 · an earlier task — task_list's `phase` filter stops assuming ONE spelling.
 *   NO tool added, removed or renamed (count 69 -> 69). No param added, retyped or removed.
 *   No outputSchema touched. The delta is ONE `description` string: task.list's `phase`
 *   param.
 *   WHAT AN EXISTING CONSUMER SEES ON THE WIRE: nothing structural. Every field, type and
 *   name is byte-identical; only that one prose string grew.
 *   WHY IT HAD TO REACH THE WIRE: the old string was a specific, checkable claim about
 *   BEHAVIOUR — "matches a `phase-<phase>` tag" — and that behaviour changed. It now matches
 *   every separator/case spelling of the phase tag (phase-3, phase:3, phase_3, phase.3,
 *   "phase 3", phase3). A caller reading the old description would have concluded, wrongly,
 *   that a `phase:5`-tagged task is out of reach of this parameter. Leaving the string alone
 *   would have left a documented contract narrower than the shipped one.
 *   MEASURED delta, regen-tool-surface-golden.ts:
 *     fixture    — 241,586 -> 241,891 (+305, +0.13%)
 *
 * 2026-08-28 · an earlier task — an unusable threading VALUE is quarantined, not disguised.
 *   NO tool added, removed or renamed (count 69 -> 69). No param added, retyped or removed.
 *   No outputSchema touched. The delta is TWO `description` strings, both on the `tags`
 *   param — context.store and task.update — and it is a DOCUMENTATION change describing a
 *   BEHAVIOUR change made in utils/threadingTags.ts.
 *   WHAT AN EXISTING CONSUMER SEES ON THE WIRE: nothing structural. Every field, type and
 *   name is byte-identical; only prose grew. The `never rejected` guarantee those strings
 *   already made is UNCHANGED and still true — writes still succeed and no tag is dropped.
 *   WHAT THE PROSE NOW ADDS: that a threading value the grammar cannot use is STORED AS
 *   `invalid-<tag>` rather than verbatim. That had to reach the wire, because the stored
 *   value now differs from the submitted one; a caller that reads its own tags back would
 *   otherwise find a string it never wrote, documented nowhere.
 *   MEASURED delta, `git diff --numstat` on this fixture: 2 lines added, 2 removed.
 *     fixture    — 239,645 -> 239,873 (+228, +0.10%)
 *   AMENDED in the same task, one line further: `context:<uuid>` -> `context:<id8|uuid>` on
 *   context.store's `tags`. This is a WIDENING of what the surface documents as acceptable,
 *   and it MATCHES what the server already did — tagEdgeConfig has always handed an id8 to
 *   the resolver and minted the edge. The doc was the thing that was wrong.
 *     fixture    — 239,873 -> 239,877 (+4)
 *
 * 2026-08-28 · an earlier task — `historical` SPLITS "we shipped it" from "we gave up on it".
 *   NO tool added, removed or renamed (count 69 -> 69). No param added, retyped or removed.
 *   ONE outputSchema touched: `recall_thread`.currentState, and the change is PURELY ADDITIVE.
 *     + omitted.historical.completed / .abandoned / .unknown — each {count, byType, sampleIds,
 *       sampleOmitted}
 *     + counts.historicalCompleted / .historicalAbandoned / .historicalUnknown
 *   WHAT AN EXISTING CONSUMER SEES: nothing it already reads changes. `omitted.historical
 *   .count`, `omitted.historical.byType` and `counts.historical` keep their exact prior
 *   meaning and value — `historical` stays the UMBRELLA, and the three new numbers SUM to it
 *   (the projector THROWS if they ever do not). No field was removed, so no consumer breaks;
 *   a consumer that wants the distinction opts in by reading the new keys.
 *   WHY THE WIRE HAD TO CHANGE: the distinction is unavailable server-side otherwise. The
 *   historical bucket is COUNTED, not listed, so a caller has no records to inspect and no
 *   way to derive "shipped" vs "abandoned" from the response it gets. A capability that only
 *   exists as a number has to be published as a number.
 *   MEASURED delta, `git diff --numstat` on this fixture: 107 lines added, 2 removed (both
 *   removals are trailing-comma reflow inside `required` arrays — "byType" and "historical" —
 *   NOT field removals).
 *     fixture    — 235,115 -> 239,073 (+3,958, +1.68%)
 *     tools/list — compact after: 124,936
 * 2026-08-28 · batch-5 lane K — A TASK'S TYPE BECOMES EDITABLE.
 *   ONE NEW PARAM, `task_update.type` (enum, optional), plus two reworded descriptions. No
 *   tool added, removed or renamed; no param removed or retyped; no outputSchema touched.
 *   Tool count 69 -> 69.
 *     + task_update.type — the same `taskTypeEnum` task_create declares (one definition in
 *       middleware/validation.ts, mirroring the DB CHECK constraint).
 *     ~ task_create.description — said "task_update cannot change type afterward". True when
 *       written; now false, and it is the sentence every client reads.
 *     ~ task_update.description — its list of changeable fields now names `type`.
 *   WHY THE WIRE HAD TO CHANGE: the capability IS the param. `type` was declared nowhere on
 *   the update schema (strict mode REJECTS an undeclared param, so it was unreachable) and
 *   had no SET-clause in the handler either, so a task filed as `general` was `general`
 *   forever. That was invisible while the Command backend wrote the column with raw SQL; the
 *   moment that backend delegates its update to this tool, the TaskDrawer's type control
 *   breaks. A server-side-only fix is not possible.
 *   MEASURED delta, `git diff --numstat` on this fixture: 18 lines added, 2 removed, in
 *   exactly three regions.
 *     fixture    — 235,115 -> 235,687 (+572, +0.24%)
 *     tools/list — compact after: 124,124
 *   Both printed by `npx tsx src/tests/regen-tool-surface-golden.ts`.
 *
 * 2026-08-27 · an earlier task — A RECORD CAN BE MOVED BETWEEN PROJECTS.
 *   ONE NEW TOOL, `project_move_record` (gateway `project`, action `move`). Nothing else on
 *   the wire changed: no existing tool added, removed, renamed or retyped, no param touched,
 *   no outputSchema of an existing tool touched.
 *     + `project_move_record` {recordType: enum(context|decision|task), recordId, toProject}
 *   WHY THE WIRE HAD TO CHANGE: there was no public path to move a record at all. Measured
 *   behaviourally on prod, `context update` with the destination in
 *   `projectId` returned `Context not found` — projectId scoped the LOOKUP, so every
 *   mutating op is structurally unable to cross a project boundary. A server-side-only fix
 *   is not possible: the capability IS a tool.
 *   MEASURED delta, `git diff --numstat` on this fixture: 47 lines added, ZERO removed, in
 *   exactly one region. Tool count 68 -> 69.
 *     fixture    — 233,159 -> 235,115 (+1,956, +0.84%) after both of today's entries
 *     tools/list — compact after: 123,780
 *   Both printed by `npx tsx src/tests/regen-tool-surface-golden.ts`.
 *
 * 2026-08-27 · an earlier task (folded in) — recall_thread's `maxNodes` STOPS TEACHING A SUM.
 *   ONE reworded param description, on `recall_thread.maxNodes`. No tool added or removed, no
 *   param added, renamed, retyped or removed, no outputSchema touched. Tool count 69 -> 69.
 *     ~ the schema advised "re-call with nodes.length + truncatedCount to get the whole
 *       branch". That arithmetic does not work: truncatedCount was a FLOOR, because the walk
 *       stopped enqueueing when the cap filled and never discovered anything reachable only
 *       through a dropped node. Measured on a 19-node two-level fixture at cap 4, the sum
 *       came to 13 and the re-call came back STILL TRUNCATED. It now points the caller at
 *       the response's own truncation notice, which either names a working value or says no
 *       value exists.
 *   WHY THE WIRE HAD TO CHANGE: the defect IS the wire. Every MCP client reads this schema,
 *   and it was instructing them to perform a computation that returns an incomplete answer
 *   while looking complete. A server-side fix leaves the instruction in front of every
 *   future caller.
 *   MEASURED delta of THIS change alone: ONE line replaced by one line (the fixture's
 *   cumulative numstat vs the base ref went 47/0 -> 48/1 across both of today's entries; the
 *   47/0 above is the op addition, so this contributes exactly +1/-1).
 *     fixture    — 234,848 -> 235,086 (+238, +0.10%); a later wording fix to
 *                  project_move_record.toProject took it to 235,115.
 *     tools/list — compact after: 123,780
 *
 * 2026-08-25 · an earlier task — `task_update` GAINS AN APPEND AFFORDANCE (`notes`).
 *   ONE new param and TWO reworded descriptions, all on `task_update`, all additive on the
 *   wire: no tool added or removed, no param renamed, retyped or removed, no outputSchema
 *   touched. Tool count 68 -> 68.
 *     + `notes` (string, maxLength 2000) — APPENDS a timestamped, actor-attributed entry to
 *       metadata.noteLog and leaves `description` untouched.
 *     ~ the tool description and the `description` param description now say, on the wire,
 *       that `description` is a FULL REPLACE and where the replaced text is preserved.
 *   WHY THE WIRE HAD TO CHANGE: the defect IS the wire. Measured 2026-08-21, two independent
 *   actors reached for `notes`, were rejected by strict mode, read the schema, found
 *   `description`, and used it — destroying a build spec. A server-side-only fix would leave
 *   the schema still pointing every future caller at the destructive field.
 *   MEASURED delta, verified by `git diff --numstat` on this fixture: 7 lines added, 2
 *   removed, in exactly two regions (both inside task_update).
 *     fixture    — 232,251 -> 233,159 (+908, +0.39%)
 *     tools/list — compact after: 122,359
 *   Both printed by `npx tsx src/tests/regen-tool-surface-golden.ts`.
 *
 * 2026-08-23 · P5.5 (migration 093) — "WAITING ON A HUMAN" BECOMES A FIELD.
 *   TWO wire changes, both purely ADDITIVE, both on task write params only:
 *   task_create and task_update each gained `blockedOn` (nullable enum human|agent|external)
 *   and `dueAt` (nullable ISO-8601 date-time). No tool added or removed, no existing param
 *   renamed, retyped or removed, no outputSchema touched — the two new response fields ride
 *   the passthrough `taskRecord` shape (config/outputSchemas.ts:161).
 *   WHY THEY EXIST ON THE WIRE AT ALL: a column no tool can write is not a feature. The
 *   whole point of P5.5 is that the briefing's most valuable section stops requiring a
 *   four-tag vocabulary a customer has to invent; if the field were server-side only, the
 *   section would select on a column nobody could populate.
 *   MEASURED delta, verified by `git diff --numstat` on this fixture: 56 lines added, ZERO
 *   removed, in exactly TWO regions (one per tool). Tool count 68 → 68.
 *     fixture    — `wc -c src/tests/fixtures/toolSurface.golden.json`: 227,869 -> 230,759
 *                  (+2,890, +1.27%)
 *     tools/list — compact `Buffer.byteLength(JSON.stringify(AIDIS_TOOL_DEFINITIONS))`
 *                  after: 120,154
 *   Both numbers are printed by `npx tsx src/tests/regen-tool-surface-golden.ts`, which is
 *   the serializer this test asserts with rather than a retyped copy of it.
 *
 * 2026-08-22 · an earlier task — THE RECENCY DOOR on recall_thread's `current` altitude.
 *   ONE wire change, purely ADDITIVE: recall_thread's outputSchema gained
 *   `currentState.recentContexts`, the same three-field section shape the other four sections
 *   already advertise (items / total / omittedByCap), plus its name in that object's
 *   `required` list. No existing tool's bytes moved and no field was removed or renamed.
 *   MEASURED delta, verified by `git diff --stat` on this fixture: 25 lines added, ZERO
 *   removed.
 *     fixture    — `wc -c src/tests/fixtures/toolSurface.golden.json`: 226,565 -> 227,323
 *                  (+758, +0.33%)
 *     tools/list — compact `Buffer.byteLength(JSON.stringify(AIDIS_TOOL_DEFINITIONS))`:
 *                  117,303 -> 117,578 (+275, +0.23%)
 *   WHY the section is advertised at all rather than left to `.passthrough()`: the four
 *   sibling sections are declared, and a fifth that is not would teach a reader the payload
 *   has four. The cost of saying so is a quarter of a percent.
 *
 * 2026-08-22 · an earlier task — ONE VOLUME VOCABULARY + TRUST ON THE WIRE.
 *   TWO wire changes, both intended, both reviewed:
 *   (a) ADDED — `altitude: headline|summary|full` on context_search, context_get_recent and
 *       smart_search (recall_thread already had it). Three new advertised params, each with a
 *       description. `response_format` is STILL ACCEPTED on the two tools that shipped it —
 *       it stays in `properties` as a deprecated alias — but its DESCRIPTION was removed, so
 *       the surface teaches one name for one idea instead of two.
 *   (b) REMOVED — seven fields from the advertised `trustObject` (outcome, freshness,
 *       superseded, softSuperseded, abstain, supersession, reason, promotionRequirement).
 *       Trust on the wire is {band, score}. Because trustObject is embedded in most read
 *       tools' outputSchema, this is where nearly all of the byte delta comes from.
 *   MEASURED delta, verified by `git diff --stat` on this fixture: 42 lines added, 1,247
 *   removed.
 *     fixture      — `wc -c src/tests/fixtures/toolSurface.golden.json`: 266,619 → 226,565
 *                    (-40,054, -15.0%)
 *     tools/list   — compact `Buffer.byteLength(JSON.stringify(AIDIS_TOOL_DEFINITIONS))`,
 *                    68 tools: 127,434 → 117,303 (-10,131, -7.9%)
 *     advertise-ON token meter (o200k_base, src/tests/outputSchemaWireTrim.contract.test.ts):
 *                    29,985 → 27,404 tokens (-2,581, -8.6%)
 *   The removal is deliberate and is the point of the decision: measured on prod at
 *   recall_thread `headline` over 43 nodes, the old trust blob was 14,391 chars against
 *   4,156 chars of the titles it decorated.
 * 2026-07-25 · an earlier task (Amp-orb eval finding W3) — the SESSION IDENTITY read model
 *   added TWO new tools, `session_list` and `session_get`, so an orchestrator can VERIFY
 *   attribution (which session produced a record, who held it, and why the session exists)
 *   instead of correlating screenshots and timestamps.
 *   MEASURED delta, verified by `git diff` on this fixture: 85 lines ADDED, ZERO removed —
 *   the change is purely additive and NO existing tool's bytes moved (session_status's own
 *   definition is byte-identical: its new `identity`/`caller` payload rides the RESPONSE, not
 *   the advertised schema, because its outputSchema is the shared open `statusShape`).
 *   Fixture 224439 → 227671 bytes (+3232, +1.44%). Per-tool serialized cost: session_list
 *   1543 bytes, session_get 860 bytes; the compact `tools/list` payload 109826 → 113058 bytes.
 *   The two new outputSchemas are deliberately the shared OPEN statusShape rather than a
 *   spelled-out identity record: the record's shape is owned by ONE builder
 *   (buildSessionIdentity) and re-declaring its 18 fields here would be a second copy that can
 *   drift, and would cost several KB more on every tools/list.
 *
 * 2026-07-25 · an earlier task — `task_claim`'s `actor` PARAM DESCRIPTION was
 *   CORRECTED because it had become FALSE. It said "defaults to your derived actor". After the
 *   actor-precedence fix (closing an earlier note) the derived actor takes PRECEDENCE over the
 *   argument — it is not a default — and since prod runs MANDREL_SESSION_REQUIRE_ACTOR=true a
 *   derived actor is always present there, so in the shipped default mode the argument is INERT
 *   on prod. An agent reading the old text via discover({action:'explain'}) would have been told
 *   the opposite of what the server does. This is a DESCRIPTION-ONLY change: no schema, no enum,
 *   no required/optional flag, no new or removed tool.
 *   MEASURED delta, verified by `git diff` on this fixture: ONE line changed, 1 added / 1 removed,
 *   and exactly ONE tool's bytes moved (task_claim 2546 → 2981, +435). Tool count 60 → 60, all
 *   other tools byte-identical. Fixture 227671 → 228106 bytes (+435, +0.19%); the compact
 *   `tools/list` payload 105775 → 106215 bytes (+440, +0.42%).
 *
 * 2026-07-25 · an earlier task — recall_thread gained the `current`
 *   PROJECTION altitude (the deterministic current-state read model). Three deltas, all on
 *   recall_thread and NOTHING else:
 *     1. inputSchema `altitude` enum: ["headline","summary","full"] → + "current",
 *     2. the tool description + the `altitude` param description name the new altitude,
 *     3. outputSchema gained the optional `currentState` payload.
 *   MEASURED wire cost: recall_thread 3967 → 7323 bytes (+3356); the whole tools/list
 *   surface 108752 → 112108 bytes (+3.1%). The first cut of the outputSchema spelled out
 *   the full node shape and cost 13898 bytes (+9.1% of the surface) because the nested trust
 *   object serialized five times; the section item shapes were deliberately left open to buy
 *   that back (see the note in config/outputSchemas.ts). No other tool's bytes moved.
 *
 * 2026-07-28 · an earlier task — `thread_set` gained the `replace` param (true = overwrite the
 *   whole anchor, an omitted side cleared; default = the original merge), and its description
 *   now states the truth the response was changed to tell: thread_set returns the RESULTING
 *   anchor plus the `previousAnchor` it merged onto, so a silent merge onto pre-existing
 *   (possibly leaked) state is visible. Layer 3 of the strict-anchor-keying work.
 *   MEASURED delta, verified by `diff` on this fixture: exactly TWO regions moved, both on
 *   thread_set — the description line (1 changed) and the new `replace` inputSchema property
 *   (4 lines added). Tool count 60 → 60; no other tool's bytes moved. Fixture
 *   228288 → 228758 bytes (+470, +0.21%). previousAnchor/replaced ride the RESPONSE through
 *   the passthrough outputSchema (threadAnchorShape), so the advertised outputSchema is
 *   untouched.
 *
 * 2026-07-30 · an earlier task — THE PROJECT-REFERENCE NAME CONTRACT was made uniform. 31 params
 *   documented "Project ID or name" while 15 other project-reference params understated the
 *   same capability (`task_bulk_update.projectId` read "Project ID to validate ownership
 *   against"; `decision_update.projectId` and `task_update.projectId` documented NOTHING). All
 *   of them accept a name — the routeExecutor choke point canonicalises it —
 *   so every project-reference description now carries the canonical phrase
 *   PROJECT_REF_CONTRACT_PHRASE (config/projectParamContract.ts), and
 *   src/tests/projectNameContract.contract.test.ts REDs on any that does not. DESCRIPTION-ONLY:
 *   no tool added or removed, no schema/enum/required change, no outputSchema touched.
 *   MEASURED delta, verified by `git diff --numstat` on this fixture: 17 lines added / 15
 *   removed = 13 descriptions REWRITTEN in place + 2 descriptions NEWLY EMITTED for params that
 *   already existed in the inputSchema but carried none (decision_update.projectId,
 *   task_update.projectId — the two `"type": "string"` → `"type": "string",` lines are that
 *   insertion's comma, and are the only non-description lines in the diff). Tool count 60 → 60.
 *   Fixture 229682 → 229995 bytes (+313, +0.136%); the compact `tools/list` definitions payload
 *   107247 → 107532 bytes (+285, +0.266%).
 *   Each of those four absolutes was produced by running the command, on both refs:
 *     base    `git show 9930d1a:mcp-server/src/tests/fixtures/toolSurface.golden.json | wc -c`
 *     head    `wc -c mcp-server/src/tests/fixtures/toolSurface.golden.json`
 *     compact `DATABASE_NAME=measure_only npx tsx -e "import {AIDIS_TOOL_DEFINITIONS} from
 *              './src/config/toolDefinitions.js'; console.log(Buffer.byteLength(
 *              JSON.stringify(AIDIS_TOOL_DEFINITIONS),'utf8'))"` in mcp-server, per ref
 *              (the base ref needs its own detached worktree; the import pulls in
 *              config/database.ts, hence the dummy DATABASE_NAME).
 *   The first version of this entry stated all four absolutes 188 bytes low with every DELTA
 *   correct — the signature of numbers measured on an earlier state of the tree and carried
 *   forward without re-running the command. Reviewer caught it and REJECTED the branch for it.
 *   Recorded because it is the exact failure this log exists to prevent: an audit trail whose
 *   arithmetic does not reproduce is the golden guard switched off, and a delta that still adds
 *   up is precisely what makes a stale absolute survive review.
 *
 * ⚠️ 2026-07-29 · THE CHAIN ABOVE DOES NOT RECONCILE, and it predates this entry. Measured:
 *   224439 → 227671 → 228106, then the next two entries BOTH claim to start from 228288
 *   (thread_set at "228288 → 228758" and the entry at "228288 → 229033"), and neither
 *   continues from 228106. So the running total has been wrong for several entries and reads as
 *   continuous when it is not. NOT repaired here: reconstructing the true historical values means
 *   building a worktree per commit, and guessing them would be strictly worse than saying this
 *   out loud. Do not treat any absolute above this line as measured.
 *   THE REAL FIX IS TO STOP HAND-WRITING THESE: the regeneration path should EMIT the four
 *   numbers, so the log cannot drift from the fixture it describes. A hand-maintained number
 *   beside a derived artifact is the same two-representations-of-one-truth disease as the rest
 *   of this month's defects — the prose version of a hand-kept population list.
 *
 * 2026-07-30 · an earlier task — `decision_stats` gained the `includeArchived` PARAM, and its
 *   tool description now states the default population. WHY it is a wire change and not an
 *   internal one: decision_stats counted ARCHIVED rows while decision_search excludes them, so
 *   on prod the two public tools reported 556 vs 127 for one corpus. Stats now excludes
 *   archived by DEFAULT and takes the SAME param name/meaning decision_search already has —
 *   deliberately not a second spelling for one concept.
 *   MEASURED HERE, each number re-run against THIS tree (not carried forward — see the ⚠️
 *   above), base = main @ceff2d6 measured in the shared checkout with the SAME commands.
 *   EACH NUMBER NAMES ITS INSTRUMENT, because two reasonable instruments disagree (an
 *   Reviewer measured the per-tool figures 2 bytes lower than the line below and was right
 *   to flag it: a tool object measured standalone carries its own enclosing braces, one
 *   measured in situ inside the pretty-printed fixture does not. Neither is wrong; an
 *   unnamed instrument is):
 *     fixture      — `wc -c mcp-server/src/tests/fixtures/toolSurface.golden.json`
 *                    232337 → 232693  (+356, +0.15%)
 *     tools/list   — `Buffer.byteLength(JSON.stringify(AIDIS_TOOL_DEFINITIONS), 'utf8')`,
 *                    i.e. the COMPACT wire payload, NOT the pretty fixture above
 *                    108912 → 109217  (+305, +0.28%)
 *     decision_stats — `Buffer.byteLength(JSON.stringify(def, null, 2), 'utf8')` where
 *                    `def = AIDIS_TOOL_DEFINITIONS.find(t => t.name === 'decision_stats')`
 *                    563 → 903        (+340)
 *     tool count   — `AIDIS_TOOL_DEFINITIONS.length`: 60 → 60 (none added or removed)
 *   `git diff --numstat` on the fixture: 5 added / 1 removed, and decision_stats is the ONLY
 *   tool whose bytes moved (the +340 accounts for the whole +356 modulo indentation).
 *
 * 2026-07-30 (second regen, same an earlier task) — SCOPE EXTENDED to close the whole class:
 *   `context_stats` and `project_insights` carried the IDENTICAL archived-counting defect
 *   (context_stats: 4 aggregates; project_insights: all 3 entity breakdowns), and neither had
 *   an `includeArchived` param at all. Both gained the param and a description stating the
 *   default population. Shipping only decision_stats would have left two of three instances
 *   of one defect live.
 *   MEASURED HERE with the SAME NAMED INSTRUMENTS as the entry above; the BASE for this
 *   entry is the FIRST regen (232693 / 109217), not main, since both regens are on one branch:
 *     fixture      — wc -c                     232693 → 233458  (+765, +0.33%)
 *     tools/list   — compact JSON.stringify    109217 → 109880  (+663, +0.61%)
 *     context_stats    — JSON.stringify(def, null, 2)  552 → 875  (+323)  [base on main @ceff2d6]
 *     project_insights — JSON.stringify(def, null, 2)  563 → 973  (+410)  [base on main @ceff2d6]
 *     decision_stats   — unchanged by this regen (903)
 *     tool count   — AIDIS_TOOL_DEFINITIONS.length: 60 → 60
 *   `git diff --numstat` on the fixture: 10 added / 2 removed — exactly two tools' bytes
 *   moved, and +323 +410 = +733 accounts for the +765 modulo indentation.
 *   Cumulative for the whole task vs main @ceff2d6: fixture 232337 → 233458 (+1121, +0.48%);
 *   compact tools/list 108912 → 109880 (+968, +0.89%); three tools changed, none added or
 *   removed.
 *
 * 2026-08-11 · threading tranche 1 — `recall_thread` gained the `maxNodes` PARAM. WHY it is a
 *   wire change and not an internal one: the node cap truncated 5/5 real branches, and the
 *   only remedy the tool offered was the env var MANDREL_THREAD_MAX_NODES — which a customer
 *   running Mandrel in a per-tenant container cannot set. The budget has to be reachable from
 *   the CALL or the truncation signal is honest and useless. One tool, one added param, one
 *   added param description; no enum, no required/optional flip, no tool added or removed.
 *   MEASURED HERE, each number re-run against THIS tree. The BASE was measured by reverting
 *   exactly the two surface-affecting edits (the zod `maxNodes` line and its humanDescription)
 *   in place and re-serializing — which also PROVES they are the only surface delta, because
 *   with them reverted the fixture serialized byte-identical to the on-disk base (233458):
 *     fixture       — `wc -c mcp-server/src/tests/fixtures/toolSurface.golden.json`
 *                     233458 → 233823  (+365, +0.16%)
 *     tools/list    — `Buffer.byteLength(JSON.stringify(AIDIS_TOOL_DEFINITIONS), 'utf8')`,
 *                     the COMPACT wire payload, NOT the pretty fixture above
 *                     109880 → 110166  (+286, +0.26%)
 *     recall_thread — `Buffer.byteLength(JSON.stringify(def, null, 2), 'utf8')` where
 *                     `def = AIDIS_TOOL_DEFINITIONS.find(t => t.name === 'recall_thread')`
 *                     14749 → 15090    (+341)
 *     tool count    — `AIDIS_TOOL_DEFINITIONS.length`: 60 → 60
 *   `git diff --numstat` on the fixture: 6 added / 0 removed — purely additive, and
 *   recall_thread is the ONLY tool whose bytes moved (+341 accounts for the +365 modulo
 *   indentation).
 *
 * 2026-07-30 (Reviewer remediation) — NO REGEN NEEDED, recorded because the
 *   absence of a delta is itself the claim. `OpRegistryEntry.reportsCount` was added and set
 *   on 13 ops. It is registry METADATA consumed only by
 *   src/tests/statsSearchCountReconcile.contract.test.ts; buildInputSchema never reads it, so
 *   the advertised surface is BYTE-IDENTICAL. Re-measured after the change: fixture 233458
 *   (unchanged), compact tools/list 109880 (unchanged), tool count 60 (unchanged) — and this
 *   file's byte-identical assertion passes without the fixture being touched, which is the
 *   real proof.
 */

/*
 * 2026-07-28 · an earlier task (claim fence field-shaped hole) — the fence semantics CHANGED
 *   (while a claim is LIVE, EVERY task_update field is fenced; a supplied claimId is validated
 *   on every update), so the advertised text had become FALSE the moment the fix merged: an
 *   agent reading task_update via discover would have been told content fields never need the
 *   token. DESCRIPTION-ONLY deltas, no schema/enum/required change, no tool added or removed:
 *     1. task_update description states the widened fence + the typed rejection vocabulary,
 *        and its claimId/force params gain descriptions (they were bare types on the wire);
 *     2. task_claim description: "every ownership write (status/assignee)" → "EVERY
 *        task_update while the claim is live (all fields...)".
 *   MEASURED delta, verified by diff of the fixture before/after: 4 changed regions, exactly
 *   TWO tools' bytes moved (task_update 2353 → 3036, +683; task_claim 3128 → 3169, +41), all
 *   58 other tools byte-identical, tool count 60 → 60. Fixture 228288 → 229033 bytes
 *   (+745, +0.33%).
 */

/*
 * 2026-08-13 · PHASE 1 positional membership — THREE new
 *   tools (branch_open / branch_current / branch_close: the session's current-branch control
 *   surface) and the three anchor tools re-described as DEPRECATED WARN-and-delegate aliases
 *   (their outputSchema is now the shared branch-position shape; thread_set's params are
 *   unchanged in name/type, only descriptions moved). Tool count 60 → 63.
 *   MEASURED on this tree (commands in reports; scratchpad/measure.ts re-runs them):
 *     fixture     — `wc -c` 233823 → 246886 (+13063, +5.59%)
 *     tools/list  — compact `Buffer.byteLength(JSON.stringify(AIDIS_TOOL_DEFINITIONS))`
 *                   110166 → 115413 (+5247, +4.76%)
 *     new tools   — pretty-serialized: branch_open 3337 · branch_current 2607 · branch_close 2613
 *     re-described— thread_set 3293 · thread_current 2382 · thread_clear 2374
 *     tool count  — `AIDIS_TOOL_DEFINITIONS.length`: 60 → 63
 *   `git diff --numstat` on the fixture: 526 added / 39 removed — the three additions plus
 *   exactly the six graph-gateway tools whose descriptions/schemas legitimately moved.
 */

/*
 * 2026-08-13 · an earlier task — `task_create` gained the `parentTaskId` PARAM (the ONLY
 *   source of a `subtask_of` edge; the positional subtask_of mint was deleted — position
 *   is a session-scoped claim and cannot support a record-intrinsic structural one). One
 *   tool, one added optional param + its description; no enum, no required/optional flip,
 *   no tool added or removed. (The same task also rewrote the graph GATEWAY description —
 *   "control auto-threading anchors" → branch positions — which rides the gateway surface,
 *   asserted in gatewaySurface.contract.test.ts, NOT this flat fixture; it moved zero
 *   bytes here, which the single-tool delta below proves.)
 *   MEASURED on this tree by the regen script (scratchpad/regen-golden.ts prints each):
 *     fixture     — `wc -c` 246886 → 247244 (+358, +0.15%)
 *     tools/list  — compact `Buffer.byteLength(JSON.stringify(AIDIS_TOOL_DEFINITIONS))`
 *                   115413 → 115720 (+307, +0.27%)
 *     task_create — `Buffer.byteLength(JSON.stringify(def, null, 2))` 6609 → 6951 (+342)
 *     tool count  — `AIDIS_TOOL_DEFINITIONS.length`: 63 → 63
 *   task_create is the ONLY tool whose bytes moved (+342 accounts for the +358 modulo
 *   indentation). `git diff --numstat` on the fixture: 4 added / 0 removed — purely additive.
 */

/*
 * 2026-08-14 · WS2 living summary — ONE new tool, `project_briefing`
 *   (gateway project.briefing): the deterministic current-state briefing renderer
 *   (handoff full-text + open tasks + live decisions + conventions + dead-ends;
 *   whole-record size-cap drops). outputSchema is deliberately the shared open
 *   statusShape (session_list precedent — the payload shape is owned by ONE builder,
 *   services/projectBriefing.ts, pinned by its contract test).
 *   MEASURED on this tree (each command re-run, not carried forward):
 *     fixture          — `wc -c` 247244 → 248378 (+1134, +0.46%); base re-measured via
 *                        `git show 0328fd2:mcp-server/src/tests/fixtures/toolSurface.golden.json | wc -c`
 *     tools/list       — compact `Buffer.byteLength(JSON.stringify(AIDIS_TOOL_DEFINITIONS))`
 *                        115720 → 116538 (+818, +0.71%)
 *     project_briefing — `Buffer.byteLength(JSON.stringify(def, null, 2))` = 990 (new)
 *     tool count       — `AIDIS_TOOL_DEFINITIONS.length`: 63 → 64
 *   `git diff --numstat` on the fixture: 30 added / 0 removed — purely additive; no
 *   existing tool's bytes moved.
 */
/*
 * 2026-08-15 · SK8 — EDGE PROVENANCE became a first-class field on the edge
 *   READ. SK4 moved provenance into the NOT NULL `links.mint_via` column and the read path
 *   was never updated, so `get_links` reported it as absent on every edge (the SK1 canary
 *   caught it against prod after the v0.31.0 deploy). The shared `edgeRecord` outputSchema
 *   gained TWO optional nullable string fields — `mintVia` and `provenanceClass` — so the
 *   contract advertises what the response now carries. No tool added or removed, no
 *   inputSchema touched, no enum, no required/optional flip.
 *   Because `edgeRecord` is SHARED, three tools' bytes move, not one: get_links, link and
 *   unlink all advertise it. That is the whole population, enumerated by comparing every
 *   tool object against the base fixture rather than asserted from the tools I edited.
 *   MEASURED on this tree, each number EMITTED by a throwaway script run against the base
 *   fixture and this tree (not hand-copied), the commands named per line:
 *     fixture     — `wc -c` 248378 → 249272 (+894, +0.36%); base re-measured via
 *                   `git show HEAD:mcp-server/src/tests/fixtures/toolSurface.golden.json | wc -c`
 *     tools/list  — compact `Buffer.byteLength(JSON.stringify(AIDIS_TOOL_DEFINITIONS))`
 *                   116538 → 116784 (+246, +0.21%)
 *     per tool    — `Buffer.byteLength(JSON.stringify(def, null, 2))`:
 *                   get_links 3009 → 3275 (+266), link 3238 → 3480 (+242),
 *                   unlink 2303 → 2545 (+242). Nothing else moved.
 *     tool count  — `AIDIS_TOOL_DEFINITIONS.length`: 64 → 64
 *   `git diff --numstat` on the fixture: 36 added / 0 removed — purely additive.
 *
 * 2026-08-15 · an earlier task (SK2) — ONE NEW TOOL, `branch_history`: read a branch's members
 *   back after it is closed. It is additive in the strongest sense — the other three branch
 *   tools are untouched, because history is read from the membership edges rather than from
 *   the `branch_positions` row branch_close deletes.
 *   MEASURED on this tree, commands named per line:
 *     fixture     — `wc -c` 249272 → 253626 (+4354, +1.75%); base re-measured via
 *                   `git show HEAD:mcp-server/src/tests/fixtures/toolSurface.golden.json | wc -c`
 *     tools/list  — compact `Buffer.byteLength(JSON.stringify(AIDIS_TOOL_DEFINITIONS))`
 *                   116784 → 119201 (+2417, +2.07%)
 *     per tool    — `Buffer.byteLength(JSON.stringify(def, null, 2))`: branch_history 3796,
 *                   the whole of the delta. No existing tool's bytes moved.
 *     tool count  — `AIDIS_TOOL_DEFINITIONS.length`: 64 → 65
 *   `git diff --numstat` on the fixture: 134 added / 0 removed — purely additive.
 *
 * 2026-08-15 · an earlier task (SK2, rounds 2-3) — NO tool added or removed; `branch_history`'s
 *   DESCRIPTION and OUTPUT SCHEMA changed. Membership became a stored fact (the minting
 *   position's root spine, in branch_memberships — migration 086) instead of a transitive
 *   walk, and round 3 added the third band `tagOnlyNoPosition`, so the schema drops
 *   `depthLimitReached` and adds `approximateMembers` / `possiblyIncomplete` /
 *   `tagOnlyNoPosition` / `exact` plus per-member `attachedToId` / `spineSource`, and widens
 *   per-member `edgeType` / `mintVia` to nullable (the graph edge that renders a membership
 *   can be deduped or unlinked; membership survives it). A REMOVAL, which the entries above
 *   have none of: `depthLimitReached` advertised a signal nothing could emit any more.
 *   MEASURED on this tree, commands named per line:
 *     fixture     — `wc -c` 253626 → 254865 (+1239, +0.49%); base re-measured via
 *                   `git show 52c0918^:mcp-server/src/tests/fixtures/toolSurface.golden.json | wc -c`
 *     tool count  — `AIDIS_TOOL_DEFINITIONS.length`: 65 → 65 (unchanged)
 *   `git diff --numstat 52c0918^` on the fixture: 25 added / 4 removed.
 *
 * 2026-08-16 · FIX A (SK5 follow-on) — NO tool added or removed; ONE new
 *   OPTIONAL param, `project_briefing.spine`. SK5 scoped the briefing to the caller's open
 *   branch POSITION, which is keyed on connection id — unreachable for the SessionStart boot
 *   hook, a separate shell client from the MCP bridge that holds the session's position. The
 *   argument is the surface that makes the already-built service parameter callable. It is
 *   gated by MANDREL_BRIEFING_BRANCH_SCOPE_ENABLED exactly as the position path is, so this
 *   advertises no behaviour a flag-off tenant can obtain. `uuidOrShortId()` renders as plain
 *   {"type":"string"} (a .refine(), not .uuid()), so the schema delta is the description.
 *   MEASURED on this tree, commands named per line:
 *     fixture     — `wc -c src/tests/fixtures/toolSurface.golden.json`: 254865 → 255250
 *                   (+385, +0.15%); base re-measured via
 *                   `git show HEAD:mcp-server/src/tests/fixtures/toolSurface.golden.json | wc -c`
 *     tool count  — `AIDIS_TOOL_DEFINITIONS.length`, read off both fixtures: 65 → 65
 *     compact     — `JSON.stringify(definitions).length`: 119871 → 120205 (+334, +0.28%)
 *     one tool    — project_briefing 815 → 1149 bytes; TOOLS WHOSE BYTES MOVED = 1, computed
 *                   by diffing every definition object between the two fixtures
 *   `git diff --numstat` on the fixture: 4 added / 0 removed — purely additive.
 *
 * 2026-08-19 · smart_search merge (public-contract completion) — NO tool added or removed and
 *   NO schema change: `smart_search.includeTypes`'s DESCRIPTION stopped advertising the
 *   `component` source. That source was removed from the handler because it could not produce
 *   a comparable score (no embedding column; admitted by an ILIKE gate, then ranked by
 *   complexity_score). The description is no longer typed at all — opRegistry renders it from
 *   SMART_SEARCH_DEFAULT_SOURCES (config/searchMergeConfig.ts) via smartSearchSourcesJson()/
 *   smartSearchSourcesPlus(), so the advertised source list is now DERIVED from the searched
 *   one and cannot drift from it again.
 *   MEASURED on this tree, commands named per line:
 *     fixture     — `wc -c src/tests/fixtures/toolSurface.golden.json`: 255250 → 255226
 *                   (−24, −0.009%); base re-measured via
 *                   `git show HEAD:mcp-server/src/tests/fixtures/toolSurface.golden.json | wc -c`
 *     tool count  — `AIDIS_TOOL_DEFINITIONS.length`, read off both fixtures: 65 → 65
 *     compact     — `JSON.stringify(definitions).length`: 120205 → 120181 (−24, −0.02%)
 *     one tool    — smart_search 2364 → 2340 bytes; TOOLS WHOSE BYTES MOVED = 1, computed by
 *                   diffing every definition object between the two fixtures
 *   `git diff --numstat` on the fixture: 1 added / 1 removed — a single description line.
 *
 * 2026-08-20 · an earlier task (smart_search task source, tranche B) — `smart_search.includeTypes`
 *   became a CONSTRAINED ENUM. It was `z.array(z.string())`, which is not a lax validator but a
 *   silent one: an unknown source key passed validation, matched no adapter, and returned a
 *   CLEAN EMPTY SUCCESS — indistinguishable from "nothing matched". It now derives its enum from
 *   SMART_SEARCH_SOURCE_KEYS (config/searchMergeConfig.ts), so the advertised values, the
 *   accepted values and the adapter list are one source.
 *   THIS IS A REAL SCHEMA CHANGE, NOT A DESCRIPTION EDIT, and it is deliberately NARROWING: a
 *   call naming a source that does not exist now FAILS instead of succeeding emptily. No tool
 *   added or removed; no required/optional flag moved; `includeTypes` stays optional and an
 *   EMPTY array stays valid. Note the enum is the source VOCABULARY (context/decision/task),
 *   which is deliberately WIDER than the default set — `task` is requestable here before it is
 *   searched by default, which is what makes the default-set flip separately revertable.
 *   MEASURED on this tree, commands named per line:
 *     fixture     — `wc -c src/tests/fixtures/toolSurface.golden.json`: 255226 → 255345
 *                   (+119, +0.047%)
 *     tool count  — `AIDIS_TOOL_DEFINITIONS.length`, read off both fixtures: 65 → 65
 *     compact     — `JSON.stringify(definitions).length`: 120181 → 120218 (+37, +0.03%)
 *     one tool    — smart_search 2340 → 2377 bytes; TOOLS WHOSE BYTES MOVED = 1, computed by
 *                   diffing every definition object between the two fixtures
 *   `git diff --numstat` on the fixture: 6 added / 1 removed — the `enum` block, nothing else.
 *
 * 2026-08-20 · an earlier task (the FLIP, its own commit) — `task` joined
 *   SMART_SEARCH_DEFAULT_SOURCES. NO schema change at all: the only wire delta is the
 *   `includeTypes` DESCRIPTION, and it changed WITHOUT ANYONE EDITING IT — opRegistry renders
 *   that sentence from SMART_SEARCH_DEFAULT_SOURCES through smartSearchSourcesJson() /
 *   smartSearchSourcesPlus(), so flipping the default set moved the advertised text on its own.
 *   That is the derivation working, and this entry is the evidence it does: the advertised
 *   source list CANNOT drift from the searched one, because there is nothing to forget to
 *   update. (Same for the gateway lazy one-liner via smartSearchSourcesProse(), verified to
 *   render "contexts, decisions and tasks" — it lives in gatewaySurface, not this fixture.)
 *   The enum is UNCHANGED by this commit: it renders the VOCABULARY, which already held
 *   `task`, which is exactly why the flip is a one-line, separately-revertable kill switch.
 *   MEASURED on this tree, commands named per line:
 *     fixture     — `wc -c src/tests/fixtures/toolSurface.golden.json`: 255345 → 255359
 *                   (+14, +0.005%)
 *     tool count  — `AIDIS_TOOL_DEFINITIONS.length`, read off both fixtures: 65 → 65
 *     compact     — `JSON.stringify(definitions).length`: 120218 → 120232 (+14, +0.01%)
 *     one tool    — smart_search 2377 → 2391 bytes; TOOLS WHOSE BYTES MOVED = 1, computed by
 *                   diffing every definition object between the two fixtures
 *   `git diff --numstat` on the fixture: 1 added / 1 removed — a single description line.
 *
 * 2026-08-20 · briefing drop order (P3 pre-fix) — NO tool added or removed and
 *   NO schema change: `project_briefing`'s DESCRIPTION stopped claiming an ordering the
 *   comparator has not performed since SK5. It said the cap "drops whole oldest-least-trusted
 *   records"; the drop queue is now a protection LADDER (branch member > always-surface >
 *   stale-priority > priority > none) and only breaks ties by trust, so the old sentence named
 *   the wrong primary key. New text: "drops whole records, least-protected first, never
 *   truncates." The "complete records only / never truncates" guarantee is UNCHANGED and still
 *   true — that half was never the false part.
 *   THIS ENTRY EXISTS BECAUSE THE FIXTURE WENT STALE AND THE GATE CAUGHT IT: the description
 *   lives in opRegistry.ts and the change that moved it lived in projectBriefing.ts, so every
 *   per-branch suite was green and only the MERGE was red. That is C4 — worktree-green is never
 *   sufficient — and it is exactly what this fixture is for. Found by Reviewer, not by the
 *   author, and not by any single-branch run.
 *   MEASURED on this tree, commands named per line:
 *     fixture     — `wc -c src/tests/fixtures/toolSurface.golden.json`: 255359 → 255361
 *                   (+2, +0.0008%)
 *     tool count  — `AIDIS_TOOL_DEFINITIONS.length`, read off both fixtures: 65 → 65
 *     compact     — `JSON.stringify(definitions).length`: 120232 → 120234 (+2, +0.002%)
 *     one tool    — project_briefing 1149 → 1151 bytes; TOOLS WHOSE BYTES MOVED = 1, computed
 *                   by diffing every definition object between the two fixtures
 *   `git diff --numstat` on the fixture: 1 added / 1 removed — a single description line.
 *   NOT a token-budget event: the gateway lazy envelope measured 1400/6114 both with and
 *   without this change, because project_briefing's description rides legacy/explain and is
 *   not in that envelope at all. The 1400/1400 ceiling is pre-existing and this did not
 *   consume it — verified before regenerating, because the opposite assumption is what made
 *   this look scarier than it was.
 *
 * 2026-08-21 · an earlier task — `branch_open`'s description said "While the
 *   branch is open, EVERY write ... stamps a DECLARED `informs` edge". P1 makes that FALSE:
 *   a context of type `handoff` is now TRUNK MATERIAL BY TYPE and is never a branch member,
 *   whatever branch is open. "EVERY" is softened to "a write" and the one exception is stated
 *   outright, because this string is the only place a caller learns the rule before hitting it.
 *   MEASURED on this tree, commands named per line:
 *     fixture     — `wc -c src/tests/fixtures/toolSurface.golden.json`: 255361 → 255515
 *                   (+154, +0.06%)
 *     tool count  — `AIDIS_TOOL_DEFINITIONS.length`, read off both fixtures: 65 → 65
 *     compact     — `JSON.stringify(definitions).length`: 120234 → 120388 (+154, +0.13%)
 *     one tool    — branch_open 1941 → 2095 bytes; TOOLS WHOSE BYTES MOVED = 1, computed by
 *                   diffing every definition object between the two fixtures
 *   `git diff --numstat` on the fixture: 1 added / 1 removed — a single description line.
 * 2026-08-21 · an earlier task (spec an earlier decision) — recall_thread got
 *   (a) the explicit ANSWER-SHAPE discriminator and (b) its omission accounting on the wire.
 *   Three deltas, ALL on recall_thread and NOTHING else:
 *     1. outputSchema gained `shape` (enum "thread" | "currentState") — the two answer shapes
 *        were always real (`current` returns currentState and NO `nodes` key) but the
 *        discriminator was implicit in `altitude`; our own harness read `nodes.length` on a
 *        `current` response and reported 0 for a walk that examined 49 records,
 *     2. outputSchema gained `omissions` {examined, droppedDangling, droppedByMinTrust,
 *        droppedEdges, clippedNodes?} + `maxNodesRequested` — what the walk DROPPED, which
 *        until now was reported for the cap only and silent for the trust floor,
 *     3. the tool description states that the shape switches, and that omissions are
 *        reported (the `discover({action:'explain'})` text an agent reads BEFORE calling).
 *   MEASURED delta, verified by a KEY-LEVEL structural diff of the old vs regenerated
 *   fixture (not a line count — a line count cannot tell you WHICH tool moved):
 *     ADDED keys 15 · REMOVED keys 0 · CHANGED values 1, and every one of the 16 resolves to
 *     definitions[52] = recall_thread. The single changed value is its `description`; the 15
 *     added are its outputSchema's `shape` (type + 2 enum members), `maxNodesRequested`, and
 *     `omissions` (type, additionalProperties, 5 properties, 4 required entries).
 *     Tools whose bytes moved: ["recall_thread"] — computed by re-serializing every tool and
 *     comparing to its old self, so "no other tool moved" is measured, not assumed.
 *     Tool count 65 → 65.
 *     fixture     — `wc -c src/tests/fixtures/toolSurface.golden.json`: 255361 → 256829
 *                   (+1468, +0.57%); `git diff --numstat`: 38 added / 1 removed
 *     compact     — `JSON.stringify(definitions).length`: 120809 → 121739 (+930, +0.77%)
 *                   i.e. the COMPACT wire payload, NOT the pretty fixture above
 *     recall_thread's own serialized size: 7137 → 8067 (+930) — the whole delta is this tool
 *
 * 2026-08-21 · an earlier task (P3) — MUTABLE BRANCH MEMBERSHIP added TWO
 *   tools, `branch_assign` and `branch_unassign`. Membership was write-once (positionalMint
 *   inserts ON CONFLICT DO NOTHING, so the first position won), and the system opens positions
 *   the author never asked for — so it could manufacture a membership nobody declared with no
 *   way to correct it. Both are WRITES and both append to the `branch_membership_moves` audit
 *   log (migration 090).
 *   MEASURED delta, by a KEY-LEVEL structural diff of the old vs regenerated fixture (each
 *   tool re-serialized and compared to its old self, so "which tools moved" is measured rather
 *   than assumed):
 *     ADDED tools 2 · REMOVED tools 0 · EXISTING tools whose bytes moved: ["branch_history"].
 *   THE THIRD ONE IS NOT AN ACCIDENT AND IS STATED BECAUSE IT WOULD BE EASY TO CLAIM
 *   OTHERWISE: `branch_history`'s outputSchema gained `tagOnlyNoPositionIds` +
 *   `tagOnlyIdsTruncated` — band 3 is now the DISCOVERY SURFACE for branch_assign, so it
 *   returns the ids and not only the count. Every other tool is byte-identical.
 *     fixture       — `wc -c src/tests/fixtures/toolSurface.golden.json`
 *                     256983 → 264047  (+7064, +2.75%); `git diff --numstat`: 186 added / 0 removed
 *     compact       — `Buffer.byteLength(JSON.stringify(AIDIS_TOOL_DEFINITIONS), 'utf8')`,
 *                     i.e. the COMPACT wire payload, NOT the pretty fixture above
 *                     121541 → 126181  (+4640, +3.82%)
 *     per-tool      — `Buffer.byteLength(JSON.stringify(def, null, 2), 'utf8')` (PRETTY, so
 *                     these do not sum to the compact delta above — the instrument differs,
 *                     and an unnamed instrument is what made an earlier entry in this log
 *                     unreproducible): branch_assign 3819 · branch_unassign 2269 ·
 *                     branch_history 4951 → 5139 (+188)
 *     tool count    — `AIDIS_TOOL_DEFINITIONS.length`, read off both fixtures: 65 → 67
 *   Each number was produced by running its command against THIS tree and against the base ref
 *   (main @f6da757, measured in the shared checkout with the identical command) — not carried
 *   forward from a delta that still adds up, which is the failure the ⚠️ above describes.
 *
 * 2026-08-21 · an earlier task (P4 L1) — THE AGENT CAPTURE CONTRACT added ONE
 *   tool, `mandrel_contract` (gateway `discover({action:'contract'})`). It is a pure READ that
 *   renders the `metadata.capture` vocabulary + the record-shape→op table, both GENERATED from
 *   config/captureVocab.ts and OP_REGISTRY. Why a tool and not a doc: P2 measured agents writing
 *   records at 11/11 runs but structuring them at 5/13, and the shape they were missing lived in
 *   prose in an agent card — the medium the same experiment showed to be weak. A doc rots; this
 *   cannot, because it IS the code.
 *   MEASURED delta, by a NAME-LEVEL structural diff of the old vs regenerated fixture (each tool
 *   re-serialized and compared to its old self, so "which tools moved" is measured rather than
 *   assumed — scratch script `measure-1e474867.ts`, the same shape as P3's):
 *     ADDED tools 1 ["mandrel_contract"] · REMOVED tools 0 · EXISTING tools whose bytes moved: []
 *     fixture    — `wc -c src/tests/fixtures/toolSurface.golden.json`
 *                  264047 → 266619  (+2572, +0.97%); `git diff --numstat`: 94 added / 1 removed
 *                  (the single removed line is the Navigation entry of `toolCategories`, which
 *                  gained a member)
 *     compact    — `Buffer.byteLength(JSON.stringify(AIDIS_TOOL_DEFINITIONS), 'utf8')`, the wire
 *                  payload rather than the pretty fixture: 126181 → 127434  (+1253, +0.99%)
 *     per-tool   — `Buffer.byteLength(JSON.stringify(def, null, 2), 'utf8')` (PRETTY, so it does
 *                  not sum to the compact delta — the instrument differs):
 *                  mandrel_contract 2176, of which its outputSchema is 1528 (70.2%, same
 *                  instrument applied to `def.outputSchema`): the contract's whole point is
 *                  that it rides the MACHINE channel, so the shape is spelled out.
 *     tool count — `AIDIS_TOOL_DEFINITIONS.length`, read off both fixtures: 67 → 68
 *     token meter— NOT a budget event: the lazy gateway envelope 1407 → 1409 o200k tokens
 *                  against a 1450 ceiling (the whole +2 is the action name "contract" in
 *                  `discover`'s action enum; the description and outputSchema do not ride the
 *                  lazy envelope). The budget was NOT raised.
 *
 * 2026-08-23 · an earlier task (handoff resume pointer) — NO tool added or removed and NO schema
 *   change: the wire delta is TWO DESCRIPTION STRINGS on `context_store` (`type` and `tags`),
 *   which now advertise the server-side guarantee that a `handoff` store always ends up tagged
 *   `ref:resume`. Documenting it is not optional politeness — an undocumented server-side
 *   mutation of a caller's tags is worse than the bug it fixes, so the guarantee and its
 *   visibility (`structuredContent.context.resumePointer.added`) are part of the advertised
 *   contract. Both sentences are RENDERED from config/handoffResumePointerConfig.ts
 *   (RESUME_POINTER_CONTEXT_TYPE / RESUME_POINTER_TAG), the same constants the write path
 *   applies, so the advertised guarantee cannot drift from the enforced one — the same
 *   derivation the smart_search entries above rely on.
 *   MEASURED on this tree, commands named per line:
 *     fixture     — `wc -c mcp-server/src/tests/fixtures/toolSurface.golden.json` vs
 *                   `git show HEAD:mcp-server/src/tests/fixtures/toolSurface.golden.json | wc -c`
 *                   227323 -> 227869 (+546, +0.24%)
 *     tool count  — `AIDIS_TOOL_DEFINITIONS.length`, read off both fixtures: 68 -> 68
 *     compact     — python3, both fixtures loaded:
 *                   `len(json.dumps(d["definitions"],separators=(",",":"),ensure_ascii=False).encode())`
 *                   117578 -> 118124 (+546, +0.46%)
 *     one tool    — same instrument, indent=2, on the single definition object:
 *                   context_store 7485 -> 8031 (+546); TOOLS WHOSE BYTES MOVED = 1, computed by
 *                   re-serializing every definition and comparing it to its old self
 *                   (ADDED tools 0 · REMOVED tools 0)
 *   `git diff --numstat` on the fixture: 2 added / 2 removed — the two description lines.
 *
 * 2026-08-24 · P5.4 (mode + spine as handoff carried FIELDS) — NO tool added or removed. This
 *   IS a schema change: `context_store` gains TWO OPTIONAL STRING PARAMS, `mode` and `spine`,
 *   which move our MODE/PATH convention off a regex over free prose and onto
 *   `contexts.metadata`. The wire delta is those two params plus their descriptions, on ONE
 *   tool. Both descriptions are RENDERED from config/handoffCarriedFieldsConfig.ts (the
 *   vocabulary and the metadata key the write path actually applies), the same derivation the
 *   resume-pointer entry above relies on, so the advertised contract cannot drift from the
 *   enforced one.
 *   WHY THIS IS THE SECOND-LARGEST SINGLE-TOOL DELTA IN THIS LOG, said out loud rather than
 *   buried: these two params ARE the teaching surface. A customer who never learns `mode`
 *   exists gets the empty section this feature was built to remove, so the description carries
 *   the vocabulary, the never-rejects contract, the storage path, and the deliberate absence
 *   of a default. That is a considered spend of 1.15% of the compact wire, not an oversight.
 *   MEASURED ON THIS TREE by ONE instrument that emits all four numbers and rewrites the
 *   fixture in the same run — so the log cannot drift from the artifact it describes. This is
 *   the fix the ⚠️ 2026-07-29 entry above asks for, and it now EXISTS rather than being
 *   recommended: `mcp-server/scripts/regen-tool-surface-golden.ts` (usage in its header; it
 *   MEASURES only unless you pass WRITE=1). Re-run it and these numbers reproduce:
 *     fixture      — `wc -c` on the pretty fixture:  227869 -> 229361  (+1492, +0.65%)
 *     tool count   — `AIDIS_TOOL_DEFINITIONS.length`, both fixtures:  68 -> 68
 *     tools/list   — `Buffer.byteLength(JSON.stringify(AIDIS_TOOL_DEFINITIONS),'utf8')`, i.e.
 *                    the COMPACT wire payload, NOT the pretty fixture:
 *                    118124 -> 119486  (+1362, +1.15%)
 *     one tool     — `Buffer.byteLength(JSON.stringify(def, null, 2))` STANDALONE (so it
 *                    carries its own enclosing braces; a figure measured in situ inside the
 *                    pretty fixture reads 2 bytes lower and is not wrong — see the 2026-07-30
 *                    entry): context_store 8031 -> 9483 (+1452)
 *                    TOOLS WHOSE BYTES MOVED = 1 · ADDED 0 · REMOVED 0, computed by
 *                    re-serializing every definition and comparing it to its old self.
 *
 *
 * 2026-08-28 · an earlier task (task_bulk_update re-type) — NO tool added or removed. This IS a
 *   schema change: `task_bulk_update` gains ONE OPTIONAL param, `type`, on the SAME
 *   taskTypeEnum `task_create`/`task_update` already declare. It closes the sibling gap Lane K
 *   measured and left on record in retrievalSchemaContract: `type` was undeclared in zod AND
 *   had no SET clause in bulkUpdateTasks, so a task's KIND was write-once in bulk. The part
 *   that is not visible on the wire and matters more: `type` also joined that handler's
 *   embedding-invalidation set in the same commit, because `type` feeds the task embed text
 *   (`buildTaskEmbeddingTextFromRow({ type, priority, tags, title, description })`) and a
 *   write without the invalidation leaves every re-typed row retrievable under its OLD type
 *   forever, with nothing NULL for services/reembedBackfill.ts to notice.
 *   MEASURED by `mcp-server/scripts/regen-tool-surface-golden.ts` (WRITE=1), which emits these
 *   four numbers in the SAME run that rewrote the fixture:
 *     fixture      — `wc -c` on the pretty fixture: 239645 -> 239987  (+342, +0.14%)
 *     tool count   — `AIDIS_TOOL_DEFINITIONS.length`: 69 -> 69
 *     tools/list   — `Buffer.byteLength(JSON.stringify(AIDIS_TOOL_DEFINITIONS),'utf8')` (COMPACT
 *                    wire): 125280 -> 125408  (+128, +0.10%)
 *     one tool     — `Buffer.byteLength(JSON.stringify(def, null, 2))` STANDALONE:
 *                    task_bulk_update 2057 -> 2339 (+282)
 *                    TOOLS WHOSE BYTES MOVED = 1 · ADDED 0 · REMOVED 0
 *
 * 2026-08-28 · an earlier task (three new threading lens axes) — NO tool
 *   added or removed and NO schema change: the ONLY wire delta is the `context_store.tags`
 *   DESCRIPTION, and, like the smart_search entry above, it changed WITHOUT ANYONE EDITING
 *   THE SENTENCE. `config/opRegistry.ts` now renders the lens-axis list from
 *   `lensAxesSummary()` (config/threadingVocabConfig.ts), so the advertised vocabulary is
 *   derived from the ENFORCED one. Adding `component:`/`actor:`/`batch:` and the `ops` owner
 *   value moved the advertised text on its own.
 *   WHY THAT MATTERS MORE HERE THAN USUALLY: this description is the only place a caller
 *   learns which tag values will THREAD, and the write boundary QUARANTINES the rest
 *   (`invalid-<tag>`, threads nothing). A stale copy of this sentence does not merely go
 *   out of date — it actively instructs people to write tags the server will quarantine,
 *   which is how 257 dead lens tags accumulated on prod in the first place.
 *   MEASURED by `mcp-server/scripts/regen-tool-surface-golden.ts` (WRITE=1), which emits
 *   these four numbers in the SAME run that rewrote the fixture:
 *     fixture      — `wc -c` on the pretty fixture: 240219 -> 240387  (+168, +0.07%)
 *                    (the base is re-measured, not carried forward:
 *                    `git show HEAD:mcp-server/src/tests/fixtures/toolSurface.golden.json | wc -c`
 *                    = 240219, which is NOT where the previous entry's arithmetic ends —
 *                    something landed between without a ledger line, so the running total
 *                    above should not be trusted as a chain.)
 *     tool count   — `AIDIS_TOOL_DEFINITIONS.length`: 69 -> 69
 *     tools/list   — `Buffer.byteLength(JSON.stringify(AIDIS_TOOL_DEFINITIONS),'utf8')` (COMPACT
 *                    wire): 125640 -> 125808  (+168, +0.13%)
 *     one tool     — `Buffer.byteLength(JSON.stringify(def, null, 2))` STANDALONE:
 *                    context_store 9645 -> 9813 (+168)
 *                    TOOLS WHOSE BYTES MOVED = 1 · ADDED 0 · REMOVED 0
 *
 * 2026-08-31 · an earlier task (the structured deadline becomes READABLE) — NO tool added,
 *   removed or renamed (count 69 -> 69). TWO params ADDED to ONE tool, `task_list`:
 *   `dueBefore` (string, format date-time) and `sort` (enum ["priority","dueAt"]). Both
 *   OPTIONAL, and `required` stays `[]` — no existing call shape becomes invalid, and a
 *   caller that sends neither gets byte-identical behaviour (the default ordering is the
 *   historical one, unchanged). Plus `task_list`'s own `description`. No outputSchema
 *   touched, no existing param retyped or removed.
 *   WHY THE WIRE HAD TO CHANGE: `due_at` (migration 093) was WRITE-ONLY. It could be set by
 *   task_create and task_update and read by nothing — the only surface that consulted it,
 *   project_briefing's "Waiting on a human" section, selects `blocked_on = 'human'` first,
 *   so a deadline on a task blocked on anything else was unanswerable without raw SQL. A
 *   filter and an ordering are the only way to make "what is due in the next N days" a tool
 *   call rather than a psql session, and a filter has to reach the wire to be callable.
 *   (`task_details`/`task_list` also now RETURN `dueAt`/`blockedOn`, but those are response
 *   fields under a `.passthrough()` record shape, so they move no advertised bytes.)
 *   `sort`'s enum is RENDERED from `config/blockedOnConfig.TASK_LIST_SORTS`, so the
 *   advertised values cannot drift from the orderings listTasks implements.
 *   MEASURED by `src/tests/regen-tool-surface-golden.ts`, which emits these in the SAME run
 *   that rewrote the fixture:
 *     fixture      — `wc -c` on the pretty fixture: 240387 -> 241586  (+1199, +0.50%)
 *     tool count   — `AIDIS_TOOL_DEFINITIONS.length`: 69 -> 69
 *     tools/list   — compact wire: 125808 -> 126834  (+1026, +0.82%); the BASE was
 *                    re-measured off `git show HEAD:...golden.json`, not carried forward
 *                    from the entry above (that chain is explicitly untrustworthy).
 *                    MOVED/ADDED/REMOVED computed by diffing every tool object name-by-name
 *                    against the base fixture, not asserted from the files I edited.
 *     `git diff --numstat` on the fixture: 14 added / 1 removed
 *                    TOOLS WHOSE BYTES MOVED = 1 (task_list) · ADDED 0 · REMOVED 0
 */
import { describe, test, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import {
  AIDIS_TOOL_DEFINITIONS,
  TOOL_CATEGORIES,
  CATEGORY_ORDER,
} from '../config/toolDefinitions.js';
import { OP_REGISTRY, ALL_OP_IDS } from '../config/opRegistry.js';
import { validationSchemas } from '../middleware/validation.js';
import { outputZodSchemas } from '../config/outputSchemas.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const GOLDEN = path.join(here, 'fixtures', 'toolSurface.golden.json');

/** Serialize the surface EXACTLY as the golden was captured (stable, pretty, trailing \n). */
function serializeSurface(): string {
  return (
    JSON.stringify(
      {
        definitions: AIDIS_TOOL_DEFINITIONS,
        categoryOrder: CATEGORY_ORDER,
        toolCategories: TOOL_CATEGORIES,
      },
      null,
      2,
    ) + '\n'
  );
}

describe('tool surface — byte-identical to the pre-refactor golden', () => {
  test('the derived tools/list surface has not drifted a single byte', () => {
    const golden = readFileSync(GOLDEN, 'utf8');
    const actual = serializeSurface();

    // Guard the guard: if the fixture went missing/empty this scan would be a no-op.
    expect(golden.length, 'golden fixture missing/empty — this snapshot would prove nothing').toBeGreaterThan(1000);

    // The load-bearing assertion. vitest prints the first differing region on failure.
    expect(actual).toBe(golden);

    // Belt + suspenders: exact byte length parity (a cheap, unambiguous headline number).
    expect(Buffer.byteLength(actual, 'utf8')).toBe(Buffer.byteLength(golden, 'utf8'));
  });
});

describe('op registry — the closed 67-op source of truth', () => {
  test('registry has exactly 67 ops, all opIds unique', () => {
    // 54 -> 57: the atomic task claim added task_claim/task_renew/task_release.
    // 57 -> 58: the first-class artifact reference added context_artifact —
    // resolve WHERE an accepted external artifact lives + its FAIL-CLOSED verification contract.
    // 58 -> 60: the session IDENTITY read model (Amp-orb eval W3) added
    // session_list/session_get — the instrument that lets an orchestrator VERIFY which
    // session produced a record and who held it (the eval could only correlate screenshots).
    // Each is a DELIBERATE, reviewed surface change — the golden fixture below was regenerated
    // with it (SPEC §10), which is the only legitimate way this number ever moves.
    // 60 -> 63: PHASE 1 positional membership added branch_open /
    // branch_current / branch_close (the thread_* ops remain as deprecated aliases).
    // 63 -> 64: WS2 living summary added project_briefing — the
    // deterministic current-state briefing renderer (gateway project.briefing).
    // 64 -> 65: SK2 added branch_history — a branch's member list, read
    // from the durable membership edges so it survives branch_close.
    // 65 -> 67: P3 added branch_assign / branch_unassign — membership stops
    // being write-once, so a wrong branch (including one the system opened by itself) can be
    // corrected, with an append-only audit row per change.
    // 67 -> 68: P4 L1 added mandrel_contract — discover({action:'contract'}),
    // the agent capture contract, generated from this registry + config/captureVocab.ts.
    // 68 -> 69: reproject added project_move_record —
    // project({action:'move'}), the one thing project membership could not do: change.
    // 69 -> 70: the tag census added project_tags — project({action:'tags'}),
    // "which tags EXIST and how many records carry each". Tag filtering everywhere else needs
    // an EXACT value, so the only previous way to find a tag population was to fetch every
    // record and scan client-side (6,380 records / 65 calls on riverbend). That absence is
    // why hand-written tag lists were the default answer, and why one of them was wrong in
    // both directions on 2026-09-04.
    // 70 -> 72: the decision inbox added
    // decision_answer / decision_discuss — decision.answer / decision.discuss. An OPEN
    // decision (question + >=2 options, each with >=1 pro and >=1 con) is answered by picking
    // an option (folding the rest into alternatives_considered) or kicked back for discussion.
    // 72 -> 67: the five code-scan ops were removed.
    expect(OP_REGISTRY.length).toBe(67);
    expect(new Set(ALL_OP_IDS).size).toBe(67);
  });

  test('every registered opId has a zod INPUT validator and an OUTPUT schema', () => {
    for (const opId of ALL_OP_IDS) {
      expect(opId in validationSchemas, `opId '${opId}' has no validationSchemas entry`).toBe(true);
      expect(opId in outputZodSchemas, `opId '${opId}' has no outputZodSchemas entry`).toBe(true);
    }
  });

  test('every advertised tool corresponds 1:1 to a registry op (no orphan either way)', () => {
    const defNames = AIDIS_TOOL_DEFINITIONS.map((d) => d.name).sort();
    const opIds = [...ALL_OP_IDS].sort();
    expect(defNames).toEqual(opIds);
  });

  test('gateway/action mapping matches the rebuild-plan §2 old→new table', () => {
    // The §2 mapping table, transcribed. This is the doc↔code drift guard: if the registry
    // ever disagrees with the plan's published mapping, this names the offending op.
    const EXPECTED: Record<string, string> = {
      mandrel_ping: 'discover.ping',
      mandrel_status: 'discover.status',
      mandrel_help: 'discover.catalog',
      mandrel_explain: 'discover.explain',
      mandrel_examples: 'discover.examples',
      // P4 L1 — the agent capture contract.
      mandrel_contract: 'discover.contract',
      context_store: 'context.store',
      context_search: 'context.search',
      context_get_recent: 'context.recent',
      context_update: 'context.update',
      context_stats: 'context.stats',
      context_artifact: 'context.artifact',
      context_delete: 'context.delete',
      context_restore: 'context.restore',
      decision_record: 'decision.record',
      decision_search: 'decision.search',
      decision_get: 'decision.get',
      decision_update: 'decision.update',
      decision_stats: 'decision.stats',
      decision_delete: 'decision.delete',
      decision_restore: 'decision.restore',
      // The decision inbox.
      decision_answer: 'decision.answer',
      decision_discuss: 'decision.discuss',
      session_start: 'session.start',
      session_end: 'session.end',
      session_status: 'session.status',
      // session_pin is the one nested-action op: gateway 'session' with sub-actions
      // pin_set/pin_get/pin_clear. Represented as action:'pin' + gatewayActions map.
      session_pin: 'session.pin',
      // Amp-orb eval W3 — the session IDENTITY read model.
      session_list: 'session.list',
      session_get: 'session.get',
      task_create: 'task.create',
      task_list: 'task.list',
      task_details: 'task.details',
      task_update: 'task.update',
      task_bulk_update: 'task.bulk_update',
      task_progress_summary: 'task.progress',
      task_delete: 'task.delete',
      task_restore: 'task.restore',
      cancel_task: 'task.cancel',
      // Atomic task claim.
      task_claim: 'task.claim',
      task_renew: 'task.renew',
      task_release: 'task.release',
      project_create: 'project.create',
      project_list: 'project.list',
      project_switch: 'project.switch',
      project_current: 'project.current',
      project_info: 'project.info',
      // WS2 living summary.
      project_briefing: 'project.briefing',
      project_move_record: 'project.move',
      project_update: 'project.update',
      project_delete: 'project.delete',
      project_insights: 'project.insights',
      project_tags: 'project.tags',
      // The three deliberately-FLAT tools (advertised as their own top-level tools).
      get_recommendations: 'FLAT',
      smart_search: 'FLAT',
      recall_thread: 'FLAT',
      link: 'graph.link',
      unlink: 'graph.unlink',
      get_links: 'graph.links',
      // PHASE 1 positional membership: the branch position surface; the
      // thread_* actions stay registered as deprecated delegating aliases.
      branch_open: 'graph.branch_open',
      branch_current: 'graph.branch_current',
      branch_close: 'graph.branch_close',
      branch_history: 'graph.branch_history',
      branch_assign: 'graph.branch_assign',
      branch_unassign: 'graph.branch_unassign',
      thread_set: 'graph.thread_set',
      thread_current: 'graph.thread_current',
      thread_clear: 'graph.thread_clear',
    };

    // Every registry op matches its §2 mapping…
    for (const op of OP_REGISTRY) {
      const got = op.kind === 'flat' ? 'FLAT' : `${op.gateway}.${op.action}`;
      expect(EXPECTED[op.opId], `no §2 mapping expected for '${op.opId}'`).toBeDefined();
      expect(got, `op '${op.opId}' maps to '${got}' but §2 says '${EXPECTED[op.opId]}'`).toBe(EXPECTED[op.opId]);
    }
    // …and the mapping table covers exactly the registered ops (no missing / extra rows).
    expect(Object.keys(EXPECTED).sort()).toEqual([...ALL_OP_IDS].sort());
  });

  test('the 3 flat tools are exactly recall_thread, smart_search, get_recommendations', () => {
    const flat = OP_REGISTRY.filter((o) => o.kind === 'flat').map((o) => o.opId).sort();
    expect(flat).toEqual(['get_recommendations', 'recall_thread', 'smart_search']);
  });

  test('session_pin carries the pin_* gateway sub-action flattening', () => {
    const pin = OP_REGISTRY.find((o) => o.opId === 'session_pin')!;
    expect(pin.gatewayActions).toEqual({ pin_set: 'set', pin_get: 'get', pin_clear: 'clear' });
  });
});
