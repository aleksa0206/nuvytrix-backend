import { logger } from '../../config/logger';
import type { AlertsService } from '../alerts/alerts.service';

export interface DockerMonitorSettings {
  /** The read-only Docker API proxy (deploy/docker-proxy.conf); empty disables monitoring. */
  baseUrl: string;
  /** Shared secret the proxy checks in `x-proxy-token`. */
  token?: string;
}

export interface ContainerState {
  id: string;
  name: string;
  project: string | null;
  service: string | null;
  image: string;
  state: string;
  health: string | null;
  /** Docker's status text, e.g. "Up 2 hours (healthy)" or "Exited (137) 5 minutes ago". */
  status: string;
  /** Approximate: Docker reports uptime in words ("Up 2 hours"). */
  uptimeSeconds: number | null;
  cpuPercent: number | null;
  memoryBytes: number | null;
  memoryLimitBytes: number | null;
  exitCode: number | null;
}

interface CpuReading {
  container: number;
  system: number;
}

const PARALLEL = 4;
const TIMEOUT_MS = 10_000;

/**
 * Containers on the server (Nuvytrix and the hosted sites) through the read-only Docker API proxy:
 * state, health, restarts, uptime, CPU and memory. Alerts when a container stops, becomes
 * unhealthy or restarts. Nothing here can change a container.
 */
export class DockerMonitorService {
  private latest: { checkedAt: Date; containers: ContainerState[] } | null = null;
  private lastError: { at: Date; message: string } | null = null;
  private previousCpu = new Map<string, CpuReading>();
  /** Last state per container name, to alert on changes; ponytail: in memory, reset on restart. */
  private known = new Map<string, { running: boolean; healthy: boolean; uptime: number | null }>();

  constructor(
    private settings: DockerMonitorSettings,
    private alerts?: AlertsService
  ) {}

  get enabled(): boolean {
    return this.settings.baseUrl !== '';
  }

  get status() {
    return {
      enabled: this.enabled,
      checkedAt: this.latest?.checkedAt ?? null,
      error: this.lastError,
      containers: this.latest?.containers ?? [],
    };
  }

  async poll(): Promise<ContainerState[]> {
    if (!this.enabled) return [];
    try {
      const list = await this.get<DockerListItem[]>('/containers/json?all=1');
      const containers: ContainerState[] = [];
      for (let i = 0; i < list.length; i += PARALLEL) {
        containers.push(
          ...(await Promise.all(list.slice(i, i + PARALLEL).map((c) => this.inspect(c))))
        );
      }
      containers.sort((a, b) => a.name.localeCompare(b.name));
      this.latest = { checkedAt: new Date(), containers };
      this.lastError = null;
      await this.checkAlerts(containers);
      return containers;
    } catch (err) {
      this.lastError = { at: new Date(), message: (err as Error).message.slice(0, 300) };
      logger.warn({ err: (err as Error).message }, 'Docker poll failed');
      throw err;
    }
  }

