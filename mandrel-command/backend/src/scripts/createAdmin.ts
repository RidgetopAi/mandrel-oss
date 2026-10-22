/**
 * First-install dashboard admin bootstrap (run by ./install.sh inside the backend container):
 *
 *   ADMIN_USERNAME=admin ADMIN_PASSWORD=... node dist/scripts/createAdmin.js
 *
 * Goes through the dashboard's own user model (AuthService.createUser — the same bcrypt hashing
 * and admin_users insert as POST /auth/register), so there is no second path into admin_users.
 * Idempotent: an existing username is left untouched (its password is NOT changed).
 * Exit: 0 created or already present · 1 failed.
 */
import { AuthService } from '../services/auth';
import { db } from '../database/connection';

export const DEFAULT_ADMIN_EMAIL_DOMAIN = 'mandrel.local';

export async function createAdmin(
  username: string,
  password: string,
  email: string = `${username}@${DEFAULT_ADMIN_EMAIL_DOMAIN}`,
): Promise<'created' | 'exists'> {
  if (await AuthService.findUserByUsername(username)) return 'exists';
  await AuthService.createUser({ username, email, password, role: 'admin' });
  return 'created';
}

async function main(): Promise<number> {
  const username = process.env.ADMIN_USERNAME || 'admin'; // env-read: bootstrap CLI args
  const password = process.env.ADMIN_PASSWORD || ''; // env-read: bootstrap CLI args
  if (!password) {
    console.error('createAdmin: ADMIN_PASSWORD is required');
    return 1;
  }
  try {
    const result = await createAdmin(username, password, process.env.ADMIN_EMAIL || undefined); // env-read: bootstrap CLI args
    console.log(result === 'created' ? `admin user '${username}' created` : `admin user '${username}' already exists`);
    return 0;
  } catch (error) {
    console.error('createAdmin failed:', error instanceof Error ? error.message : error);
    return 1;
  } finally {
    await db.end().catch(() => undefined);
  }
}

if (require.main === module) {
  main().then((code) => process.exit(code));
}
