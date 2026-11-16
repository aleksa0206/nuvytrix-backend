import { logger } from '../../config/logger';
import type { AlertsService } from '../alerts/alerts.service';

export interface DockerMonitorSettings {
  /** The read-only Docker API proxy (deploy/docker-proxy.conf); empty disables monitoring. */
  baseUrl: string;
}

export interface ContainerState {
  id: string;
  name: string;
  project: string | null;
  service: string | null;
  image: string;
  state: string;
  health: string | null;
  restartCount: number;
  startedAt: string | null;
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
  private known = new Map<
    string,
    { running: boolean; healthy: boolean; startedAt: string | null }
  >();

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

  private async inspect(item: DockerListItem): Promise<ContainerState> {
    const id = item.Id;
    const name = (item.Names?.[0] ?? id).replace(/^\//, '');
    const detail = await this.get<DockerInspect>(`/containers/${id}/json`);
    const running = detail.State?.Running === true;
    const stats = running
      ? await this.get<DockerStats>(`/containers/${id}/stats?stream=false&one-shot=true`).catch(
          () => null
        )
      : null;
    const startedAt =
      detail.State?.StartedAt && !detail.State.StartedAt.startsWith('0001')
        ? detail.State.StartedAt
        : null;
    return {
      id: id.slice(0, 12),
      name,
      project: item.Labels?.['com.docker.compose.project'] ?? null,
      service: item.Labels?.['com.docker.compose.service'] ?? null,
      image: item.Image,
      state: detail.State?.Status ?? item.State,
      health: detail.State?.Health?.Status ?? null,
      restartCount: detail.RestartCount ?? 0,
      startedAt,
      uptimeSeconds:
        running && startedAt ? Math.round((Date.now() - Date.parse(startedAt)) / 1000) : null,
      cpuPercent: stats ? this.cpuPercent(id, stats) : null,
      memoryBytes: stats ? memoryUsed(stats) : null,
      memoryLimitBytes: stats?.memory_stats?.limit ?? null,
      exitCode: running ? null : (detail.State?.ExitCode ?? null),
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
        startedAt: c.startedAt,
      };
      const before = this.known.get(c.name);
      this.known.set(c.name, now);
      if (!before) continue;
      if (before.running && !now.running) {
        await this.alerts.raise(
          'container_down',
          'error',
          `Container ${c.name} stopped (exit code ${c.exitCode ?? '?'})`,
          { container: c.name, state: c.state }
        );
      } else if (!before.running && now.running) {
        await this.alerts.raise('container_up', 'info', `Container ${c.name} is running again`, {
          container: c.name,
        });
      } else if (now.running && before.startedAt && now.startedAt !== before.startedAt) {
        await this.alerts.raise('container_restarted', 'warning', `Container ${c.name} restarted`, {
          container: c.name,
          restartCount: c.restartCount,
        });
      }
      if (before.healthy && !now.healthy) {
        await this.alerts.raise(
          'container_unhealthy',
          'warning',
          `Container ${c.name} is unhealthy`,
          {
            container: c.name,
          }
        );
      }
    }
  }

  private async get<T>(path: string): Promise<T> {
    const res = await fetch(`${this.settings.baseUrl}${path}`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`Docker API ${res.status} for ${path.split('?')[0]}`);
    return (await res.json()) as T;
  }
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
  Labels?: Record<string, string>;
}

interface DockerInspect {
  RestartCount?: number;
  State?: {
    Status?: string;
    Running?: boolean;
    StartedAt?: string;
    ExitCode?: number;
    Health?: { Status?: string };
  };
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
