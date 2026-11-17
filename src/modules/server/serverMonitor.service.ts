import { readFile, readdir, statfs } from 'node:fs/promises';
import type { Knex } from 'knex';
import { logger } from '../../config/logger';
import { DEFAULT_THRESHOLDS, type AlertSettingsService } from '../alerts/alertSettings.service';
import type { AlertsService } from '../alerts/alerts.service';

/** Where host data is read; the API shares the host's /proc and /sys (host network, no virtualization of these). */
export interface ServerMonitorSettings {
  procRoot: string;
  sysRoot: string;
  /** Mount points to report, as seen inside the container, with the name shown to the user. */
  disks: { path: string; name: string }[];
  retentionDays: number;
}

export interface DiskUsage {
  name: string;
  totalBytes: number;
  usedBytes: number;
  percent: number;
}

export interface ServerSample {
  cpuPercent: number | null;
  load1: number | null;
  loadCores: number | null;
  memoryPercent: number | null;
  memoryAvailableBytes: number | null;
  swapPercent: number | null;
  uptimeSeconds: number | null;
  temperatureC: number | null;
  onBattery: boolean | null;
  batteryPercent: number | null;
  disks: DiskUsage[];
  netErrors: number | null;
  db: {
    up: boolean;
    connections: number | null;
    sizeBytes: number | null;
    longestQuerySeconds: number | null;
    error: string | null;
  };
}

// Interfaces that are not physical links of this server.
const VIRTUAL_NIC = /^(lo|veth|br-|docker|virbr|tailscale|wg|tun|tap)/;

const read = (path: string) => readFile(path, 'utf8').catch(() => null);
const round = (value: number, digits = 1) => Math.round(value * 10 ** digits) / 10 ** digits;

/**
 * The Ubuntu server's health, read from /proc and /sys without privileges, plus PostgreSQL health
 * from the app's own connection. Sampled every minute; alerts on battery, disk, memory, heat and
 * database outages.
 */
export class ServerMonitorService {
  private previousCpu: { idle: number; total: number } | null = null;
  private latest: (ServerSample & { sampledAt: Date }) | null = null;

  constructor(
    private db: Knex,
    private settings: ServerMonitorSettings,
    private alerts?: AlertsService,
    private thresholds?: AlertSettingsService
  ) {}

  get last() {
    return this.latest;
  }

  async sample(): Promise<ServerSample> {
    const [cpu, memory, load, uptime, temperature, power, disks, netErrors, db] = await Promise.all(
      [
        this.cpuPercent(),
        this.memory(),
        this.load(),
        read(`${this.settings.procRoot}/uptime`),
        this.temperature(),
        this.power(),
        this.disks(),
        this.netErrors(),
        this.database(),
      ]
    );
    const sample: ServerSample = {
      cpuPercent: cpu,
      load1: load?.load1 ?? null,
      loadCores: load?.cores ?? null,
      memoryPercent: memory?.percent ?? null,
      memoryAvailableBytes: memory?.availableBytes ?? null,
      swapPercent: memory?.swapPercent ?? null,
      uptimeSeconds: uptime ? Math.round(Number(uptime.split(' ')[0])) : null,
      temperatureC: temperature,
      onBattery: power.onBattery,
      batteryPercent: power.batteryPercent,
      disks,
      netErrors,
      db,
    };
    this.latest = { ...sample, sampledAt: new Date() };
    await this.db('server_samples')
      .insert({
        cpu_percent: sample.cpuPercent,
        load1: sample.load1,
        memory_percent: sample.memoryPercent,
        swap_percent: sample.swapPercent,
        temperature_c: sample.temperatureC,
        on_battery: sample.onBattery,
        battery_percent: sample.batteryPercent,
        disks: JSON.stringify(sample.disks),
        net_errors: sample.netErrors,
        db_up: db.up,
        db_connections: db.connections,
        db_size_bytes: db.sizeBytes,
        db_longest_query_seconds: db.longestQuerySeconds,
      })
      .catch((err) => logger.error({ err }, 'Could not store server sample'));
    await this.checkAlerts(sample);
    return sample;
  }

