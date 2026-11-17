import { hostSchema, isHttpUrl } from './monitoring.schema';
import { isIP } from 'node:net';
import { AppError, NotFoundError } from '../../common/errors/AppError';
import { ErrorCode } from '../../common/errors/errorCodes';
import { logger } from '../../config/logger';
import type { RequestContext } from '../auth/auth.types';
import type { AlertSettingsService } from '../alerts/alertSettings.service';
import type { AlertsService } from '../alerts/alerts.service';
import type { AuditService } from '../audit/audit.service';
import type { MonitoringRepository, TargetFields, TargetRow } from './monitoring.repository';
import type { Prober, ProbeResult } from './probes';

export const ROUTER_TARGET_KEY = 'router';
export const INTERNET_TARGET_KEY = 'internet';
/** Cloudflare's resolver answers ping reliably; if it fails while the router answers, the internet is down. */
const INTERNET_HOST = '1.1.1.1';
/** Consecutive failed checks before a target counts as down (one lost check is not an outage). */
const DOWN_AFTER_FAILURES = 2;
/** Certificate alert when an HTTPS target's certificate ends within this many days. */
const CERT_WARNING_DAYS = 14;
/** Consecutive checks that must all exceed a quality threshold before it alerts. */
const QUALITY_CHECKS = 3;
const UPTIME_WINDOW_HOURS = 24;
const MAX_SERIES_POINTS = 300;

export interface MonitoringSettings {
  routerHost: string;
  retentionDays: number;
}

export interface TargetInput {
  name: string;
  kind: 'icmp' | 'dns' | 'http';
  host: string;
  dnsQueryName?: string | null;
  enabled?: boolean;
}

export class MonitoringService {
  private checkInProgress = false;
  /** Consecutive failures per target (the open outage itself is kept in the alerts table). */
  private failures = new Map<number, number>();
  private reportedCertificates = new Set<number>();

  constructor(
    private monitoringRepository: MonitoringRepository,
    private prober: Prober,
    private auditService: AuditService,
    private settings: MonitoringSettings,
    private alerts?: AlertsService,
    private thresholds?: AlertSettingsService
  ) {}

  /** Keeps the built-in targets in line: the router (ROUTER_HOST, disabled without it) and the internet. */
  async syncManagedTargets(): Promise<void> {
    await this.syncManagedTarget(ROUTER_TARGET_KEY, 'Router', this.settings.routerHost);
    await this.syncManagedTarget(INTERNET_TARGET_KEY, 'Internet', INTERNET_HOST);
  }

