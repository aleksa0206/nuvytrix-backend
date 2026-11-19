import { networkInterfaces } from 'node:os';
import type { Knex } from 'knex';
import type { DnsService } from '../dns/dns.service';
import type { DockerMonitorService } from '../docker/dockerMonitor.service';
import type { MonitoringService } from '../monitoring/monitoring.service';
import type { RouterService } from '../router/router.service';
import type { SshMonitorService } from '../security/sshMonitor.service';
import type { BackupMonitorService } from '../server/backupMonitor.service';
import type { ServerMonitorService } from '../server/serverMonitor.service';

export type IntegrationState = 'ok' | 'warning' | 'error' | 'off';

export interface IntegrationHealth {
  name: string;
  state: IntegrationState;
  /** When it last worked, if known. */
  lastSuccessAt: Date | null;
  detail: string;
  error: string | null;
}

/** How old the last good reading may be, in multiples of its interval, before it counts as stale. */
const STALE_FACTOR = 3;

/**
 * One health line per integration, from what each part already records; a failing part never
 * hides the others (each is read in its own try).
 */
export class IntegrationsService {
  constructor(
    private db: Knex,
    private deps: {
      router: RouterService;
      dns: DnsService;
      docker: DockerMonitorService;
      ssh: SshMonitorService;
      backups: BackupMonitorService;
      server: ServerMonitorService;
      monitoring: MonitoringService;
      routerPollSeconds: number;
      discoveryIntervalMinutes: number;
    }
  ) {}

  async list(): Promise<IntegrationHealth[]> {
    const checks: [string, () => Promise<Omit<IntegrationHealth, 'name'>>][] = [
      ['Huawei router', () => this.router()],
      ['Network discovery', () => this.discovery()],
      ['Port scans', () => this.portScans()],
      ['Monitoring checks', () => this.monitoring()],
      ['AdGuard Home (DNS)', () => this.dns()],
      ['AdGuard Home (DHCP)', () => this.dhcp()],
      ['Docker', async () => this.docker()],
      ['PostgreSQL', async () => this.postgres()],
      ['SSH log', async () => this.sshLog()],
      ['Backups', async () => this.backups()],
      ['Tailscale', async () => this.tailscale()],
    ];
    return Promise.all(
      checks.map(async ([name, check]) => {
        try {
          return { name, ...(await check()) };
        } catch (err) {
          return {
            name,
            state: 'error' as const,
            lastSuccessAt: null,
            detail: 'Check failed',
            error: (err as Error).message.slice(0, 200),
          };
        }
      })
    );
  }

  private async router() {
    const s = this.deps.router.getStatus();
    if (!s.configured)
      return {
        state: 'off' as const,
        lastSuccessAt: null,
        detail: 'ROUTER_HOST not set',
        error: null,
      };
    const at = s.capturedAt ? new Date(s.capturedAt) : null;
    const stale =
      !at || Date.now() - at.getTime() > this.deps.routerPollSeconds * 1000 * STALE_FACTOR;
    return {
      state: stale ? ('error' as const) : s.errors.length ? ('warning' as const) : ('ok' as const),
      lastSuccessAt: at,
      detail: `read every ${this.deps.routerPollSeconds / 60} min`,
      error: stale
        ? 'No recent reading'
        : s.errors.map((e) => `${e.section}: ${e.message}`).join('; ') || null,
    };
  }

  private async discovery() {
    const last = await this.db('discovery_scans').orderBy('id', 'desc').first();
    const lastOk = await this.db('discovery_scans')
      .where({ status: 'completed' })
      .orderBy('id', 'desc')
      .first();
    const interval = this.deps.discoveryIntervalMinutes;
    const stale =
      !lastOk ||
      (interval > 0 &&
        Date.now() - new Date(lastOk.finished_at).getTime() > interval * 60_000 * STALE_FACTOR);
    return {
      state: !last
        ? ('off' as const)
        : last.status === 'failed'
          ? ('error' as const)
          : stale
            ? ('warning' as const)
            : ('ok' as const),
      lastSuccessAt: lastOk?.finished_at ?? null,
      detail: interval > 0 ? `nmap every ${interval} min` : 'manual only',
      error: last?.status === 'failed' ? last.error : null,
    };
  }

  private async portScans() {
    const last = await this.db('port_scans').orderBy('id', 'desc').first();
    const lastOk = await this.db('port_scans')
      .where({ status: 'completed' })
      .orderBy('id', 'desc')
      .first();
    return {
      state: !last
        ? ('off' as const)
        : last.status === 'failed'
          ? ('error' as const)
          : ('ok' as const),
      lastSuccessAt: lastOk?.finished_at ?? null,
      detail: 'nightly, top 200 TCP ports',
      error: last?.status === 'failed' ? last.error : null,
    };
  }

