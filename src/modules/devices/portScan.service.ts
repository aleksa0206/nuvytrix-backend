import { execFile } from 'node:child_process';
import { isIP } from 'node:net';
import { XMLParser } from 'fast-xml-parser';
import type { Knex } from 'knex';
import { AppError } from '../../common/errors/AppError';
import { ErrorCode } from '../../common/errors/errorCodes';
import { logger } from '../../config/logger';
import type { AlertsService } from '../alerts/alerts.service';
import type { AuditService } from '../audit/audit.service';
import type { RequestContext } from '../auth/auth.types';
import { isTargetAllowed } from '../../common/utils/ipv4';

export interface OpenPort {
  protocol: 'tcp' | 'udp';
  port: number;
  service: string | null;
  product: string | null;
  version: string | null;
}

export interface PortScanner {
  scan(ips: string[]): Promise<Map<string, OpenPort[]>>;
}

export interface PortScanSettings {
  allowedCidrs: string[];
  /** Hour of the day (server time) for the scheduled scan; -1 turns it off. */
  scheduledHour: number;
}

/** Devices tagged like this are never port-scanned (fragile printers, cameras…). */
export const NO_SCAN_TAG = 'no-scan';

const clamp = (value: unknown, max: number) =>
  value === undefined || value === null || value === '' ? null : String(value).slice(0, max);

const xml = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  isArray: (name) => ['host', 'address', 'port'].includes(name),
});

/** `nmap -oX -` with -sV: open ports per IPv4 address. */
export function parsePortScanXml(text: string): Map<string, OpenPort[]> {
  const doc = xml.parse(text) as {
    nmaprun?: {
      host?: { address?: { addr?: string; addrtype?: string }[]; ports?: { port?: NmapPort[] } }[];
    };
  };
  if (!doc.nmaprun) throw new Error('nmap XML has no <nmaprun> root');
  const result = new Map<string, OpenPort[]>();
  for (const host of doc.nmaprun.host ?? []) {
    const ip = host.address?.find((a) => a.addrtype === 'ipv4')?.addr;
    if (!ip) continue;
    result.set(
      ip,
      (host.ports?.port ?? [])
        .filter((p) => p.state?.state === 'open')
        .map((p) => ({
          protocol: p.protocol === 'udp' ? 'udp' : 'tcp',
          port: Number(p.portid),
          service: clamp(p.service?.name, 64),
          product: clamp(p.service?.product, 128),
          version: clamp(p.service?.version, 64),
        }))
    );
  }
  return result;
}

interface NmapPort {
  protocol?: string;
  portid?: string | number;
  state?: { state?: string };
  service?: { name?: string; product?: string; version?: string };
}

/**
 * Runs nmap on known IPs: the 200 most common TCP ports, light service/version detection, normal
 * timing, no scripts. nmap skips the printer ports 9100-9107 during version detection by default.
 */
export class NmapPortScanner implements PortScanner {
  constructor(private options: { nmapPath: string; privileged: boolean; timeoutSeconds: number }) {}

  scan(ips: string[]): Promise<Map<string, OpenPort[]>> {
    const args = [
      '-sV',
      '--version-light',
      '-T3',
      '--top-ports',
      '200',
      '--host-timeout',
      '180s',
      '-oX',
      '-',
    ];
    if (this.options.privileged) args.unshift('--privileged');
    return new Promise((resolve, reject) => {
      execFile(
        this.options.nmapPath,
        [...args, ...ips],
        {
          timeout: this.options.timeoutSeconds * 1000,
          killSignal: 'SIGKILL',
          maxBuffer: 20 * 1024 * 1024,
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          if (error) {
            reject(
              new Error(
                (error.killed ? 'nmap timed out' : stderr.trim() || error.message).slice(0, 900)
              )
            );
            return;
          }
          try {
            resolve(parsePortScanXml(stdout));
          } catch (err) {
            reject(err);
          }
        }
      );
    });
  }
}

/**
 * Port scans of the devices Nuvytrix knows on the allowed networks: stores open ports, and after a
 * device's first (baseline) scan reports newly opened and closed ports and changed services.
 */
