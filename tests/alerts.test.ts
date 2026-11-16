import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { container, resetContainer } from '../src/container';
import type { DiscoveredHost } from '../src/modules/devices/nmapXmlParser';
import { HuaweiWebClient, type RouterPage } from '../src/modules/router/huaweiWebClient';
import type { ProbeResult } from '../src/modules/monitoring/probes';
import { UpnpClient } from '../src/modules/router/upnpClient';
import { closeDatabase, prepareDatabase, signedInAgent } from './helpers/testDb';

const REPLY: ProbeResult = { success: true, latencyMs: 1, packetLossPercent: 0, error: null };
const NO_REPLY: ProbeResult = {
  success: false,
  latencyMs: null,
  packetLossPercent: 100,
  error: 'No reply',
};

class FakeProber {
  replies = new Map<string, ProbeResult>();
  async http(url: string) {
    return this.replies.get(url) ?? NO_REPLY;
  }
  async ping(host: string) {
    return this.replies.get(host) ?? REPLY;
  }
  async resolve() {
    return REPLY;
  }
}

class FakeDiscoverer {
  hosts: DiscoveredHost[] = [];
  async discover() {
    return this.hosts;
  }
}

/** Only the optical page matters here; rx power and LOS are set by the test. */
class OpticRouter extends HuaweiWebClient {
  rx = '-17.10';
  los = '0';
  constructor() {
    super({ baseUrl: 'http://router.test', username: 'admin', password: 'x' });
  }
  override async fetchPages<T extends RouterPage>(names: readonly T[]) {
    const optic = `var o = new Array(new stOpticInfo("d","ok"," 3.59","${this.rx}","3376","52","26","--","--","HUAWEI","SN","210605","1310","1490","20","${this.los}"),null);`;
    return Object.fromEntries(names.map((n) => [n, n === 'optical' ? optic : ''])) as Record<
      T,
      string
    >;
  }
}

class NoUpnp extends UpnpClient {
  constructor() {
    super({ baseUrl: 'http://router.test', wanCommonControl: '/c', wanIpControl: '/i' });
  }
  override async getWanStatus(): Promise<never> {
    throw new Error('no upnp');
  }
}

const titles = async () =>
  (await container.alertsService.list()).alerts.map((a) => a.title).reverse();

afterAll(async () => {
  resetContainer();
  await closeDatabase();
});

describe('alerts', () => {
  let prober: FakeProber;
  let discoverer: FakeDiscoverer;
  let router: OpticRouter;

  beforeEach(async () => {
    await prepareDatabase();
    prober = new FakeProber();
    discoverer = new FakeDiscoverer();
    router = new OpticRouter();
    resetContainer({
      prober,
      hostDiscoverer: discoverer,
      routerWebClient: router,
      upnpClient: new NoUpnp(),
    });
  });

  it('reports the internet down after two failed checks, once, and back when it answers', async () => {
    await container.monitoringService.syncManagedTargets();
    prober.replies.set('1.1.1.1', NO_REPLY);
    await container.monitoringService.runChecks();
    expect(await titles()).toEqual([]);
    await container.monitoringService.runChecks();
    await container.monitoringService.runChecks();
    prober.replies.set('1.1.1.1', REPLY);
    await container.monitoringService.runChecks();
    await container.monitoringService.runChecks();

    expect(await titles()).toEqual(['Internet is down', 'Internet is back']);
  });

  it('reports devices seen for the first time, and not again', async () => {
    discoverer.hosts = [
      {
        ipAddress: '192.168.100.50',
        macAddress: 'aa:bb:cc:00:00:50',
        vendor: null,
        hostname: 'tablet',
      },
    ];
    for (let i = 0; i < 2; i++) {
      await container.devicesService.startScan(undefined, null);
      await container.devicesService.waitForActiveScan();
    }
    expect(await titles()).toEqual(['New device on the network: tablet']);
  });

  it('reports a weak and a lost fiber signal and their recovery, without repeats', async () => {
    const poll = () => container.routerService.poll();
    (container.routerService as unknown as { settings: { host: string } }).settings.host =
      '192.168.100.1';
    await poll(); // -17.10: fine, nothing to report
    router.rx = '-27.50';
    await poll();
    await poll();
    router.rx = '-26.00'; // between the limits: still weak
    await poll();
    router.rx = '-20.00';
    await poll();
    router.los = '1';
    await poll();

    expect(await titles()).toEqual([
      'Weak fiber signal: -27.5 dBm',
      'Fiber signal back to normal: -20 dBm',
      'Fiber signal lost',
    ]);
  });

  it('keeps a new-device alert whose network name is too long for a title', async () => {
    discoverer.hosts = [
      {
        ipAddress: '192.168.100.60',
        macAddress: 'aa:bb:cc:00:00:60',
        vendor: null,
        hostname: 'x'.repeat(500),
      },
    ];
    await container.devicesService.startScan(undefined, null);
    await container.devicesService.waitForActiveScan();
    const [alert] = (await container.alertsService.list()).alerts;
    expect(alert!.kind).toBe('new_device');
    expect(alert!.title).toHaveLength(200);
  });

  it('lists alerts with an unread count and marks them read', async () => {
    await container.alertsService.raise('new_device', 'warning', 'New device on the network: x');
    const agent = await signedInAgent();

    expect((await agent.get('/api/alerts')).body).toMatchObject({
      unread: 1,
      alerts: [{ kind: 'new_device', severity: 'warning', read: false }],
    });
    expect((await agent.post('/api/alerts/read-all')).body).toEqual({ marked: 1 });
    expect((await agent.get('/api/alerts')).body.unread).toBe(0);
  });
});