  async history(hours: number) {
    const rows = await this.db('server_samples')
      .whereRaw('sampled_at >= now() - make_interval(hours => ?)', [hours])
      .orderBy('sampled_at')
      .select(
        'sampled_at',
        'cpu_percent',
        'load1',
        'memory_percent',
        'temperature_c',
        'on_battery',
        'db_connections'
      );
    return {
      hours,
      points: rows.map((r) => ({
        at: r.sampled_at,
        cpuPercent: r.cpu_percent,
        load1: r.load1,
        memoryPercent: r.memory_percent,
        temperatureC: r.temperature_c,
        onBattery: r.on_battery,
        dbConnections: r.db_connections,
      })),
    };
  }

  deleteExpired(): Promise<number> {
    return this.db('server_samples')
      .whereRaw('sampled_at < now() - make_interval(days => ?)', [this.settings.retentionDays])
      .delete();
  }

  private async cpuPercent(): Promise<number | null> {
    const stat = await read(`${this.settings.procRoot}/stat`);
    const fields = stat?.split('\n')[0]?.trim().split(/\s+/).slice(1).map(Number);
    if (!fields || fields.length < 4) return null;
    const idle = fields[3]! + (fields[4] ?? 0);
    const total = fields.reduce((a, b) => a + b, 0);
    const previous = this.previousCpu;
    this.previousCpu = { idle, total };
    if (!previous || total <= previous.total) return null;
    return round(100 * (1 - (idle - previous.idle) / (total - previous.total)));
  }

  private async memory() {
    const text = await read(`${this.settings.procRoot}/meminfo`);
    if (!text) return null;
    const kb = (key: string) =>
      Number(new RegExp(`^${key}:\\s+(\\d+)`, 'm').exec(text)?.[1] ?? NaN);
    const total = kb('MemTotal');
    const available = kb('MemAvailable');
    const swapTotal = kb('SwapTotal');
    const swapFree = kb('SwapFree');
    if (!total || Number.isNaN(available)) return null;
    return {
      percent: round(100 * (1 - available / total)),
      availableBytes: available * 1024,
      swapPercent: swapTotal > 0 ? round(100 * (1 - swapFree / swapTotal)) : null,
    };
  }

  private async load() {
    const [text, stat] = await Promise.all([
      read(`${this.settings.procRoot}/loadavg`),
      read(`${this.settings.procRoot}/stat`),
    ]);
    if (!text) return null;
    return {
      load1: Number(text.split(' ')[0]),
      cores: stat ? (stat.match(/^cpu\d+ /gm)?.length ?? null) : null,
    };
  }

  /** Highest CPU package/core temperature from hwmon (coretemp), falling back to any sensor. */
  private async temperature(): Promise<number | null> {
    const base = `${this.settings.sysRoot}/class/hwmon`;
    const names = await readdir(base).catch(() => [] as string[]);
    const readings: { chip: string; celsius: number }[] = [];
    for (const name of names) {
      const chip = (await read(`${base}/${name}/name`))?.trim() ?? '';
      const files = await readdir(`${base}/${name}`).catch(() => [] as string[]);
      for (const file of files.filter((f) => /^temp\d+_input$/.test(f))) {
        const value = Number(await read(`${base}/${name}/${file}`));
        if (value > 0) readings.push({ chip, celsius: value / 1000 });
      }
    }
    const preferred = readings.filter((r) => r.chip === 'coretemp');
    const pool = preferred.length ? preferred : readings;
    return pool.length ? round(Math.max(...pool.map((r) => r.celsius))) : null;
  }

  /** The server is a laptop: mains adapter and battery from power_supply. */
  private async power() {
    const base = `${this.settings.sysRoot}/class/power_supply`;
    const names = await readdir(base).catch(() => [] as string[]);
    let onBattery: boolean | null = null;
    let batteryPercent: number | null = null;
    for (const name of names) {
      const type = (await read(`${base}/${name}/type`))?.trim();
      if (type === 'Mains') onBattery = (await read(`${base}/${name}/online`))?.trim() === '0';
      if (type === 'Battery') {
        const capacity = Number(await read(`${base}/${name}/capacity`));
        if (!Number.isNaN(capacity)) batteryPercent = capacity;
      }
    }
    return { onBattery, batteryPercent };
  }

