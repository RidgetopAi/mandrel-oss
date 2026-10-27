-- Migration 083: POSITION IS PER-LOOP — purge session-id-keyed branch_positions rows.
-- (branch fix/position-per-loop.)
--
-- WHY: position keying moved from "the RAM-resolved DB session id, connection id as
-- fallback" to "the connection identity, always" (handlers/project.ts
-- resolvePositionKeys). Under MANDREL_SESSION_RESOLVER_MODE=actor one DB session is
-- shared by EVERY connection of an actor, so a session-id key let one agent's position
-- stamp false DECLARED-tier `informs` edges onto a concurrent agent's writes — measured
-- twice on prod 2026-08-13 (edges and an earlier change, both pruned).
--
-- WHAT THIS DELETES: rows whose session_key is a UUID — those are the keys written from
-- the old resolved-DB-session path, unreachable under connection keying (connection ids
-- are caller-chosen strings like 'coordinator-adhoc' / 'builder-<id>'; the resolved session
-- ids were always randomUUID()). Rows already keyed by a connection id are kept and remain
-- valid. A position is ephemeral working state (re-opened by branch_open / task claim), so
-- the worst cost of an over-match — a caller that chose a UUID as its connection id — is
-- one cleared position, not lost history. Nothing in `links` is touched.

DELETE FROM branch_positions
 WHERE session_key ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