export class PortScanService {
  private running: Promise<unknown> | null = null;

  constructor(
    private db: Knex,
    private scanner: PortScanner,
    private auditService: AuditService,
    private settings: PortScanSettings,
    private alerts?: AlertsService
  ) {}

  get isRunning(): boolean {
    return this.running !== null;
  }

  /** Called hourly; runs once a day at the configured hour. */
  async runScheduledIfDue(now = new Date()): Promise<void> {
    if (this.settings.scheduledHour < 0 || now.getHours() !== this.settings.scheduledHour) return;
    const today = await this.db('port_scans')
      .where('trigger', 'scheduled')
      .whereRaw("started_at >= now() - interval '20 hours'")
      .first();
    if (today || this.running) return;
    await this.scan(null, 'scheduled').catch((err) =>
      logger.warn({ err: (err as Error).message }, 'Scheduled port scan failed')
    );
  }

  /** Manual scan of one device or of every online device; audited. Returns the scan row. */
  async start(deviceId: number | null, adminId: number, context: RequestContext) {
    const scan = await this.scan(deviceId, 'manual');
    await this.auditService.record({
      adminId,
      action: 'port_scan.started',
      entityType: 'port_scan',
      entityId: scan.id,
      details: { deviceId },
      ipAddress: context.ipAddress,
    });
    return scan;
  }

  private async scan(deviceId: number | null, trigger: 'scheduled' | 'manual') {
    if (this.running) throw new AppError(ErrorCode.SCAN_ALREADY_RUNNING, 409);
    // Claimed synchronously, before the first await, so two requests cannot both start a scan.
    let release!: () => void;
    this.running = new Promise<void>((resolve) => (release = resolve));
    try {
      return await this.startScan(deviceId, trigger, release);
    } catch (err) {
      this.running = null;
      release();
      throw err;
    }
  }

  private async startScan(
    deviceId: number | null,
    trigger: 'scheduled' | 'manual',
    release: () => void
  ) {
    const devices = await this.db('devices')
      .modify((q) => {
        if (deviceId !== null) q.where('id', deviceId);
        else q.whereRaw("last_seen_at >= now() - interval '1 hour'");
      })
      .whereRaw('NOT (? = ANY(tags))', [NO_SCAN_TAG])
      .select('id', 'ip_address', 'custom_name', 'hostname', 'ports_scanned_at');
    const targets = devices.filter(
      (d: { ip_address: string }) =>
        isIP(d.ip_address) === 4 && isTargetAllowed(d.ip_address, this.settings.allowedCidrs)
    );
    if (deviceId !== null && targets.length === 0) {
      throw new AppError(ErrorCode.SCAN_TARGET_NOT_ALLOWED, 400);
    }
    const [scan] = await this.db('port_scans')
      .insert({ trigger, hosts: targets.length })
      .returning('*');
    this.running = this.run(scan.id, targets)
      .catch((err) => logger.warn({ err: (err as Error).message }, 'Port scan failed'))
      .finally(() => {
        this.running = null;
        release();
      });
    return scan;
  }

  waitForScan(): Promise<unknown> {
    return this.running ?? Promise.resolve();
  }

  private async run(
    scanId: number,
    devices: {
      id: number;
      ip_address: string;
      custom_name: string | null;
      hostname: string | null;
      ports_scanned_at: Date | null;
    }[]
  ) {
    try {
      const results = devices.length
        ? await this.scanner.scan(devices.map((d) => d.ip_address))
        : new Map();
      let changes = 0;
      for (const device of devices) {
        const ports = results.get(device.ip_address);
        if (!ports) continue; // host did not answer this time: nothing is concluded
        changes += await this.apply(device, ports).catch((err) => {
          logger.warn(
            { err: (err as Error).message, ip: device.ip_address },
            'Port scan result not stored'
          );
          return 0;
        });
      }
      await this.db('port_scans')
        .where({ id: scanId })
        .update({ status: 'completed', changes, finished_at: this.db.fn.now() });
    } catch (err) {
      await this.db('port_scans')
        .where({ id: scanId })
        .update({
          status: 'failed',
          error: (err as Error).message.slice(0, 1000),
          finished_at: this.db.fn.now(),
        });
      throw err;
    }
  }

