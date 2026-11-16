import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../src/config/db';
import { container, resetContainer } from '../src/container';
import { AdGuardClient, type AdGuardStats } from '../src/modules/dns/adguardClient';
import { parsePingOutput, type ProbeResult } from '../src/modules/monitoring/probes';
import { closeDatabase, prepareDatabase, signedInAgent } from './helpers/testDb';

const REPLY: ProbeResult = { success: true, latencyMs: 1.5, packetLossPercent: 0, error: null };
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
    return this.replies.get(host) ?? NO_REPLY;
  }
  async resolve(resolver: string) {
    return this.replies.get(resolver) ?? NO_REPLY;
  }
}

afterAll(async () => {
  resetContainer();
  await closeDatabase();
});

describe('parsePingOutput', () => {
  it('reads latency and loss from iputils ping', () => {
    const output = [
      'PING 192.168.100.1 (192.168.100.1) 56(84) bytes of data.',
      '--- 192.168.100.1 ping statistics ---',
      '3 packets transmitted, 2 received, 33.3333% packet loss, time 2003ms',
      'rtt min/avg/max/mdev = 0.412/0.508/0.617/0.083 ms',
    ].join('\n');

    expect(parsePingOutput(output)).toEqual({
      success: true,
      latencyMs: 0.508,
      jitterMs: 0.083,
      packetLossPercent: 33.3333,
      error: null,
    });
  });

  it('reports total loss as a failure and unknown output as unreadable', () => {
    expect(
      parsePingOutput('3 packets transmitted, 0 received, 100% packet loss, time 2040ms')
    ).toMatchObject({ success: false, latencyMs: null, packetLossPercent: 100 });
    expect(parsePingOutput('ping: unknown host')).toBeNull();
  });
});

describe('monitoring', () => {
  let prober: FakeProber;

  beforeEach(async () => {
    await prepareDatabase();
    prober = new FakeProber();
    resetContainer({ prober });
  });

  it('reports a new target as unknown until it has actually been checked', async () => {
    const agent = await signedInAgent();
    await agent
      .post('/api/monitoring/targets')
      .send({ name: 'Server', kind: 'icmp', host: '192.168.100.10' });

    const [target] = (await agent.get('/api/monitoring/targets')).body;

    expect(target).toMatchObject({ status: 'unknown', lastCheck: null, window: null });
    const series = await agent.get(`/api/monitoring/targets/${target.id}/series`);
    expect(series.body.points).toEqual([]);
  });

  it('records checks and computes uptime only from recorded results', async () => {
    const agent = await signedInAgent();
    const { body: target } = await agent
      .post('/api/monitoring/targets')
      .send({ name: 'Server', kind: 'icmp', host: '192.168.100.10' });

    prober.replies.set('192.168.100.10', REPLY);
    await container.monitoringService.runChecks();
    await container.monitoringService.runChecks();
    prober.replies.set('192.168.100.10', NO_REPLY);
    await container.monitoringService.runChecks();
    await container.monitoringService.runChecks();

    const [listed] = (await agent.get('/api/monitoring/targets')).body;
    expect(listed).toMatchObject({ status: 'down', window: { checks: 4, uptimePercent: 50 } });
    expect(listed.lastSuccessAt).not.toBeNull();
    const series = await agent.get(`/api/monitoring/targets/${target.id}/series?hours=1`);
    expect(
      series.body.points.reduce((sum: number, p: { checks: number }) => sum + p.checks, 0)
    ).toBe(4);
  });

  it('creates the router target from configuration and refuses to edit it', async () => {
    resetContainer({ prober });
    const service = container.monitoringService as unknown as {
      settings: { routerHost: string };
    };
    service.settings.routerHost = '192.168.100.1';
    await container.monitoringService.syncManagedTargets();
    const agent = await signedInAgent();

    const [router] = (await agent.get('/api/monitoring/targets')).body;

    expect(router).toMatchObject({ name: 'Router', host: '192.168.100.1', managed: true });
    expect((await agent.delete(`/api/monitoring/targets/${router.id}`)).status).toBe(409);
  });

  it('rejects hosts that could be read as command-line options', async () => {
    const agent = await signedInAgent();

    for (const host of ['-f', '--flood', '192.168.100.1 -c 9999', 'a;b']) {
      const res = await agent
        .post('/api/monitoring/targets')
        .send({ name: 'x', kind: 'icmp', host });
      expect(res.status).toBe(400);
    }
    const dnsWithoutQuery = await agent
      .post('/api/monitoring/targets')
      .send({ name: 'DNS', kind: 'dns', host: '192.168.100.1' });
    expect(dnsWithoutQuery.status).toBe(400);
  });

  it('deletes results older than the retention period', async () => {
    const agent = await signedInAgent();
    const { body: target } = await agent
      .post('/api/monitoring/targets')
      .send({ name: 'Server', kind: 'icmp', host: '192.168.100.10' });
    await container.monitoringService.runChecks();
    await db('monitoring_results').insert({
      target_id: target.id,
      success: true,
      checked_at: db.raw(`now() - interval '400 days'`),
    });

    expect(await container.monitoringService.deleteExpiredResults()).toBe(1);
  });
});

