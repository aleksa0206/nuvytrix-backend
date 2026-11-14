import request from 'supertest';
import app from '../../src/app';
import { db } from '../../src/config/db';
import { container, resetContainer } from '../../src/container';
import { runMigrations } from '../../src/database/migrate';

let migrated = false;

/** Empties every table and rebuilds the container, which also clears in-memory login lockouts. */
export async function prepareDatabase(): Promise<void> {
  resetContainer();
  if (!migrated) {
    await runMigrations();
    migrated = true;
  }
  const tables = await db
    .select('tablename')
    .from('pg_tables')
    .where('schemaname', 'public')
    .whereNotIn('tablename', ['knex_migrations', 'knex_migrations_lock']);
  if (tables.length > 0) {
    const names = tables.map((table: { tablename: string }) => `"${table.tablename}"`).join(', ');
    await db.raw(`TRUNCATE ${names} RESTART IDENTITY CASCADE`);
  }
}

export const TEST_ADMIN = { username: 'admin', password: 'correct-horse-battery' };

/** Creates the test admin and returns an agent that carries its session cookie. */
export async function signedInAgent() {
  await container.authService.createOrResetAdmin(TEST_ADMIN.username, TEST_ADMIN.password);
  const agent = request.agent(app);
  const res = await agent.post('/api/auth/login').send(TEST_ADMIN);
  if (res.status !== 200) throw new Error(`Test login failed with ${res.status}`);
  return agent;
}

export async function closeDatabase(): Promise<void> {
  await db.destroy();
}
