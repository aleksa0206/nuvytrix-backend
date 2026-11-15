import { AppError, NotFoundError } from '../../common/errors/AppError';
import { ErrorCode } from '../../common/errors/errorCodes';
import { logger } from '../../config/logger';
import type { RequestContext } from '../auth/auth.types';
import type { AuditService } from '../audit/audit.service';
import type { MonitoringRepository, TargetFields, TargetRow } from './monitoring.repository';
import type { Prober, ProbeResult } from './probes';

export const ROUTER_TARGET_KEY = 'router';
const UPTIME_WINDOW_HOURS = 24;
const MAX_SERIES_POINTS = 300;

export interface MonitoringSettings {
  routerHost: string;
  retentionDays: number;
}

export interface TargetInput {
  name: string;
  kind: 'icmp' | 'dns';
  host: string;
  dnsQueryName?: string | null;
  enabled?: boolean;
}

export class MonitoringService {
  private checkInProgress = false;

  constructor(
    private monitoringRepository: MonitoringRepository,
    private prober: Prober,
    private auditService: AuditService,
    private settings: MonitoringSettings
  ) {}

  /** Keeps the router target in line with ROUTER_HOST; removing the variable disables it. */
  async syncManagedTargets(): Promise<void> {
    const existing = await this.monitoringRepository.findTargetByManagedKey(ROUTER_TARGET_KEY);
    const host = this.settings.routerHost;
    if (!host) {
      if (existing?.enabled) {
        await this.monitoringRepository.updateTarget(existing.id, { enabled: false });
      }
      return;
    }
    if (!existing) {
      await this.monitoringRepository.createTarget(
        { name: 'Router', kind: 'icmp', host, dns_query_name: null, enabled: true },
        ROUTER_TARGET_KEY
      );
    } else if (existing.host !== host || !existing.enabled) {
      await this.monitoringRepository.updateTarget(existing.id, { host, enabled: true });
    }
  }

  /** One round of checks over every enabled target; overlapping rounds are skipped. */
  async runChecks(): Promise<number> {
    if (this.checkInProgress) return 0;
    this.checkInProgress = true;
    try {
      const targets = await this.monitoringRepository.findEnabledTargets();
      await Promise.all(targets.map((target) => this.checkTarget(target)));
      return targets.length;
    } finally {
      this.checkInProgress = false;
    }
  }

  async checkNow(targetId: number) {
    const target = await this.findOrThrow(targetId);
    const result = await this.checkTarget(target);
    return toResultDto(result);
  }

  private async checkTarget(target: TargetRow): Promise<ProbeResult> {
    const result =
      target.kind === 'icmp'
        ? await this.prober.ping(target.host)
        : await this.prober.resolve(target.host, target.dns_query_name ?? 'example.com');
    await this.monitoringRepository.insertResult(target.id, result);
    if (!result.success) {
      logger.warn({ target: target.name, host: target.host, error: result.error }, 'Check failed');
    }
    return result;
  }

  async listTargets() {
    const since = new Date(Date.now() - UPTIME_WINDOW_HOURS * 3_600_000);
    const [targets, latest, lastSuccess, stats] = await Promise.all([
      this.monitoringRepository.findTargets(),
      this.monitoringRepository.findLatestResults(),
      this.monitoringRepository.findLastSuccess(),
      this.monitoringRepository.findStatsSince(since),
    ]);
    const latestById = new Map(latest.map((row) => [row.target_id, row]));
    const successById = new Map(lastSuccess.map((row) => [row.target_id, row.checked_at]));
    const statsById = new Map(stats.map((row) => [row.target_id, row]));

    return targets.map((target) => {
      const last = latestById.get(target.id);
      const window = statsById.get(target.id);
      return {
        ...toTargetDto(target),
        status: !target.enabled
          ? ('disabled' as const)
          : !last
            ? ('unknown' as const)
            : last.success
              ? (last.packet_loss_percent ?? 0) > 0
                ? ('degraded' as const)
                : ('up' as const)
              : ('down' as const),
        lastCheck: last
          ? {
              checkedAt: last.checked_at,
              success: last.success,
              latencyMs: last.latency_ms,
              packetLossPercent: last.packet_loss_percent,
              error: last.error,
            }
          : null,
        lastSuccessAt: successById.get(target.id) ?? null,
        window: window
          ? {
              hours: UPTIME_WINDOW_HOURS,
              checks: window.checks,
              uptimePercent: Math.round((window.successes / window.checks) * 10000) / 100,
              avgLatencyMs: roundOrNull(window.avg_latency_ms),
              avgPacketLossPercent: roundOrNull(window.avg_packet_loss),
            }
          : null,
      };
    });
  }

