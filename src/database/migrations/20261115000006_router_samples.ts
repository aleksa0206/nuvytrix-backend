import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  // One row per router poll: the values worth charting over time. The router keeps no history itself.
  await knex.schema.createTable('router_samples', (table) => {
    table.bigIncrements('id').primary();
    table.timestamp('captured_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.bigInteger('uptime_seconds');
    table.double('cpu_percent');
    table.double('memory_percent');
    table.double('optical_rx_dbm');
    table.double('optical_tx_dbm');
    table.double('optical_temperature_c');
    table.double('optical_voltage_mv');
    table.double('optical_bias_ma');
    table.bigInteger('wan_bytes_sent');
    table.bigInteger('wan_bytes_received');
    table.integer('wifi_clients');
    table.integer('devices_online');
    table.jsonb('lan_ports');
    table.jsonb('wlan');
    table.index(['captured_at']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTable('router_samples');
}
