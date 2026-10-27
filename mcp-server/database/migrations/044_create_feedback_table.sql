-- Migration: 044 — In-dashboard tester feedback
-- Date: 2026-06-11
-- Description:
--   Creates the `feedback` table that backs the dashboard feedback/issues widget.
--   Testers submit bug / idea / question reports (with severity + free-text message)
--   directly from Mandrel Command; rows land here for Operator/Coordinator to read. The
--   `username` is server-derived from the authenticated JWT (never client-trusted).
--
-- This migration number (044) is ABOVE BASELINE_THROUGH (42), so it runs normally on
-- BOTH fresh builds (after the 000 baseline) and existing/already-baselined instances.
--
-- Idempotent: CREATE TABLE IF NOT EXISTS + CREATE INDEX IF NOT EXISTS. Safe to re-run.

CREATE TABLE IF NOT EXISTS feedback (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username TEXT,
    type TEXT NOT NULL DEFAULT 'bug' CHECK (type IN ('bug', 'idea', 'question')),
    severity TEXT NOT NULL DEFAULT 'medium' CHECK (severity IN ('low', 'medium', 'high')),
    message TEXT NOT NULL CHECK (length(trim(message)) > 0),
    page TEXT,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_feedback_created_at ON feedback(created_at DESC);

COMMENT ON TABLE feedback IS 'Tester-submitted feedback (bug/idea/question) from the Mandrel Command dashboard; username is JWT-derived.';
