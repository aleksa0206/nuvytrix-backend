import type { Knex } from 'knex';

// Port and service scans of devices on the LAN: one row per scan, and the open ports per device
// with when they appeared and closed.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('port_scans', (table) => {
    table.bigIncrements('id').primary();
    table.string('trigger', 16).notNullable(); // scheduled | manual
    table.string('status', 16).notNullable().defaultTo('running');
    table.integer('hosts');
    table.integer('changes');
    table.string('error', 1000);
    table.timestamp('started_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('finished_at', { useTz: true });
  });

  await knex.schema.createTable('device_ports', (table) => {
    table.bigIncrements('id').primary();
    table.integer('device_id').notNullable().references('devices.id').onDelete('CASCADE');
    table.string('protocol', 4).notNullable();
    table.integer('port').notNullable();
    table.string('service', 64);
    table.string('product', 128);
    table.string('version', 64);
    table.timestamp('first_seen_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('last_seen_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('closed_at', { useTz: true });
    table.index(['device_id']);
  });

  await knex.schema.alterTable('devices', (table) => {
    // The first port scan of a device sets the baseline; later changes are reported.
    table.timestamp('ports_scanned_at', { useTz: true });
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('devices', (table) => table.dropColumn('ports_scanned_at'));
  await knex.schema.dropTable('device_ports');
  await knex.schema.dropTable('port_scans');
}
