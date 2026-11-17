import type { Knex } from 'knex';

// A key per alert subject: an open alert with the same key is not raised again, and the matching
// recovery resolves it.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('alerts', (table) => {
    table.string('key', 160);
    table.timestamp('resolved_at', { useTz: true });
  });
  await knex.raw('CREATE INDEX alerts_open_key ON alerts (key) WHERE resolved_at IS NULL');
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('DROP INDEX IF EXISTS alerts_open_key');
  await knex.schema.alterTable('alerts', (table) => {
    table.dropColumn('key');
    table.dropColumn('resolved_at');
  });
}
