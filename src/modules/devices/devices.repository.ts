import type { Knex } from 'knex';
import { offsetOf } from '../../common/utils/pagination';
import { likePattern } from '../../common/utils/sql';
import type { DiscoveredHost } from './nmapXmlParser';
import type { DeviceListQuery, DeviceRow, ObservationRow, ScanRow } from './devices.types';

export const NEW_DEVICE_HOURS = 24;

const SORT_COLUMNS: Record<DeviceListQuery['sort'], string> = {
  last_seen_at: 'last_seen_at',
  first_seen_at: 'first_seen_at',
  ip_address: 'ip_address',
  name: 'display_name',
};

export class DevicesRepository {
  /** @param ownAddresses the server's own IPs: the only hosts nmap reports without a MAC. */
  constructor(
    private db: Knex,
    private ownAddresses: string[] = []
  ) {}

  async createScan(target: string, triggeredBy: number | null): Promise<ScanRow> {
    const [scan] = await this.db('discovery_scans')
      .insert({ target, status: 'running', triggered_by: triggeredBy })
      .returning('*');
    return scan;
  }

  async completeScan(scanId: number, hostsUp: number, newDevices: number): Promise<void> {
    await this.db('discovery_scans').where({ id: scanId }).update({
      status: 'completed',
      finished_at: this.db.fn.now(),
      hosts_up: hostsUp,
      new_devices: newDevices,
    });
  }

  async failScan(scanId: number, error: string): Promise<void> {
    await this.db('discovery_scans')
      .where({ id: scanId })
      .update({ status: 'failed', finished_at: this.db.fn.now(), error: error.slice(0, 1000) });
  }

  /** Scans left "running" by a crash or restart would otherwise block the UI forever. */
  async failInterruptedScans(): Promise<number> {
    return this.db('discovery_scans')
      .where({ status: 'running' })
      .update({ status: 'failed', finished_at: this.db.fn.now(), error: 'Interrupted by restart' });
  }

  findScan(scanId: number): Promise<ScanRow | undefined> {
    return this.db<ScanRow>('discovery_scans').where({ id: scanId }).first();
  }

  findLatestScan(): Promise<ScanRow | undefined> {
    return this.db<ScanRow>('discovery_scans').orderBy('id', 'desc').first();
  }

  async findScans(page: number, pageSize: number): Promise<{ rows: ScanRow[]; total: number }> {
    const [rows, countRow] = await Promise.all([
      this.db<ScanRow>('discovery_scans')
        .orderBy('id', 'desc')
        .limit(pageSize)
        .offset(offsetOf({ page, pageSize })),
      this.db('discovery_scans').count<{ count: number }[]>('* as count').first(),
    ]);
    return { rows, total: countRow?.count ?? 0 };
  }

  /**
   * Records every host from one scan atomically, with an event for each IP or hostname change;
   * returns the hosts seen for the first time.
   */
  async recordScanResults(
    scanId: number,
    hosts: DiscoveredHost[]
  ): Promise<(DiscoveredHost & { id: number })[]> {
    return this.db.transaction(async (trx) => {
      const newDevices: (DiscoveredHost & { id: number })[] = [];
      const event = (deviceId: number, kind: string, from: string, to: string) =>
        trx('device_events').insert({
          device_id: deviceId,
          kind,
          old_value: from,
          new_value: to,
          details: JSON.stringify({ source: 'scan', scanId }),
        });
      for (const host of hosts) {
        const existing = await (host.macAddress
          ? trx<DeviceRow>('devices').where({ mac_address: host.macAddress }).first()
          : this.ownAddresses.includes(host.ipAddress)
            ? // The scanning server itself: its record may carry the MAC the router reported.
              trx<DeviceRow>('devices')
                .where({ ip_address: host.ipAddress })
                .orderByRaw('mac_address IS NULL DESC, last_seen_at DESC')
                .first()
            : trx<DeviceRow>('devices')
                .whereNull('mac_address')
                .andWhere({ ip_address: host.ipAddress })
                .first());

        let deviceId: number;
        if (existing) {
          deviceId = existing.id;
          if (existing.mac_address && host.ipAddress !== existing.ip_address) {
            await event(deviceId, 'ip_changed', existing.ip_address, host.ipAddress);
          }
          if (host.hostname && existing.hostname && host.hostname !== existing.hostname) {
            await event(deviceId, 'hostname_changed', existing.hostname, host.hostname);
          }
          await trx('devices')
            .where({ id: existing.id })
            .update({
              ip_address: host.ipAddress,
              hostname: host.hostname ?? existing.hostname,
              vendor: host.vendor ?? existing.vendor,
              last_seen_at: trx.fn.now(),
              last_scan_id: scanId,
              updated_at: trx.fn.now(),
            });
        } else {
          newDevices.push({ ...host, id: 0 });
          const [created] = await trx('devices')
            .insert({
              mac_address: host.macAddress,
              ip_address: host.ipAddress,
              hostname: host.hostname,
              vendor: host.vendor,
              first_seen_at: trx.fn.now(),
              last_seen_at: trx.fn.now(),
              last_scan_id: scanId,
            })
            .returning('id');
          deviceId = created.id;
          newDevices[newDevices.length - 1]!.id = deviceId;
        }

        await trx('device_observations').insert({
          device_id: deviceId,
          scan_id: scanId,
          ip_address: host.ipAddress,
          hostname: host.hostname,
        });
      }
      return newDevices;
    });
  }

