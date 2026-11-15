import type { Knex } from 'knex';
import * as foundation from './20261114000001_foundation';
import * as discovery from './20261114000002_discovery';
import * as firewall from './20261114000003_firewall';
import * as firewallPolicies from './20261114000004_firewall_policies';

type Migration = Knex.Migration;

// Imported explicitly instead of scanned from disk, so the same list works under tsx, Vitest
// and the compiled build. New migrations are appended; names must never change once deployed.
const migrations: Record<string, Migration> = {
  '20261114000001_foundation': foundation,
  '20261114000002_discovery': discovery,
  '20261114000003_firewall': firewall,
  '20261114000004_firewall_policies': firewallPolicies,
};

export const migrationSource: Knex.MigrationSource<string> = {
  getMigrations: async () => Object.keys(migrations),
  getMigrationName: (name) => name,
  getMigration: async (name) => migrations[name]!,
};