  private async monitoring() {
    const targets = (await this.deps.monitoring.listTargets()).filter((t) => t.enabled);
    const down = targets.filter((t) => t.status === 'down');
    const last =
      targets
        .map((t) => t.lastCheck?.checkedAt)
        .filter(Boolean)
        .sort()
        .pop() ?? null;
    return {
      state:
        targets.length === 0
          ? ('off' as const)
          : down.length
            ? ('warning' as const)
            : ('ok' as const),
      lastSuccessAt: last ? new Date(last) : null,
      detail: `${targets.length - down.length}/${targets.length} targets up`,
      error: down.length ? `Down: ${down.map((t) => t.name).join(', ')}` : null,
    };
  }

  private async dns() {
    const s = await this.deps.dns.getStatus();
    if (!s.configured)
      return {
        state: 'off' as const,
        lastSuccessAt: null,
        detail: 'ADGUARD_URL not set',
        error: null,
      };
    if (!s.reachable)
      return {
        state: 'error' as const,
        lastSuccessAt: null,
        detail: 'not reachable',
        error: s.error,
      };
    return {
      state: s.protectionEnabled ? ('ok' as const) : ('warning' as const),
      lastSuccessAt: new Date(),
      detail: `${s.version}${s.protectionEnabled ? '' : ', protection off'}`,
      error: null,
    };
  }

  private async dhcp() {
    if (!this.deps.dns.configured)
      return {
        state: 'off' as const,
        lastSuccessAt: null,
        detail: 'ADGUARD_URL not set',
        error: null,
      };
    const d = await this.deps.dns.dhcp();
    return {
      state: d.enabled ? ('ok' as const) : ('error' as const),
      lastSuccessAt: new Date(),
      detail: d.enabled
        ? `${d.leases.length} leases, ${d.staticLeases.length} static, ${d.rangeStart}–${d.rangeEnd}`
        : 'DHCP server off',
      error: d.enabled ? null : 'Devices that join the network get no address',
    };
  }

  private docker() {
    const s = this.deps.docker.status;
    if (!s.enabled)
      return {
        state: 'off' as const,
        lastSuccessAt: null,
        detail: 'DOCKER_PROXY_URL not set',
        error: null,
      };
    // Containers that stopped within the last day; one stopped for days or weeks (a VM image kept
    // off, a finished migrate job) was stopped on purpose.
    const recentlyStopped =
      /^Exited \(\d+\) (\d+|About an?|Less than a) (second|minute|hour)s? ago/;
    const down = s.containers.filter(
      (c) => c.state !== 'running' && recentlyStopped.test(c.status)
    );
    return {
      state: s.error ? ('error' as const) : down.length ? ('warning' as const) : ('ok' as const),
      lastSuccessAt: s.checkedAt,
      detail: `${s.containers.length} containers, read-only proxy`,
      error:
        s.error?.message ??
        (down.length ? `Not running: ${down.map((c) => c.name).join(', ')}` : null),
    };
  }

  private postgres() {
    const last = this.deps.server.last;
    if (!last)
      return {
        state: 'warning' as const,
        lastSuccessAt: null,
        detail: 'no sample yet',
        error: null,
      };
    return {
      state: last.db.up ? ('ok' as const) : ('error' as const),
      lastSuccessAt: last.db.up ? last.sampledAt : null,
      detail: last.db.up ? `${last.db.connections} connections` : 'not answering',
      error: last.db.error,
    };
  }

  private sshLog() {
    const h = this.deps.ssh.health;
    if (!h.enabled)
      return {
        state: 'off' as const,
        lastSuccessAt: null,
        detail: 'SSH_AUTH_LOG not set',
        error: null,
      };
    return {
      state: h.error ? ('error' as const) : h.lastRun ? ('ok' as const) : ('warning' as const),
      lastSuccessAt: h.lastRun,
      detail: 'auth.log, read-only, every minute',
      error: h.error?.message ?? null,
    };
  }

  private backups() {
    const s = this.deps.backups.status;
    if (!s.enabled)
      return {
        state: 'off' as const,
        lastSuccessAt: null,
        detail: 'BACKUP_DIR not set',
        error: null,
      };
    const bad = s.projects.filter((p) => p.state !== 'ok');
    return {
      state: s.error ? ('error' as const) : bad.length ? ('warning' as const) : ('ok' as const),
      lastSuccessAt: s.checkedAt,
      detail: `${s.projects.length - bad.length}/${s.projects.length} projects backed up`,
      error: s.error ?? (bad.length ? bad.map((p) => `${p.project}: ${p.state}`).join(', ') : null),
    };
  }

  /** The API shares the host network: a tailscale0 interface with a 100.64/10 address means it is up. */
  private tailscale() {
    const ts = (networkInterfaces().tailscale0 ?? []).find((i) => i.family === 'IPv4');
    return {
      state: ts ? ('ok' as const) : ('warning' as const),
      lastSuccessAt: ts ? new Date() : null,
      detail: ts ? `interface up, ${ts.address}` : 'tailscale0 interface not found',
      error: null,
    };
  }
}
