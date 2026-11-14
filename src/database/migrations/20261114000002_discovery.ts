import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('discovery_scans', (table) => {
    table.increments('id').primary();
    table.specificType('target', 'cidr').notNullable();
    table.string('status', 16).notNullable().checkIn(['running', 'completed', 'failed']);
    table.integer('triggered_by').references('admins.id').onDelete('SET NULL');
    table.timestamp('started_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('finished_at', { useTz: true });
    table.integer('hosts_up');
    table.integer('new_devices');
    table.string('error', 1000);
    table.index(['started_at']);
  });

  await knex.schema.createTable('devices', (table) => {
    table.increments('id').primary();
    table.specificType('mac_address', 'macaddr');
    table.specificType('ip_address', 'inet').notNullable();
    table.string('hostname', 255);
    table.string('vendor', 255);
    table.string('custom_name', 100);
    table.string('device_type', 32);
    table.text('notes');
    table.timestamp('first_seen_at', { useTz: true }).notNullable();
    table.timestamp('last_seen_at', { useTz: true }).notNullable();
    table.integer('last_scan_id').references('discovery_scans.id').onDelete('SET NULL');
    table.timestamps(true, true);
    table.index(['ip_address']);
    table.index(['last_seen_at']);
  });
  // The scanning host never sees its own MAC, so some devices are identified by IP alone.
  await knex.raw(
    'CREATE UNIQUE INDEX devices_mac_address_unique ON devices (mac_address) WHERE mac_address IS NOT NULL'
  );
  await knex.raw(
    'CREATE UNIQUE INDEX devices_ip_without_mac_unique ON devices (ip_address) WHERE mac_address IS NULL'
  );

  await knex.schema.createTable('device_observations', (table) => {
    table.bigIncrements('id').primary();
    table.integer('device_id').notNullable().references('devices.id').onDelete('CASCADE');
    table.integer('scan_id').notNullable().references('discovery_scans.id').onDelete('CASCADE');
    table.specificType('ip_address', 'inet').notNullable();
    table.string('hostname', 255);
    table.timestamp('observed_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.unique(['device_id', 'scan_id']);
    table.index(['device_id', 'observed_at']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTable('device_observations');
  await knex.schema.dropTable('devices');
  await knex.schema.dropTable('discovery_scans');
}
