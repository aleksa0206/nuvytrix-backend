import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('admins', (table) => {
    table.increments('id').primary();
    table.string('username', 64).notNullable().unique();
    table.string('password_hash', 100).notNullable();
    table.integer('failed_login_attempts').notNullable().defaultTo(0);
    table.timestamp('locked_until', { useTz: true });
    table.timestamp('last_login_at', { useTz: true });
    table.timestamps(true, true);
  });

  await knex.schema.createTable('sessions', (table) => {
    table.increments('id').primary();
    table.integer('admin_id').notNullable().references('admins.id').onDelete('CASCADE');
    // Only the SHA-256 of the cookie value is stored, so a database leak does not leak sessions.
    table.string('token_hash', 64).notNullable().unique();
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('last_seen_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('expires_at', { useTz: true }).notNullable();
    table.specificType('ip_address', 'inet');
    table.string('user_agent', 512);
    table.index(['expires_at']);
  });

  await knex.schema.createTable('audit_logs', (table) => {
    table.bigIncrements('id').primary();
    table.integer('admin_id').references('admins.id').onDelete('SET NULL');
    table.string('action', 64).notNullable();
    table.string('entity_type', 64);
    table.string('entity_id', 64);
    table.jsonb('details');
    table.specificType('ip_address', 'inet');
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.index(['created_at']);
    table.index(['action']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTable('audit_logs');
  await knex.schema.dropTable('sessions');
  await knex.schema.dropTable('admins');
}
