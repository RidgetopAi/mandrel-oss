#!/usr/bin/env node
/**
 * Reset the admin user's password.
 *
 * Usage:
 *   ADMIN_PASSWORD='your-new-password' node reset-password.js
 *   node reset-password.js 'your-new-password'
 *
 * DB connection comes from env (falls back to local peer-auth defaults):
 *   DATABASE_URL  OR  DB_USER/DB_HOST/DB_NAME/DB_PASSWORD/DB_PORT
 */

const bcrypt = require('bcryptjs');
const { Pool } = require('pg');

const newPassword = process.env.ADMIN_PASSWORD || process.argv[2];
if (!newPassword) {
  console.error('❌ No password provided. Set ADMIN_PASSWORD or pass it as the first argument.');
  process.exit(1);
}
const username = process.env.ADMIN_USERNAME || 'admin';

const pool = new Pool(
  process.env.DATABASE_URL
    ? { connectionString: process.env.DATABASE_URL }
    : {
        user: process.env.DB_USER || process.env.DATABASE_USER || 'mandrel',
        host: process.env.DB_HOST || process.env.DATABASE_HOST || 'localhost',
        database: process.env.DB_NAME || process.env.DATABASE_NAME || 'mandrel',
        password: process.env.DB_PASSWORD || process.env.DATABASE_PASSWORD || '',
        port: Number(process.env.DB_PORT || process.env.DATABASE_PORT || 5432),
      }
);

async function resetPassword() {
  try {
    const hashedPassword = await bcrypt.hash(newPassword, 12);
    const result = await pool.query(
      'UPDATE admin_users SET password_hash = $1 WHERE username = $2 RETURNING username',
      [hashedPassword, username]
    );

    if (result.rows.length > 0) {
      console.log(`✅ Password reset for user: ${result.rows[0].username}`);
    } else {
      console.log(`❌ User '${username}' not found`);
      process.exitCode = 1;
    }
  } catch (error) {
    console.error('❌ Error resetting password:', error.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

resetPassword();