  async findDevices(
    query: DeviceListQuery,
    onlineWindowMinutes: number
  ): Promise<{ rows: DeviceRow[]; total: number }> {
    const base = this.db('devices').modify((builder) => {
      if (query.search) {
        const pattern = likePattern(query.search);
        builder.where((where) =>
          where
            .whereILike('custom_name', pattern)
            .orWhereILike('hostname', pattern)
            .orWhereILike('vendor', pattern)
            .orWhereRaw('host(ip_address) LIKE ?', [pattern])
            .orWhereRaw('mac_address::text ILIKE ?', [pattern])
        );
      }
      if (query.status === 'online') {
        builder.whereRaw('last_seen_at >= now() - make_interval(mins => ?)', [onlineWindowMinutes]);
      } else if (query.status === 'offline') {
        builder.whereRaw('last_seen_at < now() - make_interval(mins => ?)', [onlineWindowMinutes]);
      } else if (query.status === 'new') {
        builder.whereRaw('first_seen_at >= now() - make_interval(hours => ?)', [NEW_DEVICE_HOURS]);
      }
      if (query.trust === 'trusted') builder.where('trusted', true);
      else if (query.trust === 'untrusted') builder.where('trusted', false);
      else if (query.trust === 'unreviewed') builder.whereNull('trusted');
      if (query.tag) builder.whereRaw('? = ANY(tags)', [query.tag]);
    });

    const [rows, countRow] = await Promise.all([
      base
        .clone()
        .select(
          '*',
          this.db.raw('COALESCE(custom_name, hostname, host(ip_address)) AS display_name')
        )
        .orderBy(SORT_COLUMNS[query.sort], query.order)
        .orderBy('id', 'asc')
        .limit(query.pageSize)
        .offset(offsetOf(query)),
      base.clone().count<{ count: number }[]>('* as count').first(),
    ]);
    return { rows, total: countRow?.count ?? 0 };
  }

  findByMacAddresses(
    macs: string[]
  ): Promise<Pick<DeviceRow, 'id' | 'mac_address' | 'custom_name'>[]> {
    if (macs.length === 0) return Promise.resolve([]);
    return this.db('devices')
      .whereIn('mac_address', macs)
      .select('id', 'mac_address', 'custom_name');
  }

  findDevice(deviceId: number): Promise<DeviceRow | undefined> {
    return this.db<DeviceRow>('devices').where({ id: deviceId }).first();
  }

  findObservations(deviceId: number, limit: number): Promise<ObservationRow[]> {
    return this.db('device_observations')
      .where('device_id', deviceId)
      .orderBy('observed_at', 'desc')
      .limit(limit);
  }

  async updateDevice(
    deviceId: number,
    changes: Partial<Pick<DeviceRow, 'custom_name' | 'device_type' | 'notes' | 'tags' | 'trusted'>>
  ): Promise<DeviceRow | undefined> {
    const [updated] = await this.db('devices')
      .where({ id: deviceId })
      .update({ ...changes, updated_at: this.db.fn.now() })
      .returning('*');
    return updated;
  }

  async countDevices(onlineWindowMinutes: number) {
    const row = await this.db('devices')
      .select(
        this.db.raw('COUNT(*)::int AS total'),
        this.db.raw(
          'COUNT(*) FILTER (WHERE last_seen_at >= now() - make_interval(mins => ?))::int AS online',
          [onlineWindowMinutes]
        ),
        this.db.raw(
          'COUNT(*) FILTER (WHERE first_seen_at >= now() - make_interval(hours => ?))::int AS new',
          [NEW_DEVICE_HOURS]
        )
      )
      .first();
    return { total: row.total as number, online: row.online as number, new: row.new as number };
  }
}
