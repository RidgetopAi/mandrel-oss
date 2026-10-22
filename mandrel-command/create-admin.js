#!/usr/bin/env node
/**
 * Create the initial admin user.
 *
 * Usage:
 *   ADMIN_PASSWORD='your-password' node create-admin.js
 *   node create-admin.js 'your-password'
 *
 * DB connection comes from env (falls back to local peer-auth defaults):
 *   DATABASE_URL  OR  DB_USER/DB_HOST/DB_NAME/DB_PASSWORD/DB_PORT
 */

const bcrypt = require('bcrypt');
const { Pool } = require('pg');
const crypto = require('crypto');

const adminPassword = process.env.ADMIN_PASSWORD || process.argv[2];
if (!adminPassword) {
  console.error('❌ No password provided. Set ADMIN_PASSWORD or pass it as the first argument.');
  process.exit(1);
}
const adminUsername = process.env.ADMIN_USERNAME || 'admin';
const adminEmail = process.env.ADMIN_EMAIL || 'admin@mandrel.local';

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

async function createAdminUser() {
  try {
    await pool.query('SELECT 1');

    const userCheck = await pool.query(
      'SELECT username FROM admin_users WHERE username = $1',
      [adminUsername]
    );
    if (userCheck.rows.length > 0) {
      console.log(`✅ Admin user '${adminUsername}' already exists.`);
      return;
    }

    const hashedPassword = await bcrypt.hash(adminPassword, 12);
    const userId = crypto.randomUUID();

    await pool.query(
      `INSERT INTO admin_users (id, username, email, password_hash, role, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, NOW(), NOW())`,
      [userId, adminUsername, adminEmail, hashedPassword, 'admin']
    );

    console.log(`✅ Admin user '${adminUsername}' created.`);
  } catch (error) {
    console.error('❌ Error creating admin user:', error.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

createAdminUser();
