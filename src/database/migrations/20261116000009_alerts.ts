import type { Knex } from 'knex';

// Notifications Nuvytrix raises by itself: internet down and back, new devices, weak optical signal.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('alerts', (table) => {
    table.bigIncrements('id').primary();
    table.string('kind', 40).notNullable();
    table.string('severity', 10).notNullable();
    table.string('title', 200).notNullable();
    table.jsonb('details');
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('read_at', { useTz: true });
    table.index(['created_at']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTable('alerts');
}
