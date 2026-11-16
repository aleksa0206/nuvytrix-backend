import type { Knex } from 'knex';

// Jitter for ping checks, and HTTP(S) targets with status code and certificate expiry.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('monitoring_results', (table) => {
    table.double('jitter_ms');
    table.integer('http_status');
    table.timestamp('cert_expires_at', { useTz: true });
  });
  // The kind check was created by knex's checkIn; its name is generated, so drop it by lookup.
  await knex.raw(`
    DO $$
    DECLARE c text;
    BEGIN
      FOR c IN SELECT conname FROM pg_constraint
               WHERE conrelid = 'monitoring_targets'::regclass AND contype = 'c'
                 AND pg_get_constraintdef(oid) LIKE '%kind%'
      LOOP
        EXECUTE format('ALTER TABLE monitoring_targets DROP CONSTRAINT %I', c);
      END LOOP;
    END $$;
  `);
  await knex.raw(
    `ALTER TABLE monitoring_targets ADD CONSTRAINT monitoring_targets_kind_check
     CHECK (kind IN ('icmp', 'dns', 'http'))`
  );
}

export async function down(knex: Knex): Promise<void> {
  await knex('monitoring_targets').where({ kind: 'http' }).delete();
  await knex.raw('ALTER TABLE monitoring_targets DROP CONSTRAINT monitoring_targets_kind_check');
  await knex.raw(
    `ALTER TABLE monitoring_targets ADD CONSTRAINT monitoring_targets_kind_check
     CHECK (kind IN ('icmp', 'dns'))`
  );
  await knex.schema.alterTable('monitoring_results', (table) => {
    table.dropColumn('jitter_ms');
    table.dropColumn('http_status');
    table.dropColumn('cert_expires_at');
  });
}
