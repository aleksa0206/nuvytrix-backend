import type { Knex } from 'knex';
import * as foundation from './20261114000001_foundation';
import * as discovery from './20261114000002_discovery';
import * as firewall from './20261114000003_firewall';
import * as firewallPolicies from './20261114000004_firewall_policies';
import * as monitoring from './20261114000005_monitoring';
import * as routerSamples from './20261115000006_router_samples';
import * as auditEntityLength from './20261116000007_audit_entity_length';
import * as routerPonBytes from './20261116000008_router_pon_bytes';
import * as alerts from './20261116000009_alerts';
import * as deviceIntelligence from './20261117000010_device_intelligence';

type Migration = Knex.Migration;

// Imported explicitly instead of scanned from disk, so the same list works under tsx, Vitest
// and the compiled build. New migrations are appended; names must never change once deployed.
const migrations: Record<string, Migration> = {
  '20261114000001_foundation': foundation,
  '20261114000002_discovery': discovery,
  '20261114000003_firewall': firewall,
  '20261114000004_firewall_policies': firewallPolicies,
  '20261114000005_monitoring': monitoring,
  '20261115000006_router_samples': routerSamples,
  '20261116000007_audit_entity_length': auditEntityLength,
  '20261116000008_router_pon_bytes': routerPonBytes,
  '20261116000009_alerts': alerts,
  '20261117000010_device_intelligence': deviceIntelligence,
};

export const migrationSource: Knex.MigrationSource<string> = {
  getMigrations: async () => Object.keys(migrations),
  getMigrationName: (name) => name,
  getMigration: async (name) => migrations[name]!,
};