  private async disks(): Promise<DiskUsage[]> {
    const out: DiskUsage[] = [];
    for (const disk of this.settings.disks) {
      try {
        const s = await statfs(disk.path);
        const total = s.blocks * s.bsize;
        // Like df: used / (used + available to users); blocks reserved for root are left out.
        const used = (s.blocks - s.bfree) * s.bsize;
        const usable = used + s.bavail * s.bsize;
        if (total > 0) {
          out.push({
            name: disk.name,
            totalBytes: total,
            usedBytes: used,
            percent: round((100 * used) / usable),
          });
        }
      } catch {
        // Not mounted in this container: left out rather than reported as empty.
      }
    }
    return out;
  }

  /** Receive and transmit errors on physical interfaces (not drops, which are mostly ignored multicast). */
  private async netErrors(): Promise<number | null> {
    const text = await read(`${this.settings.procRoot}/net/dev`);
    if (!text) return null;
    let total = 0;
    for (const line of text.split('\n').slice(2)) {
      const [name, rest] = line.split(':');
      if (!rest || VIRTUAL_NIC.test(name!.trim())) continue;
      const f = rest.trim().split(/\s+/).map(Number);
      total += (f[2] ?? 0) + (f[10] ?? 0);
    }
    return total;
  }

  private async database(): Promise<ServerSample['db']> {
    try {
      const row = await this.db
        .raw(
          `SELECT (SELECT count(*) FROM pg_stat_activity WHERE datname = current_database())::int AS connections,
                  pg_database_size(current_database())::bigint AS size,
                  (SELECT COALESCE(EXTRACT(EPOCH FROM max(now() - query_start)), 0)
                     FROM pg_stat_activity
                    WHERE state = 'active' AND pid <> pg_backend_pid())::float AS longest`
        )
        .then((r) => r.rows[0]);
      return {
        up: true,
        connections: row.connections,
        sizeBytes: Number(row.size),
        longestQuerySeconds: round(row.longest),
        error: null,
      };
    } catch (err) {
      return {
        up: false,
        connections: null,
        sizeBytes: null,
        longestQuerySeconds: null,
        error: (err as Error).message.slice(0, 200),
      };
    }
  }

  /**
   * One alert when a condition starts and one when it ends; the open alert is keyed in the
   * database, so a restart neither repeats it nor forgets to report the end.
   */
  private async checkAlerts(s: ServerSample): Promise<void> {
    if (!this.alerts) return;
    const alerts = this.alerts;
    const t = this.thresholds?.current ?? DEFAULT_THRESHOLDS;
    const track = async (
      key: string,
      on: boolean,
      start: () => Promise<void>,
      end?: () => Promise<void>
    ) => {
      if (on) await start();
      else if ((await alerts.resolve(key)) && end) await end();
    };
    await track(
      'server:battery',
      s.onBattery === true,
      () =>
        alerts.raise(
          'server_power',
          'error',
          `Server is on battery (${s.batteryPercent ?? '?'} %): power outage?`,
          {},
          'server:battery'
        ),
      () => alerts.raise('server_power', 'info', 'Server is back on mains power')
    );
    for (const d of s.disks) {
      const key = `server:disk:${d.name}`;
      await track(key, d.percent >= t.diskPercent, () =>
        alerts.raise('server_disk', 'warning', `Disk ${d.name} is ${d.percent} % full`, {}, key)
      );
    }
    await track('server:memory', (s.memoryPercent ?? 0) >= t.memoryPercent, () =>
      alerts.raise(
        'server_memory',
        'warning',
        `Server memory is ${s.memoryPercent} % used`,
        {},
        'server:memory'
      )
    );
    await track('server:heat', (s.temperatureC ?? 0) >= t.temperatureC, () =>
      alerts.raise(
        'server_temperature',
        'warning',
        `Server CPU is at ${s.temperatureC} °C`,
        {},
        'server:heat'
      )
    );
    await track(
      'server:db',
      !s.db.up,
      () =>
        alerts.raise(
          'database_down',
          'error',
          'Database is not answering',
          { error: s.db.error },
          'server:db'
        ),
      () => alerts.raise('database_down', 'info', 'Database is answering again')
    );
  }
}