  async getSeries(targetId: number, hours: number) {
    const target = await this.findOrThrow(targetId);
    const bucketMinutes = Math.max(1, Math.ceil((hours * 60) / MAX_SERIES_POINTS));
    const since = new Date(Date.now() - hours * 3_600_000);
    const rows = await this.monitoringRepository.findSeries(targetId, since, bucketMinutes);
    return {
      target: toTargetDto(target),
      hours,
      bucketMinutes,
      points: rows.map((row) => ({
        at: row.bucket,
        checks: row.checks,
        successes: row.successes,
        avgLatencyMs: roundOrNull(row.avg_latency_ms),
        maxLatencyMs: roundOrNull(row.max_latency_ms),
        avgPacketLossPercent: roundOrNull(row.avg_packet_loss),
      })),
    };
  }

  async createTarget(input: TargetInput, adminId: number, context: RequestContext) {
    const row = await this.monitoringRepository.createTarget(toFields(input));
    await this.audit('monitoring.target_created', row, adminId, context);
    return toTargetDto(row);
  }

  async updateTarget(
    targetId: number,
    input: Partial<TargetInput>,
    adminId: number,
    context: RequestContext
  ) {
    const existing = await this.findOrThrow(targetId);
    if (existing.managed_key) throw new AppError(ErrorCode.MONITORING_TARGET_MANAGED, 409);
    const merged = toFields({
      name: existing.name,
      kind: existing.kind,
      host: existing.host,
      dnsQueryName: existing.dns_query_name,
      enabled: existing.enabled,
      ...input,
    });
    if (merged.kind === 'dns' && !merged.dns_query_name) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, 400, 'DNS targets need a query name');
    }
    const row = await this.monitoringRepository.updateTarget(targetId, merged);
    await this.audit('monitoring.target_updated', row!, adminId, context);
    return toTargetDto(row!);
  }

  async deleteTarget(targetId: number, adminId: number, context: RequestContext) {
    const existing = await this.findOrThrow(targetId);
    if (existing.managed_key) throw new AppError(ErrorCode.MONITORING_TARGET_MANAGED, 409);
    await this.monitoringRepository.deleteTarget(targetId);
    await this.audit('monitoring.target_deleted', existing, adminId, context);
  }

  deleteExpiredResults(): Promise<number> {
    const cutoff = new Date(Date.now() - this.settings.retentionDays * 86_400_000);
    return this.monitoringRepository.deleteResultsBefore(cutoff);
  }

  private async findOrThrow(targetId: number): Promise<TargetRow> {
    const target = await this.monitoringRepository.findTarget(targetId);
    if (!target) throw new NotFoundError(ErrorCode.MONITORING_TARGET_NOT_FOUND);
    return target;
  }

  private audit(
    action: 'monitoring.target_created' | 'monitoring.target_updated' | 'monitoring.target_deleted',
    target: TargetRow,
    adminId: number,
    context: RequestContext
  ) {
    return this.auditService.record({
      adminId,
      action,
      entityType: 'monitoring_target',
      entityId: target.id,
      details: { name: target.name, kind: target.kind, host: target.host },
      ipAddress: context.ipAddress,
    });
  }
}

function roundOrNull(value: number | string | null): number | null {
  return value === null ? null : Math.round(Number(value) * 100) / 100;
}

function toFields(input: TargetInput): TargetFields {
  return {
    name: input.name,
    kind: input.kind,
    host: input.host,
    dns_query_name: input.kind === 'dns' ? (input.dnsQueryName ?? null) : null,
    enabled: input.enabled ?? true,
  };
}

function toTargetDto(row: TargetRow) {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    host: row.host,
    dnsQueryName: row.dns_query_name,
    enabled: row.enabled,
    managed: row.managed_key !== null,
  };
}

function toResultDto(result: ProbeResult) {
  return {
    success: result.success,
    latencyMs: result.latencyMs,
    packetLossPercent: result.packetLossPercent,
    error: result.error,
  };
}
