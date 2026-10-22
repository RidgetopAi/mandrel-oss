-- ROLLBACK for migration 083 (position-per-loop purge).
--
-- 083 deleted branch_positions rows keyed by resolved-DB-session UUIDs. Positions are
-- ephemeral working state with no history behind them, so the deletion is not
-- reconstructable and is deliberately NOT reconstructed: reverted code re-creates a
-- caller's position on its next branch_open / task claim. Nothing to do.

SELECT 1; -- intentional no-op