class FakeAdGuard extends AdGuardClient {
  constructor(private fail = false) {
    super({ url: 'http://adguard.test', username: '', password: '' });
  }
  override async getStatus() {
    if (this.fail) throw new Error('ECONNREFUSED');
    return {
      version: 'v0.107',
      protection_enabled: true,
      running: true,
      dns_addresses: ['192.168.100.10'],
    };
  }
  override async getStats(): Promise<AdGuardStats> {
    if (this.fail) throw new Error('ECONNREFUSED');
    return {
      time_units: 'hours',
      num_dns_queries: 200,
      num_blocked_filtering: 50,
      num_replaced_safebrowsing: 0,
      num_replaced_parental: 0,
      avg_processing_time: 0.0123,
      top_queried_domains: [{ 'example.com': 120 }],
      top_blocked_domains: [{ 'ads.example': 40 }],
      top_clients: [{ '192.168.100.20': 150 }],
    };
  }
}

describe('dns and overview', () => {
  beforeEach(prepareDatabase);

  it('reports DNS as not configured and refuses to return statistics', async () => {
    const agent = await signedInAgent();

    expect((await agent.get('/api/dns/status')).body).toEqual({
      provider: 'adguard_home',
      configured: false,
    });
    const stats = await agent.get('/api/dns/stats');
    expect(stats.status).toBe(503);
    expect(stats.body.code).toBe('DNS_NOT_CONFIGURED');
  });

  it('maps AdGuard Home statistics and reports an unreachable provider', async () => {
    resetContainer({ adguardClient: new FakeAdGuard() });
    const agent = await signedInAgent();

    const stats = await agent.get('/api/dns/stats');

    expect(stats.body).toMatchObject({
      totalQueries: 200,
      blockedByFilters: 50,
      blockedPercent: 25,
      avgProcessingMs: 12.3,
      topBlockedDomains: [{ name: 'ads.example', count: 40 }],
    });

    resetContainer({ adguardClient: new FakeAdGuard(true) });
    const status = await agent.get('/api/dns/status');
    expect(status.body).toMatchObject({ configured: true, reachable: false });
    expect((await agent.get('/api/dns/stats')).status).toBe(503);
  });

  it('shows unknown and not-configured states on an empty installation', async () => {
    const agent = await signedInAgent();

    const res = await agent.get('/api/overview');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      database: { state: 'operational' },
      router: { state: 'not_configured' },
      devices: { state: 'unknown', total: 0, online: 0 },
      firewall: { state: 'not_configured', hasData: false },
      monitoring: { state: 'not_configured' },
      dns: { state: 'not_configured' },
    });
  });

  it('lists capabilities that depend on missing hardware honestly', async () => {
    const agent = await signedInAgent();

    const res = await agent.get('/api/system/capabilities');

    const traffic = res.body.find((c: { feature: string }) =>
      c.feature.startsWith('Per-device traffic')
    );
    expect(traffic.status).toBe('requires_hardware');
  });
});
