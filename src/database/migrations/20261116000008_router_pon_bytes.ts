import type { Knex } from 'knex';

// GPON interface byte counters: all internet traffic, unlike the UPnP WAN counters, which miss
// hardware-forwarded traffic.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('router_samples', (table) => {
    table.bigInteger('pon_bytes_sent');
    table.bigInteger('pon_bytes_received');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('router_samples', (table) => {
    table.dropColumn('pon_bytes_sent');
    table.dropColumn('pon_bytes_received');
  });
}
