import type { Knex } from 'knex';

// Router objects are audited by their TR-098 path, e.g.
// InternetGatewayDevice.LANDevice.1.LANHostConfigManagement.DHCPStaticAddress.1 (78 characters).
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('audit_logs', (table) => {
    table.string('entity_id', 255).alter();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('UPDATE audit_logs SET entity_id = left(entity_id, 64)');
  await knex.schema.alterTable('audit_logs', (table) => {
    table.string('entity_id', 64).alter();
  });
}
