import type { Knex } from 'knex';
import { logger } from '../../config/logger';
import type { AlertsService } from '../alerts/alerts.service';
import type { DhcpReservation, RouterDevice } from '../router/huaweiParser';

export type DeviceEventKind = 'ip_changed' | 'hostname_changed' | 'mac_changed' | 'ip_conflict';

/** A device seen for the first time, by either source. */
export interface NewDevice {
  id: number;
  ipAddress: string;
  macAddress: string | null;
  hostname: string | null;
  vendor: string | null;
}

/** An IP answering from a new MAC within this window counts as a replaced (or spoofed) device. */
const REPLACED_WITHIN_HOURS = 24;
const EVENT_RETENTION_DAYS = 180;
const PRESENCE_RETENTION_DAYS = 30;
const clamp = (value: string | null | undefined, max = 255) => (value ? value.slice(0, max) : null);

/**
 * Device identity over time: changes of IP, hostname and MAC, IP conflicts, DHCP details and
 * presence from the router's device list, and the alerts for them.
 */
export class DeviceIntelService {
  /** IP conflicts already reported. ponytail: in memory; a restart reports a live conflict again. */
  private reportedConflicts = new Set<string>();

  constructor(
    private db: Knex,
    private alerts?: AlertsService
  ) {}

  async recordEvent(
    db: Knex | Knex.Transaction,
    deviceId: number | null,
    kind: DeviceEventKind,
    oldValue: string | null,
    newValue: string | null,
    details: Record<string, unknown> = {}
  ): Promise<void> {
    await db('device_events').insert({
      device_id: deviceId,
      kind,
      old_value: clamp(oldValue),
      new_value: clamp(newValue),
      details: JSON.stringify(details),
    });
  }

  /** Alerts for a new device, and checks whether it took over the IP of another recent device. */
  async announceNew(device: NewDevice): Promise<void> {
    const label = device.hostname ?? device.vendor ?? device.ipAddress;
    await this.alerts?.raise('new_device', 'warning', `New device on the network: ${label}`, {
      deviceId: device.id,
      ipAddress: device.ipAddress,
      macAddress: device.macAddress,
      hostname: device.hostname,
      vendor: device.vendor,
    });
    if (!device.macAddress) return;
    const previous = await this.db('devices')
      .where('ip_address', device.ipAddress)
      .whereNot('id', device.id)
      .whereNotNull('mac_address')
      .whereNot('mac_address', device.macAddress)
      .whereRaw('last_seen_at >= now() - make_interval(hours => ?)', [REPLACED_WITHIN_HOURS])
      .orderBy('last_seen_at', 'desc')
      .first();
    if (!previous) return;
    await this.recordEvent(
      this.db,
      device.id,
      'mac_changed',
      String(previous.mac_address),
      device.macAddress,
      { ipAddress: device.ipAddress, previousDeviceId: previous.id }
    );
    await this.alerts?.raise(
      'mac_changed',
      'warning',
      `${device.ipAddress} now answers from a different device`,
      {
        ipAddress: device.ipAddress,
        previousMac: previous.mac_address,
        previousName: previous.custom_name ?? previous.hostname,
        newMac: device.macAddress,
      }
    );
  }

