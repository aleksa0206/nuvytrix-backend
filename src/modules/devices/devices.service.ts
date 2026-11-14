import { AppError, ConflictError, NotFoundError } from '../../common/errors/AppError';
import { ErrorCode } from '../../common/errors/errorCodes';
import { isTargetAllowed, parseCidr } from '../../common/utils/ipv4';
import { paginate, type Pagination } from '../../common/utils/pagination';
import { logger } from '../../config/logger';
import type { RequestContext } from '../auth/auth.types';
import type { AuditService } from '../audit/audit.service';
import type { DevicesRepository } from './devices.repository';
import { NEW_DEVICE_HOURS } from './devices.repository';
import type { DeviceListQuery, DeviceRow, DeviceType, ScanRow } from './devices.types';
import type { HostDiscoverer } from './nmapRunner';

export interface DiscoverySettings {
  allowedCidrs: string[];
  onlineWindowMinutes: number;
}

export interface DeviceChanges {
  customName?: string | null;
  deviceType?: DeviceType | null;
  notes?: string | null;
}

const OBSERVATION_HISTORY_LIMIT = 50;

export class DevicesService {
  // ponytail: in-process lock, correct only while one API instance runs scans
  private activeScan: Promise<void> | null = null;

  constructor(
    private devicesRepository: DevicesRepository,
    private discoverer: HostDiscoverer,
    private auditService: AuditService,
    private settings: DiscoverySettings
  ) {}

  /** Normalizes a target to network/prefix form and rejects anything outside the allowed networks. */
  resolveTarget(target: string | undefined): string {
    const requested = target ?? this.settings.allowedCidrs[0]!;
    const cidr = parseCidr(requested.includes('/') ? requested : `${requested}/32`);
    if (!cidr || !isTargetAllowed(requested, this.settings.allowedCidrs)) {
      throw new AppError(ErrorCode.SCAN_TARGET_NOT_ALLOWED, 400);
    }
    const network = [24, 16, 8, 0].map((shift) => (cidr.network >>> shift) & 255).join('.');
    return `${network}/${cidr.prefix}`;
  }

  async startScan(
    target: string | undefined,
    adminId: number | null,
    context?: RequestContext
  ): Promise<ScanRow> {
    const resolvedTarget = this.resolveTarget(target);
    if (this.activeScan) throw new ConflictError(ErrorCode.SCAN_ALREADY_RUNNING);

    const scan = await this.devicesRepository.createScan(resolvedTarget, adminId);
    if (adminId !== null) {
      await this.auditService.record({
        adminId,
        action: 'discovery.scan_started',
        entityType: 'discovery_scan',
        entityId: scan.id,
        details: { target: resolvedTarget },
        ipAddress: context?.ipAddress,
      });
    }

    this.activeScan = this.runScan(scan).finally(() => {
      this.activeScan = null;
    });
    return scan;
  }

  /** Resolves when the scan in progress (if any) has finished; used by tests and shutdown. */
  async waitForActiveScan(): Promise<void> {
    await this.activeScan;
  }

  private async runScan(scan: ScanRow): Promise<void> {
    const startedAt = Date.now();
    try {
      const hosts = await this.discoverer.discover(scan.target);
      const newDevices = await this.devicesRepository.recordScanResults(scan.id, hosts);
      await this.devicesRepository.completeScan(scan.id, hosts.length, newDevices);
      logger.info(
        {
          scanId: scan.id,
          target: scan.target,
          hostsUp: hosts.length,
          newDevices,
          ms: Date.now() - startedAt,
        },
        'Discovery scan completed'
      );
    } catch (err) {
      logger.error({ err, scanId: scan.id, target: scan.target }, 'Discovery scan failed');
      await this.devicesRepository
        .failScan(scan.id, (err as Error).message)
        .catch((updateError) =>
          logger.error({ err: updateError }, 'Could not mark scan as failed')
        );
    }
  }

  failInterruptedScans(): Promise<number> {
    return this.devicesRepository.failInterruptedScans();
  }

  async getScan(scanId: number) {
    const scan = await this.devicesRepository.findScan(scanId);
    if (!scan) throw new NotFoundError(ErrorCode.SCAN_NOT_FOUND);
    return toScanDto(scan);
  }

  async listScans(pagination: Pagination) {
    const { rows, total } = await this.devicesRepository.findScans(
      pagination.page,
      pagination.pageSize
    );
    return paginate(rows.map(toScanDto), total, pagination);
  }

  async listDevices(query: DeviceListQuery) {
    const { rows, total } = await this.devicesRepository.findDevices(
      query,
      this.settings.onlineWindowMinutes
    );
    return paginate(
      rows.map((row) => this.toDeviceDto(row)),
      total,
      query
    );
  }

  async getDevice(deviceId: number) {
    const device = await this.devicesRepository.findDevice(deviceId);
    if (!device) throw new NotFoundError(ErrorCode.DEVICE_NOT_FOUND);
    const observations = await this.devicesRepository.findObservations(
      deviceId,
      OBSERVATION_HISTORY_LIMIT
    );
    return {
      ...this.toDeviceDto(device),
      observations: observations.map((observation) => ({
        scanId: observation.scan_id,
        ipAddress: observation.ip_address,
        hostname: observation.hostname,
        observedAt: observation.observed_at,
      })),
    };
  }

  async updateDevice(
    deviceId: number,
    changes: DeviceChanges,
    adminId: number,
    context: RequestContext
  ) {
    const updated = await this.devicesRepository.updateDevice(deviceId, {
      ...(changes.customName !== undefined && { custom_name: changes.customName || null }),
      ...(changes.deviceType !== undefined && { device_type: changes.deviceType }),
      ...(changes.notes !== undefined && { notes: changes.notes || null }),
    });
    if (!updated) throw new NotFoundError(ErrorCode.DEVICE_NOT_FOUND);
    await this.auditService.record({
      adminId,
      action: 'device.updated',
      entityType: 'device',
      entityId: deviceId,
      details: { fields: Object.keys(changes) },
      ipAddress: context.ipAddress,
    });
    return this.toDeviceDto(updated);
  }

  async getSummary() {
    const [counts, latestScan] = await Promise.all([
      this.devicesRepository.countDevices(this.settings.onlineWindowMinutes),
      this.devicesRepository.findLatestScan(),
    ]);
    return { ...counts, latestScan: latestScan ? toScanDto(latestScan) : null };
  }

  private toDeviceDto(row: DeviceRow) {
    const now = Date.now();
    const online = row.last_seen_at.getTime() >= now - this.settings.onlineWindowMinutes * 60_000;
    return {
      id: row.id,
      ipAddress: row.ip_address,
      macAddress: row.mac_address,
      hostname: row.hostname,
      vendor: row.vendor,
      customName: row.custom_name,
      deviceType: row.device_type,
      notes: row.notes,
      status: online ? ('online' as const) : ('offline' as const),
      isNew: row.first_seen_at.getTime() >= now - NEW_DEVICE_HOURS * 3_600_000,
      firstSeenAt: row.first_seen_at,
      lastSeenAt: row.last_seen_at,
    };
  }
}

function toScanDto(scan: ScanRow) {
  return {
    id: scan.id,
    target: scan.target,
    status: scan.status,
    startedAt: scan.started_at,
    finishedAt: scan.finished_at,
    hostsUp: scan.hosts_up,
    newDevices: scan.new_devices,
    error: scan.error,
    scheduled: scan.triggered_by === null,
  };
}