  private async syncManagedTarget(key: string, name: string, host: string): Promise<void> {
    const existing = await this.monitoringRepository.findTargetByManagedKey(key);
    if (!host) {
      if (existing?.enabled) {
        await this.monitoringRepository.updateTarget(existing.id, { enabled: false });
      }
      return;
    }
    if (!existing) {
      await this.monitoringRepository.createTarget(
        { name, kind: 'icmp', host, dns_query_name: null, enabled: true },
        key
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
        : target.kind === 'http'
          ? await this.prober.http(target.host)
          : await this.prober.resolve(target.host, target.dns_query_name ?? 'example.com');
    await this.monitoringRepository.insertResult(target.id, result);
    if (!result.success) {
      logger.warn({ target: target.name, host: target.host, error: result.error }, 'Check failed');
    }
    await this.trackOutage(target, result);
    await this.trackCertificate(target, result);
    await this.trackQuality(target);
    return result;
  }

  /** One alert when an HTTPS certificate is about to expire; again only after it was renewed. */
  private async trackCertificate(target: TargetRow, result: ProbeResult): Promise<void> {
    if (!this.alerts || !result.certExpiresAt) return;
    const days = (result.certExpiresAt.getTime() - Date.now()) / 86_400_000;
    if (days >= CERT_WARNING_DAYS) {
      if (this.reportedCertificates.delete(target.id))
        await this.alerts.resolve(`cert:${target.id}`);
      return;
    }
    if (this.reportedCertificates.has(target.id)) return;
    this.reportedCertificates.add(target.id);
    await this.alerts.raise(
      'certificate_expiring',
      days < 3 ? 'error' : 'warning',
      `${target.name}: certificate expires in ${Math.max(0, Math.floor(days))} days`,
      { targetId: target.id, url: target.host, expiresAt: result.certExpiresAt },
      `cert:${target.id}`
    );
  }

  /**
   * Outages from stored checks: runs of at least two failed checks in a row (the same rule as the
   * down alert), newest first. An outage still going on has no end.
   */
  async getOutages(targetId: number, days: number) {
    await this.findOrThrow(targetId);
    const checks = await this.monitoringRepository.findChecks(
      targetId,
      new Date(Date.now() - days * 86_400_000)
    );
    const outages: { start: Date; end: Date | null; checks: number; error: string | null }[] = [];
    let run: (typeof checks)[number][] = [];
    const close = (end: Date | null) => {
      if (run.length >= DOWN_AFTER_FAILURES) {
        outages.push({ start: run[0]!.checked_at, end, checks: run.length, error: run[0]!.error });
      }
      run = [];
    };
    for (const check of checks) {
      if (check.success) close(check.checked_at);
      else run.push(check);
    }
    close(null);
    return {
      days,
      outages: outages.reverse().map((o) => ({
        ...o,
        durationSeconds: Math.round(((o.end ?? new Date()).getTime() - o.start.getTime()) / 1000),
      })),
    };
  }

  /**
   * Raises one alert when a target goes down (after repeated failures) and one when it is back.
   * The open alert is keyed in the database, so a restart neither repeats nor loses the outage.
   */
  private async trackOutage(target: TargetRow, result: ProbeResult): Promise<void> {
    if (!this.alerts) return;
    const subject = target.managed_key === INTERNET_TARGET_KEY ? 'Internet' : target.name;
    const key = `target:${target.id}`;
    if (result.success) {
      this.failures.delete(target.id);
      if (await this.alerts.resolve(key)) {
        await this.alerts.raise('target_up', 'info', `${subject} is back`, {
          targetId: target.id,
          host: target.host,
        });
      }
      return;
    }
    const failures = (this.failures.get(target.id) ?? 0) + 1;
    this.failures.set(target.id, failures);
    if (failures >= DOWN_AFTER_FAILURES) {
      await this.alerts.raise(
        'target_down',
        'error',
        target.managed_key === INTERNET_TARGET_KEY
          ? 'Internet is down'
          : `${target.name} is not answering`,
        { targetId: target.id, host: target.host, error: result.error },
        key
      );
    }
  }

  /**
   * Ping quality over the last checks: latency, packet loss and jitter above the thresholds on
   * every one of the last three checks raise one alert each, resolved once they are back below.
   */
  private async trackQuality(target: TargetRow): Promise<void> {
    if (!this.alerts || !this.thresholds || target.kind !== 'icmp') return;
    const t = this.thresholds.current;
    const recent = await this.monitoringRepository.findRecentChecks(target.id, QUALITY_CHECKS);
    if (recent.length < QUALITY_CHECKS || recent.some((r) => !r.success)) return;
    const checks: {
      name: string;
      over: (r: (typeof recent)[number]) => boolean;
      unit: string;
      value: (r: (typeof recent)[number]) => number | null;
      limit: number;
    }[] = [
      {
        name: 'latency',
        limit: t.latencyMs,
        unit: 'ms',
        value: (r) => r.latency_ms,
        over: (r) => (r.latency_ms ?? 0) > t.latencyMs,
      },
      {
        name: 'packet loss',
        limit: t.packetLossPercent,
        unit: '%',
        value: (r) => r.packet_loss_percent,
        over: (r) => (r.packet_loss_percent ?? 0) > t.packetLossPercent,
      },
      {
        name: 'jitter',
        limit: t.jitterMs,
        unit: 'ms',
        value: (r) => r.jitter_ms,
        over: (r) => (r.jitter_ms ?? 0) > t.jitterMs,
      },
    ];
    for (const c of checks) {
      const key = `quality:${target.id}:${c.name}`;
      if (recent.every(c.over)) {
        await this.alerts.raise(
          'high_latency',
          'warning',
          `${target.name}: ${c.name} ${c.value(recent[0]!)} ${c.unit} (limit ${c.limit} ${c.unit})`,
          { targetId: target.id, metric: c.name, value: c.value(recent[0]!) },
          key
        );
      } else if (!recent.some(c.over)) {
        await this.alerts.resolve(key);
      }
    }
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
              jitterMs: last.jitter_ms,
              httpStatus: last.http_status,
              certExpiresAt: last.cert_expires_at,
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
        avgJitterMs: roundOrNull(row.avg_jitter_ms),
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
    if (
      merged.kind === 'http' ? !isHttpUrl(merged.host) : !hostSchema.safeParse(merged.host).success
    ) {
      throw new AppError(
        ErrorCode.VALIDATION_ERROR,
        400,
        'Ping and DNS targets need an IP address or hostname; HTTP targets an http(s) URL'
      );
    }
    if (merged.kind === 'dns' && (!merged.dns_query_name || isIP(merged.host) === 0)) {
      throw new AppError(
        ErrorCode.VALIDATION_ERROR,
        400,
        'DNS targets need a resolver IP address and a query name'
      );
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
    managedKey: row.managed_key,
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