  /**
   * Applies one read of the router's device list: updates known devices (IP, hostname, DHCP
   * details, reservation, last seen), adds devices nmap has not found, stores presence and reports
   * IP conflicts. Returns the devices seen for the first time.
   */
  async syncFromRouter(
    routerDevices: RouterDevice[],
    reservations: DhcpReservation[] | null
  ): Promise<NewDevice[]> {
    const reservedByMac = new Map(
      (reservations ?? []).filter((r) => r.enabled).map((r) => [r.mac, r.ip])
    );
    const macs = routerDevices.map((d) => d.macAddress);
    const known = macs.length
      ? await this.db('devices').whereIn('mac_address', macs).select('*')
      : [];
    const byMac = new Map(known.map((row) => [String(row.mac_address), row]));
    const created: NewDevice[] = [];
    const now = Date.now();

    await this.db.transaction(async (trx) => {
      for (const d of routerDevices) {
        const hostname = clamp(d.hostName);
        const common = {
          address_source: clamp(d.addressSource?.toLowerCase(), 16),
          lease_expires_at:
            d.leaseRemainingSeconds !== null && d.leaseRemainingSeconds > 0
              ? new Date(now + d.leaseRemainingSeconds * 1000)
              : null,
          connection: d.connection,
          reserved_ip:
            reservations === null ? undefined : (reservedByMac.get(d.macAddress) ?? null),
        };
        let existing = byMac.get(d.macAddress);
        if (!existing && d.ipAddress) {
          // nmap never sees the scanning server's own MAC: adopt the MAC-less record on this IP.
          const adopted = await trx('devices')
            .whereNull('mac_address')
            .where('ip_address', d.ipAddress)
            .update({ mac_address: d.macAddress })
            .returning('*');
          existing = adopted[0];
        }
        let deviceId: number;
        if (!existing) {
          if (!d.online || !d.ipAddress) continue;
          const [row] = await trx('devices')
            .insert({
              mac_address: d.macAddress,
              ip_address: d.ipAddress,
              hostname,
              first_seen_at: trx.fn.now(),
              last_seen_at: trx.fn.now(),
              ...common,
            })
            .returning('id');
          deviceId = row.id;
          created.push({
            id: deviceId,
            ipAddress: d.ipAddress,
            macAddress: d.macAddress,
            hostname,
            vendor: null,
          });
        } else {
          deviceId = existing.id;
          const changes: Record<string, unknown> = { ...common, updated_at: trx.fn.now() };
          if (d.online) {
            changes.last_seen_at = trx.fn.now();
            if (d.ipAddress && d.ipAddress !== existing.ip_address) {
              changes.ip_address = d.ipAddress;
              await this.recordEvent(
                trx,
                deviceId,
                'ip_changed',
                existing.ip_address,
                d.ipAddress,
                {
                  source: 'router',
                }
              );
            }
          }
          // The router's DHCP name and nmap's reverse-DNS name differ (aleksa vs aleksa.local);
          // hostname changes are tracked from scans only, the router just fills a missing name.
          if (hostname && !existing.hostname) changes.hostname = hostname;
          await trx('devices').where({ id: deviceId }).update(changes);
        }
        await trx('device_presence').insert({ device_id: deviceId, online: d.online });
      }
    });

    await this.checkConflicts(routerDevices.filter((d) => d.online && d.ipAddress));
    for (const device of created) await this.announceNew(device);
    return created;
  }

  /** Two online devices with the same IP in the router's list. */
  private async checkConflicts(online: RouterDevice[]): Promise<void> {
    const byIp = new Map<string, string[]>();
    for (const d of online)
      byIp.set(d.ipAddress!, [...(byIp.get(d.ipAddress!) ?? []), d.macAddress]);
    for (const [ip, macs] of byIp) {
      if (macs.length < 2) continue;
      const key = `${ip}|${[...macs].sort().join(',')}`;
      if (this.reportedConflicts.has(key)) continue;
      this.reportedConflicts.add(key);
      await this.recordEvent(this.db, null, 'ip_conflict', null, ip, { macs });
      await this.alerts?.raise(
        'ip_conflict',
        'error',
        `IP conflict: ${ip} is used by ${macs.length} devices`,
        {
          ipAddress: ip,
          macs,
        }
      );
    }
  }

  findEvents(deviceId: number, limit = 50) {
    return this.db('device_events').where('device_id', deviceId).orderBy('id', 'desc').limit(limit);
  }

  /** Share of router reads that saw the device online, per hour. */
  async presence(deviceId: number, days: number) {
    const rows = await this.db('device_presence')
      .where('device_id', deviceId)
      .whereRaw('sampled_at >= now() - make_interval(days => ?)', [days])
      .select(
        this.db.raw("date_trunc('hour', sampled_at) AS hour"),
        this.db.raw('AVG(online::int)::float AS online'),
        this.db.raw('COUNT(*)::int AS samples')
      )
      .groupByRaw('1')
      .orderByRaw('1');
    return rows.map((r: { hour: Date; online: number; samples: number }) => ({
      at: r.hour,
      onlineShare: Math.round(r.online * 100) / 100,
      samples: r.samples,
    }));
  }

  async deleteExpired(): Promise<void> {
    try {
      await this.db('device_events')
        .whereRaw('created_at < now() - make_interval(days => ?)', [EVENT_RETENTION_DAYS])
        .delete();
      await this.db('device_presence')
        .whereRaw('sampled_at < now() - make_interval(days => ?)', [PRESENCE_RETENTION_DAYS])
        .delete();
    } catch (err) {
      logger.error({ err }, 'Device history cleanup failed');
    }
  }
}
