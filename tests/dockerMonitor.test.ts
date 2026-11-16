import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { container, resetContainer } from '../src/container';
import { parseUptime } from '../src/modules/docker/dockerMonitor.service';
import { closeDatabase, prepareDatabase, signedInAgent } from './helpers/testDb';

/** Stand-in for the Docker API behind the proxy: one site container whose state the test changes. */
const docker = {
  running: true,
  health: 'healthy',
  uptime: 'Up 3 hours',
  cpu: 1_000,
  system: 100_000,
  requests: [] as string[],
};

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    docker.requests.push(`${req.method} ${req.url}`);
    const json = (body: unknown) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(body));
    };
    if (req.url === '/containers/json?all=1') {
      return json([
        {
          Id: 'abcdef1234567890',
          Names: ['/remly-web-1'],
          Image: 'remly-web',
          State: docker.running ? 'running' : 'exited',
          Status: docker.running
            ? `${docker.uptime} (${docker.health})`
            : 'Exited (137) 1 minute ago',
          Labels: { 'com.docker.compose.project': 'remly', 'com.docker.compose.service': 'web' },
        },
      ]);
    }
    if (req.url?.startsWith('/containers/abcdef1234567890/stats')) {
      return json({
        cpu_stats: {
          cpu_usage: { total_usage: docker.cpu },
          system_cpu_usage: docker.system,
          online_cpus: 4,
        },
        memory_stats: {
          usage: 50_000_000,
          limit: 8_000_000_000,
          stats: { inactive_file: 10_000_000 },
        },
      });
    }
    res.statusCode = 403;
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.close();
  resetContainer();
  await closeDatabase();
});

describe('parseUptime', () => {
  it('turns Docker uptime words into seconds', () => {
    expect(parseUptime('Up 2 hours (healthy)')).toBe(7200);
    expect(parseUptime('Up About a minute')).toBe(60);
    expect(parseUptime('Up About an hour')).toBe(3600);
    expect(parseUptime('Up Less than a second')).toBe(0);
    expect(parseUptime('Up 9 days')).toBe(9 * 86_400);
    expect(parseUptime('Exited (0) 2 days ago')).toBeNull();
  });
});

describe('docker monitoring', () => {
  beforeEach(async () => {
    await prepareDatabase();
    Object.assign(docker, {
      running: true,
      health: 'healthy',
      uptime: 'Up 3 hours',
      requests: [],
    });
    resetContainer({ dockerProxyUrl: baseUrl });
  });

  it('lists containers with state, health, restarts, CPU and memory, using only GET reads', async () => {
    const service = container.dockerMonitorService;
    await service.poll();
    docker.cpu += 2_000; // 2 % of 100 000 system ticks, times 4 CPUs = 8 %
    docker.system += 100_000;
    await service.poll();

    const agent = await signedInAgent();
    const { body } = await agent.get('/api/docker/containers');
    expect(body.containers).toEqual([
      expect.objectContaining({
        name: 'remly-web-1',
        project: 'remly',
        service: 'web',
        state: 'running',
        health: 'healthy',
        uptimeSeconds: 3 * 3600,
        cpuPercent: 8,
        memoryBytes: 40_000_000,
      }),
    ]);
    expect(docker.requests.every((r) => r.startsWith('GET '))).toBe(true);
    expect(docker.requests.some((r) => /containers\/[a-f0-9]+\/json/.test(r))).toBe(false);
  });

  it('alerts when a container stops, comes back, restarts or turns unhealthy', async () => {
    const service = container.dockerMonitorService;
    await service.poll();
    docker.running = false;
    await service.poll();
    docker.running = true;
    await service.poll();
    docker.uptime = 'Up 10 seconds';
    await service.poll();
    docker.health = 'unhealthy';
    await service.poll();

    const titles = (await container.alertsService.list()).alerts.map((a) => a.title).reverse();
    expect(titles).toEqual([
      'Container remly-web-1 stopped (exit code 137)',
      'Container remly-web-1 is running again',
      'Container remly-web-1 restarted',
      'Container remly-web-1 is unhealthy',
    ]);
  });

  it('reports a proxy error without throwing away the last good list', async () => {
    const service = container.dockerMonitorService;
    await service.poll();
    resetContainer({ dockerProxyUrl: 'http://127.0.0.1:1' });
    await expect(container.dockerMonitorService.poll()).rejects.toThrow();
    expect(container.dockerMonitorService.status.error).not.toBeNull();
  });
});
