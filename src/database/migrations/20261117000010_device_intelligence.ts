import type { Knex } from 'knex';

// Device intelligence: identity changes, DHCP details from the router, presence history, tags and
// trust. Everything here is added; nothing existing is altered.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('devices', (table) => {
    table.specificType('tags', 'text[]').notNullable().defaultTo('{}');
    // null = not reviewed yet, true = trusted, false = untrusted.
    table.boolean('trusted');
    // From the router's device list: DHCP or static, when the lease ends, and its reservation.
    table.string('address_source', 16);
    table.timestamp('lease_expires_at', { useTz: true });
    table.specificType('reserved_ip', 'inet');
    table.string('connection', 16);
  });

  await knex.schema.createTable('device_events', (table) => {
    table.bigIncrements('id').primary();
    table.integer('device_id').references('devices.id').onDelete('CASCADE');
    table.string('kind', 24).notNullable();
    table.string('old_value', 255);
    table.string('new_value', 255);
    table.jsonb('details');
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.index(['device_id', 'created_at']);
    table.index(['created_at']);
  });

  // One row per device per router read (every few minutes): online or not.
  await knex.schema.createTable('device_presence', (table) => {
    table.bigIncrements('id').primary();
    table.integer('device_id').notNullable().references('devices.id').onDelete('CASCADE');
    table.timestamp('sampled_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.boolean('online').notNullable();
    table.index(['device_id', 'sampled_at']);
    table.index(['sampled_at']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTable('device_presence');
  await knex.schema.dropTable('device_events');
  await knex.schema.alterTable('devices', (table) => {
    table.dropColumn('tags');
    table.dropColumn('trusted');
    table.dropColumn('address_source');
    table.dropColumn('lease_expires_at');
    table.dropColumn('reserved_ip');
    table.dropColumn('connection');
  });
}
