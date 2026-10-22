-- Migration: 043 — Force password change on first login (new provisions only)
-- Date: 2026-06-11
-- Description:
--   Adds `must_change_password` to admin_users. New admin accounts created by the
--   provisioner are flagged TRUE so that on first dashboard login they are forced to
--   set a new password before using the app. Existing admins are GRANDFATHERED: the
--   column defaults to FALSE, so every pre-existing row is unaffected (their next
--   login is not disrupted). The provisioner sets TRUE only on a genuinely new INSERT;
--   the change-password endpoint clears it (FALSE) on a successful policy-compliant
--   change.
--
-- This migration number (043) is ABOVE BASELINE_THROUGH (42), so it runs normally on
-- BOTH fresh builds (after the 000 baseline) and existing/already-baselined instances.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS. Safe to re-run. Existing rows -> false.

ALTER TABLE admin_users
  ADD COLUMN IF NOT EXISTS must_change_password boolean NOT NULL DEFAULT false;
