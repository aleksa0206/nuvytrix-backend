import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('firewall_policies', (table) => {
    table.increments('id').primary();
    table.string('name', 100).notNullable();
    table.text('description');
    table.string('action', 8).notNullable().checkIn(['accept', 'deny']);
    table
      .string('direction', 24)
      .notNullable()
      .checkIn(['internet_to_lan', 'internet_to_router', 'lan_to_internet', 'lan_to_router']);
    table.string('protocol', 8).notNullable().checkIn(['any', 'tcp', 'udp', 'icmp']);
    table.string('source', 64).notNullable();
    table.string('destination', 64).notNullable();
    table.string('destination_ports', 11);
    // The router exposes no supported API, so nothing here is ever "confirmed by the router":
    // draft = stored only in this app, pending_manual = waiting to be applied by hand,
    // marked_applied = the administrator states it was applied, apply_failed = manual apply failed.
    table
      .string('status', 16)
      .notNullable()
      .checkIn(['draft', 'pending_manual', 'marked_applied', 'apply_failed', 'retired']);
    table.string('status_note', 500);
    table.timestamp('status_changed_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.integer('created_by').references('admins.id').onDelete('SET NULL');
    table.timestamps(true, true);
    table.index(['status']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTable('firewall_policies');
}
