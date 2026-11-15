import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('firewall_log_imports', (table) => {
    table.increments('id').primary();
    table.string('file_name', 255).notNullable();
    table.integer('file_size_bytes').notNullable();
    table.string('file_sha256', 64).notNullable();
    table.integer('total_lines').notNullable();
    table.integer('parsed_events').notNullable();
    table.integer('inserted_events').notNullable();
    table.integer('duplicate_events').notNullable();
    table.integer('rejected_lines').notNullable();
    table.integer('blank_lines').notNullable();
    table.timestamp('first_event_at', { useTz: true });
    table.timestamp('last_event_at', { useTz: true });
    table.integer('imported_by').references('admins.id').onDelete('SET NULL');
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });

  await knex.schema.createTable('firewall_events', (table) => {
    table.bigIncrements('id').primary();
    table
      .integer('import_id')
      .notNullable()
      .references('firewall_log_imports.id')
      .onDelete('CASCADE');
    table.timestamp('occurred_at', { useTz: true }).notNullable();
    table.string('severity', 16);
    table.string('in_interface', 64);
    table.string('out_interface', 64);
    table.string('direction_raw', 32);
    table
      .string('direction', 24)
      .checkIn(['internet_to_lan', 'internet_to_router', 'lan_to_internet', 'lan_to_router']);
    table.string('action_raw', 16).notNullable();
    table.string('action', 8).notNullable().checkIn(['accept', 'deny']);
    table.specificType('source_ip', 'inet').notNullable();
    table.specificType('destination_ip', 'inet').notNullable();
    table.smallint('ip_version').notNullable();
    table.string('protocol', 16).notNullable();
    table.integer('source_port');
    table.integer('destination_port');
    table.text('raw_line').notNullable();
    table.string('dedupe_hash', 64).notNullable();
    table.integer('occurrence').notNullable();
    table.unique(['dedupe_hash', 'occurrence']);
    table.index(['occurred_at']);
    table.index(['action', 'occurred_at']);
    table.index(['source_ip']);
    table.index(['destination_ip']);
    table.index(['destination_port']);
  });

  await knex.schema.createTable('firewall_rejected_lines', (table) => {
    table.bigIncrements('id').primary();
    table
      .integer('import_id')
      .notNullable()
      .references('firewall_log_imports.id')
      .onDelete('CASCADE');
    table.integer('line_number').notNullable();
    table.string('reason', 200).notNullable();
    table.text('raw_line').notNullable();
    table.index(['import_id', 'line_number']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTable('firewall_rejected_lines');
  await knex.schema.dropTable('firewall_events');
  await knex.schema.dropTable('firewall_log_imports');
}
