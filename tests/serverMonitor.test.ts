import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { container, resetContainer } from '../src/container';
import { closeDatabase, prepareDatabase, signedInAgent } from './helpers/testDb';

/** A fake /proc and /sys with the files the monitor reads. */
function fakeHost() {
  const root = mkdtempSync(join(tmpdir(), 'nvx-host-'));
  const put = (path: string, text: string) => {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  const host = {
    proc: join(root, 'proc'),
    sys: join(root, 'sys'),
    cpu(busy: number, idle: number) {
      put('proc/stat', `cpu  ${busy} 0 0 ${idle} 0 0 0 0 0 0\ncpu0 1 0 0 1\ncpu1 1 0 0 1\n`);
    },
    mains(online: boolean) {
      put('sys/class/power_supply/ADP1/online', online ? '1\n' : '0\n');
    },
  };
  host.cpu(100, 900);
  put(
    'proc/meminfo',
    'MemTotal: 8000000 kB\nMemAvailable: 2000000 kB\nSwapTotal: 1000 kB\nSwapFree: 500 kB\n'
  );
  put('proc/loadavg', '0.50 0.40 0.30 1/100 1\n');
  put('proc/uptime', '3600.5 100.0\n');
  put(
    'proc/net/dev',
    'h1\nh2\n  enp4s0: 1 2 3 4 0 0 0 0 5 6 7 8 0 0 0 0\n  veth1: 1 2 99 99 0 0 0 0 5 6 99 99 0 0 0 0\n'
  );
  put('sys/class/hwmon/hwmon0/name', 'acpitz\n');
  put('sys/class/hwmon/hwmon0/temp1_input', '40000\n');
  put('sys/class/hwmon/hwmon1/name', 'coretemp\n');
  put('sys/class/hwmon/hwmon1/temp1_input', '52000\n');
  put('sys/class/hwmon/hwmon1/temp2_input', '55000\n');
  put('sys/class/power_supply/ADP1/type', 'Mains\n');
  put('sys/class/power_supply/BAT0/type', 'Battery\n');
  put('sys/class/power_supply/BAT0/capacity', '97\n');
  host.mains(true);
  return host;
}

afterAll(async () => {
  resetContainer();
  await closeDatabase();
});

describe('server monitoring', () => {
  let host: ReturnType<typeof fakeHost>;

  beforeEach(async () => {
    await prepareDatabase();
    host = fakeHost();
    resetContainer({
      serverMonitor: {
        procRoot: host.proc,
        sysRoot: host.sys,
        disks: [{ path: '/', name: 'System' }],
      },
    });
  });

  it('reads CPU, memory, load, temperature, power, disk, network errors and the database', async () => {
    const service = container.serverMonitorService;
    const first = await service.sample();
    expect(first.cpuPercent).toBeNull(); // needs two readings
    host.cpu(400, 1000); // +300 busy, +100 idle
    const s = await service.sample();

    expect(s).toMatchObject({
      cpuPercent: 75,
      load1: 0.5,
      loadCores: 2,
      memoryPercent: 75,
      swapPercent: 50,
      uptimeSeconds: 3601,
      temperatureC: 55,
      onBattery: false,
      batteryPercent: 97,
      netErrors: 3 + 7,
      db: { up: true },
    });
    expect(s.disks[0]).toMatchObject({ name: 'System' });
    expect(s.db.connections).toBeGreaterThan(0);

    const agent = await signedInAgent();
    expect((await agent.get('/api/server/status')).body.cpuPercent).toBe(75);
    expect((await agent.get('/api/server/history?hours=1')).body.points).toHaveLength(2);
  });

  it('reports a power outage once and the return of mains power', async () => {
    const service = container.serverMonitorService;
    await service.sample();
    host.mains(false);
    await service.sample();
    await service.sample();
    host.mains(true);
    await service.sample();

    const titles = (await container.alertsService.list()).alerts.map((a) => a.title).reverse();
    expect(titles).toEqual([
      'Server is on battery (97 %): power outage?',
      'Server is back on mains power',
    ]);
  });
});
