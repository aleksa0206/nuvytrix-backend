import type { Knex } from 'knex';
import * as foundation from './20261114000001_foundation';
import * as discovery from './20261114000002_discovery';

type Migration = Knex.Migration;

// Imported explicitly instead of scanned from disk, so the same list works under tsx, Vitest
// and the compiled build. New migrations are appended; names must never change once deployed.
const migrations: Record<string, Migration> = {
  '20261114000001_foundation': foundation,
  '20261114000002_discovery': discovery,
};

export const migrationSource: Knex.MigrationSource<string> = {
  getMigrations: async () => Object.keys(migrations),
  getMigrationName: (name) => name,
  getMigration: async (name) => migrations[name]!,
};
