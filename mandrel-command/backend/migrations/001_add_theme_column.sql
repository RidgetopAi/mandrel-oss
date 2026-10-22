-- Migration: Add theme column to admin_users table
-- Date: 2025-10-25
-- Description: Adds theme preference support for dark/light mode

-- Add theme column with default value 'light'
ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS theme VARCHAR(20) DEFAULT 'light';

-- Add check constraint to ensure valid theme values
ALTER TABLE admin_users DROP CONSTRAINT IF EXISTS admin_users_theme_check;
ALTER TABLE admin_users ADD CONSTRAINT admin_users_theme_check CHECK (theme IN ('light', 'dark'));

-- Create index for theme queries (optional but good for performance)
CREATE INDEX IF NOT EXISTS idx_admin_users_theme ON admin_users(theme);

-- Update existing users to have default theme
UPDATE admin_users SET theme = 'light' WHERE theme IS NULL;

-- Verification query
-- SELECT id, username, email, theme FROM admin_users;
