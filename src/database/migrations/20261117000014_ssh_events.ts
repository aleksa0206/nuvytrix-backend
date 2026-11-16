import type { Knex } from 'knex';

// SSH authentication events read from the host's auth.log (read-only).
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('ssh_events', (table) => {
    table.bigIncrements('id').primary();
    table.timestamp('logged_at', { useTz: true }).notNullable();
    table.integer('pid').notNullable();
    table.string('kind', 16).notNullable(); // accepted | failed | invalid_user
    table.string('username', 64);
    table.specificType('source_ip', 'inet');
    table.string('method', 32);
    table.unique(['logged_at', 'pid', 'kind']);
    table.index(['logged_at']);
    table.index(['source_ip']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTable('ssh_events');
}