  /**
   * Built from the container list only: the per-container inspect call is not allowed by the
   * proxy, because its output includes every container's environment variables (secrets).
   */
  private async inspect(item: DockerListItem): Promise<ContainerState> {
    const id = item.Id;
    const name = (item.Names?.[0] ?? id).replace(/^\//, '');
    const running = item.State === 'running';
    const status = item.Status ?? '';
    const stats = running
      ? await this.get<DockerStats>(`/containers/${id}/stats?stream=false&one-shot=true`).catch(
          () => null
        )
      : null;
    const health = /\((healthy|unhealthy|health: starting)\)/.exec(status)?.[1] ?? null;
    const exit = /^Exited \((-?\d+)\)/.exec(status);
    return {
      id: id.slice(0, 12),
      name,
      project: item.Labels?.['com.docker.compose.project'] ?? null,
      service: item.Labels?.['com.docker.compose.service'] ?? null,
      image: item.Image,
      state: item.State,
      health: health === 'health: starting' ? 'starting' : health,
      status,
      uptimeSeconds: running ? parseUptime(status) : null,
      cpuPercent: stats ? this.cpuPercent(id, stats) : null,
      memoryBytes: stats ? memoryUsed(stats) : null,
      memoryLimitBytes: stats?.memory_stats?.limit ?? null,
      exitCode: exit ? Number(exit[1]) : null,
    };
  }

  /** CPU share of the whole machine between two polls (one-shot stats carry no previous reading). */
  private cpuPercent(id: string, stats: DockerStats): number | null {
    const container = stats.cpu_stats?.cpu_usage?.total_usage;
    const system = stats.cpu_stats?.system_cpu_usage;
    const cpus = stats.cpu_stats?.online_cpus ?? 1;
    if (container === undefined || system === undefined) return null;
    const previous = this.previousCpu.get(id);
    this.previousCpu.set(id, { container, system });
    if (!previous || system <= previous.system || container < previous.container) return null;
    return (
      Math.round(((container - previous.container) / (system - previous.system)) * cpus * 1000) / 10
    );
  }

  private async checkAlerts(containers: ContainerState[]): Promise<void> {
    if (!this.alerts) return;
    for (const c of containers) {
      const now = {
        running: c.state === 'running',
        healthy: c.health !== 'unhealthy',
        uptime: c.uptimeSeconds,
      };
      const before = this.known.get(c.name);
      this.known.set(c.name, now);
      if (!before) continue;
      if (before.running && !now.running) {
        await this.alerts.raise(
          'container_down',
          'error',
          `Container ${c.name} stopped (exit code ${c.exitCode ?? '?'})`,
          { container: c.name, state: c.state },
          `container:${c.name}`
        );
      } else if (!before.running && now.running) {
        await this.alerts.resolve(`container:${c.name}`);
        await this.alerts.raise('container_up', 'info', `Container ${c.name} is running again`, {
          container: c.name,
        });
      } else if (
        now.running &&
        before.uptime !== null &&
        now.uptime !== null &&
        now.uptime < before.uptime
      ) {
        // Uptime in words only grows while a container runs; a smaller value means it restarted.
        await this.alerts.raise('container_restarted', 'warning', `Container ${c.name} restarted`, {
          container: c.name,
        });
      }
      if (before.healthy && !now.healthy) {
        await this.alerts.raise(
          'container_unhealthy',
          'warning',
          `Container ${c.name} is unhealthy`,
          { container: c.name },
          `container-health:${c.name}`
        );
      } else if (!before.healthy && now.healthy) {
        await this.alerts.resolve(`container-health:${c.name}`);
      }
    }
  }

  private async get<T>(path: string): Promise<T> {
    const res = await fetch(`${this.settings.baseUrl}${path}`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { 'x-proxy-token': this.settings.token ?? '' },
    });
    if (!res.ok) throw new Error(`Docker API ${res.status} for ${path.split('?')[0]}`);
    return (await res.json()) as T;
  }
}

const UNIT_SECONDS: Record<string, number> = {
  second: 1,
  minute: 60,
  hour: 3600,
  day: 86_400,
  week: 604_800,
  month: 2_592_000,
  year: 31_536_000,
};

/** "Up 2 hours (healthy)", "Up About a minute", "Up Less than a second" → seconds. */
export function parseUptime(status: string): number | null {
  const m = /^Up (Less than a|About an?|\d+) (second|minute|hour|day|week|month|year)s?/.exec(
    status
  );
  if (!m) return null;
  const count = /^\d+$/.test(m[1]!) ? Number(m[1]) : m[1] === 'Less than a' ? 0 : 1;
  return count * UNIT_SECONDS[m[2]!]!;
}

/** Memory in use as `docker stats` shows it: usage without the reclaimable file cache. */
function memoryUsed(stats: DockerStats): number | null {
  const m = stats.memory_stats;
  if (!m?.usage) return null;
  const cache = m.stats?.inactive_file ?? m.stats?.total_inactive_file ?? 0;
  return m.usage - cache;
}

interface DockerListItem {
  Id: string;
  Names?: string[];
  Image: string;
  State: string;
  Status?: string;
  Labels?: Record<string, string>;
}

interface DockerStats {
  cpu_stats?: {
    cpu_usage?: { total_usage?: number };
    system_cpu_usage?: number;
    online_cpus?: number;
  };
  memory_stats?: {
    usage?: number;
    limit?: number;
    stats?: { inactive_file?: number; total_inactive_file?: number };
  };
}
