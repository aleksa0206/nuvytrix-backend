import type { Knex } from 'knex';

// Small persistent key/value state: alert thresholds and markers such as "baseline done".
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('app_settings', (table) => {
    table.string('key', 64).primary();
    table.jsonb('value').notNullable();
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });
  // SSH events imported before this table existed were the baseline already.
  const hasSsh = await knex('ssh_events').first('id');
  if (hasSsh) await knex('app_settings').insert({ key: 'ssh_baseline_done', value: 'true' });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTable('app_settings');
}