  /** Stores one device's open ports and reports the differences; returns how many changed. */
  private async apply(
    device: {
      id: number;
      custom_name: string | null;
      hostname: string | null;
      ip_address: string;
      ports_scanned_at: Date | null;
    },
    ports: OpenPort[]
  ): Promise<number> {
    const baseline = device.ports_scanned_at === null;
    const label = device.custom_name ?? device.hostname ?? device.ip_address;
    const known = await this.db('device_ports')
      .where({ device_id: device.id })
      .whereNull('closed_at');
    const key = (p: { protocol: string; port: number }) => `${p.protocol}/${p.port}`;
    const knownByKey = new Map(known.map((p) => [key(p), p]));
    const seen = new Set<string>();
    let changes = 0;
    const report = async (kind: string, title: string, details: Record<string, unknown>) => {
      changes++;
      await this.db('device_events').insert({
        device_id: device.id,
        kind,
        old_value: clamp(details.from, 255),
        new_value: clamp(details.to, 255),
        details: JSON.stringify(details),
      });
      if (!baseline)
        await this.alerts?.raise(
          kind as 'port_opened' | 'port_closed' | 'service_changed',
          kind === 'port_opened' ? 'warning' : 'info',
          title,
          details
        );
    };

    for (const p of ports) {
      seen.add(key(p));
      const service = [p.service, p.product, p.version].filter(Boolean).join(' ') || null;
      const existing = knownByKey.get(key(p));
      if (!existing) {
        await this.db('device_ports').insert({ device_id: device.id, ...p });
        if (!baseline) {
          await report(
            'port_opened',
            `New open port on ${label}: ${p.port}/${p.protocol} ${service ?? ''}`.trim(),
            {
              ip: device.ip_address,
              to: `${p.port}/${p.protocol} ${service ?? ''}`.trim(),
            }
          );
        }
        continue;
      }
      const before =
        [existing.service, existing.product, existing.version].filter(Boolean).join(' ') || null;
      await this.db('device_ports').where({ id: existing.id }).update({
        service: p.service,
        product: p.product,
        version: p.version,
        last_seen_at: this.db.fn.now(),
      });
      if (before !== service && p.version && existing.version) {
        await report(
          'service_changed',
          `Service changed on ${label} port ${p.port}: ${before} → ${service}`,
          {
            ip: device.ip_address,
            from: before,
            to: service,
          }
        );
      }
    }
    for (const p of known) {
      if (seen.has(key(p))) continue;
      await this.db('device_ports').where({ id: p.id }).update({ closed_at: this.db.fn.now() });
      await report('port_closed', `Port closed on ${label}: ${p.port}/${p.protocol}`, {
        ip: device.ip_address,
        from: `${p.port}/${p.protocol}`,
      });
    }
    await this.db('devices')
      .where({ id: device.id })
      .update({ ports_scanned_at: this.db.fn.now() });
    return changes;
  }

  async devicePorts(deviceId: number) {
    const rows = await this.db('device_ports')
      .where({ device_id: deviceId })
      .orderByRaw('closed_at IS NOT NULL, port');
    return rows.map((r) => ({
      protocol: r.protocol,
      port: r.port,
      service: r.service,
      product: r.product,
      version: r.version,
      firstSeenAt: r.first_seen_at,
      lastSeenAt: r.last_seen_at,
      closedAt: r.closed_at,
    }));
  }

  /** Scans left 'running' by a restart of the API never finish; mark them failed. */
  failInterrupted(): Promise<number> {
    return this.db('port_scans')
      .where({ status: 'running' })
      .update({
        status: 'failed',
        error: 'Interrupted by a restart',
        finished_at: this.db.fn.now(),
      });
  }

  latestScans(limit = 10) {
    return this.db('port_scans').orderBy('id', 'desc').limit(limit);
  }
}
