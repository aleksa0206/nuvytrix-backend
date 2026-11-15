import type { Knex } from 'knex';
import type { ProbeResult } from './probes';

export interface TargetRow {
  id: number;
  name: string;
  kind: 'icmp' | 'dns';
  host: string;
  dns_query_name: string | null;
  enabled: boolean;
  managed_key: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface TargetStats {
  target_id: number;
  checks: number;
  successes: number;
  avg_latency_ms: number | null;
  avg_packet_loss: number | null;
}

export interface LatestResult {
  target_id: number;
  checked_at: Date;
  success: boolean;
  latency_ms: number | null;
  packet_loss_percent: number | null;
  error: string | null;
}

export type TargetFields = Pick<TargetRow, 'name' | 'kind' | 'host' | 'dns_query_name' | 'enabled'>;

export class MonitoringRepository {
  constructor(private db: Knex) {}

  findTargets(): Promise<TargetRow[]> {
    return this.db<TargetRow>('monitoring_targets').orderBy('id');
  }

  findEnabledTargets(): Promise<TargetRow[]> {
    return this.db<TargetRow>('monitoring_targets').where({ enabled: true }).orderBy('id');
  }

  findTarget(targetId: number): Promise<TargetRow | undefined> {
    return this.db<TargetRow>('monitoring_targets').where({ id: targetId }).first();
  }

  findTargetByManagedKey(key: string): Promise<TargetRow | undefined> {
    return this.db<TargetRow>('monitoring_targets').where({ managed_key: key }).first();
  }

  async createTarget(fields: TargetFields, managedKey: string | null = null): Promise<TargetRow> {
    const [row] = await this.db('monitoring_targets')
      .insert({ ...fields, managed_key: managedKey })
      .returning('*');
    return row;
  }

  async updateTarget(
    targetId: number,
    fields: Partial<TargetFields>
  ): Promise<TargetRow | undefined> {
    const [row] = await this.db('monitoring_targets')
      .where({ id: targetId })
      .update({ ...fields, updated_at: this.db.fn.now() })
      .returning('*');
    return row;
  }

  async deleteTarget(targetId: number): Promise<void> {
    await this.db('monitoring_targets').where({ id: targetId }).delete();
  }

  async insertResult(targetId: number, result: ProbeResult): Promise<void> {
    await this.db('monitoring_results').insert({
      target_id: targetId,
      success: result.success,
      latency_ms: result.latencyMs,
      packet_loss_percent: result.packetLossPercent,
      error: result.error,
    });
  }

  findLatestResults(): Promise<LatestResult[]> {
    return this.db('monitoring_results')
      .distinctOn('target_id')
      .select('target_id', 'checked_at', 'success', 'latency_ms', 'packet_loss_percent', 'error')
      .orderBy([{ column: 'target_id' }, { column: 'checked_at', order: 'desc' }]);
  }

  findLastSuccess(): Promise<{ target_id: number; checked_at: Date }[]> {
    return this.db('monitoring_results')
      .where('success', true)
      .select('target_id')
      .max('checked_at as checked_at')
      .groupBy('target_id');
  }

  findStatsSince(since: Date): Promise<TargetStats[]> {
    return this.db('monitoring_results')
      .where('checked_at', '>=', since)
      .select(
        'target_id',
        this.db.raw('COUNT(*)::int AS checks'),
        this.db.raw('COUNT(*) FILTER (WHERE success)::int AS successes'),
        this.db.raw('AVG(latency_ms) AS avg_latency_ms'),
        this.db.raw('AVG(packet_loss_percent) AS avg_packet_loss')
      )
      .groupBy('target_id');
  }

  /** Measurements averaged into fixed buckets; only buckets that contain checks are returned. */
  findSeries(targetId: number, since: Date, bucketMinutes: number) {
    return this.db('monitoring_results')
      .where('target_id', targetId)
      .andWhere('checked_at', '>=', since)
      .select(
        this.db.raw(
          `date_bin(make_interval(mins => ?), checked_at, TIMESTAMPTZ '2000-01-01') AS bucket`,
          [bucketMinutes]
        ),
        this.db.raw('COUNT(*)::int AS checks'),
        this.db.raw('COUNT(*) FILTER (WHERE success)::int AS successes'),
        this.db.raw('AVG(latency_ms) AS avg_latency_ms'),
        this.db.raw('MAX(latency_ms) AS max_latency_ms'),
        this.db.raw('AVG(packet_loss_percent) AS avg_packet_loss')
      )
      .groupByRaw('1')
      .orderBy('bucket') as unknown as Promise<
      {
        bucket: Date;
        checks: number;
        successes: number;
        avg_latency_ms: number | null;
        max_latency_ms: number | null;
        avg_packet_loss: number | null;
      }[]
    >;
  }

  deleteResultsBefore(cutoff: Date): Promise<number> {
    return this.db('monitoring_results').where('checked_at', '<', cutoff).delete();
  }
}
