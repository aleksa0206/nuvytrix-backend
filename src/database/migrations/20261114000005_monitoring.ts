import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('monitoring_targets', (table) => {
    table.increments('id').primary();
    table.string('name', 100).notNullable();
    table.string('kind', 8).notNullable().checkIn(['icmp', 'dns']);
    // icmp: the host to ping. dns: the resolver to query.
    table.string('host', 255).notNullable();
    table.string('dns_query_name', 255);
    table.boolean('enabled').notNullable().defaultTo(true);
    // Created from configuration (e.g. ROUTER_HOST) and not editable through the API.
    table.string('managed_key', 32).unique();
    table.timestamps(true, true);
  });

  await knex.schema.createTable('monitoring_results', (table) => {
    table.bigIncrements('id').primary();
    table
      .integer('target_id')
      .notNullable()
      .references('monitoring_targets.id')
      .onDelete('CASCADE');
    table.timestamp('checked_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.boolean('success').notNullable();
    table.double('latency_ms');
    table.double('packet_loss_percent');
    table.string('error', 500);
    table.index(['target_id', 'checked_at']);
    table.index(['checked_at']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTable('monitoring_results');
  await knex.schema.dropTable('monitoring_targets');
}
