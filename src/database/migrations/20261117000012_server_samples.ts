import type { Knex } from 'knex';

// One row per minute with the server's own health and the database's, for history and alerts.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('server_samples', (table) => {
    table.bigIncrements('id').primary();
    table.timestamp('sampled_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.double('cpu_percent');
    table.double('load1');
    table.double('memory_percent');
    table.double('swap_percent');
    table.double('temperature_c');
    table.boolean('on_battery');
    table.integer('battery_percent');
    table.jsonb('disks');
    table.bigInteger('net_errors');
    table.boolean('db_up');
    table.integer('db_connections');
    table.bigInteger('db_size_bytes');
    table.double('db_longest_query_seconds');
    table.index(['sampled_at']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTable('server_samples');
}
