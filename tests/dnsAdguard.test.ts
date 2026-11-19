import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../src/config/db';
import { container, resetContainer } from '../src/container';
import { withDhcpNames } from '../src/modules/devices/nmapRunner';
import {
  AdGuardClient,
  type AdGuardDhcpStatus,
  type AdGuardQueryLogEntry,
  type AdGuardStats,
} from '../src/modules/dns/adguardClient';
import { closeDatabase, prepareDatabase, signedInAgent } from './helpers/testDb';

class FakeAdGuard extends AdGuardClient {
  rules = ['! comment', '||ads.example^', 'some-custom-rule$important'];
  dhcpEnabled = true;
  constructor() {
    super({ url: 'http://adguard.test', username: 'u', password: 'p' });
  }
  override async getStats(): Promise<AdGuardStats> {
    return {
      time_units: 'hours',
      num_dns_queries: 200,
      num_blocked_filtering: 50,
      num_replaced_safebrowsing: 0,
      num_replaced_parental: 0,
      avg_processing_time: 0.012,
      top_queried_domains: [{ 'example.com': 80 }],
      top_blocked_domains: [{ 'ads.example': 30 }],
      top_clients: [{ '192.168.100.50': 120 }, { '192.168.100.99': 80 }],
      top_upstreams_responses: [{ 'https://dns.quad9.net:443/dns-query': 150 }],
      top_upstreams_avg_time: [{ 'https://dns.quad9.net:443/dns-query': 0.021 }],
    };
  }
  override async getQueryLog(): Promise<{ data: AdGuardQueryLogEntry[] }> {
    return {
      data: [
        {
          time: '2026-11-16T22:00:00Z',
          client: '192.168.100.50',
          question: { name: 'ads.example', type: 'A' },
          reason: 'FilteredBlackList',
          elapsedMs: '0.31',
        },
        {
          time: '2026-11-16T21:59:00Z',
          client: '192.168.100.99',
          question: { name: 'example.com', type: 'AAAA' },
          reason: 'NotFilteredNotFound',
          elapsedMs: '22.4',
          upstream: 'https://dns.quad9.net:443/dns-query',
        },
      ],
    };
  }
  override async getDhcpStatus(): Promise<AdGuardDhcpStatus> {
    return {
      enabled: this.dhcpEnabled,
      interface_name: 'enp4s0',
      v4: {
        gateway_ip: '192.168.100.1',
        subnet_mask: '255.255.255.0',
        range_start: '192.168.100.30',
        range_end: '192.168.100.254',
        lease_duration: 86400,
      },
      leases: [
        { mac: 'AA:BB:CC:00:00:99', ip: '192.168.100.99', hostname: 'phone', expires: 'e99' },
        { mac: 'aa:bb:cc:00:00:50', ip: '192.168.100.50', hostname: '', expires: 'e50' },
      ],
      static_leases: [{ mac: 'aa:bb:cc:00:00:02', ip: '192.168.100.2', hostname: 'pc' }],
    };
  }
  override async getUserRules() {
    return this.rules;
  }
  override async setUserRules(rules: string[]) {
    this.rules = rules;
  }
}

let adguard: FakeAdGuard;

afterAll(async () => {
  resetContainer();
  await closeDatabase();
});

describe('AdGuard Home integration', () => {
  beforeEach(async () => {
    await prepareDatabase();
    adguard = new FakeAdGuard();
    resetContainer({ adguardClient: adguard });
    await db('devices').insert({
      ip_address: '192.168.100.50',
      mac_address: 'aa:bb:cc:00:00:50',
      custom_name: 'Laptop',
      first_seen_at: db.fn.now(),
      last_seen_at: db.fn.now(),
    });
  });

  it('names clients after Nuvytrix devices and reports upstream times', async () => {
    const agent = await signedInAgent();
    const { body } = await agent.get('/api/dns/stats');
    expect(body.topClients).toEqual([
      { name: '192.168.100.50', count: 120, deviceName: 'Laptop' },
      { name: '192.168.100.99', count: 80, deviceName: null },
    ]);
    expect(body.upstreams).toEqual([
      { upstream: 'https://dns.quad9.net:443/dns-query', responses: 150, avgMs: 21 },
    ]);
    expect(body.blockedPercent).toBe(25);
  });

  it('lists recent queries with client names and blocked flags', async () => {
    const agent = await signedInAgent();
    const { body } = await agent.get('/api/dns/querylog?limit=10');
    expect(
      body.map((q: { domain: string; blocked: boolean; clientName: string | null }) => [
        q.domain,
        q.blocked,
        q.clientName,
      ])
    ).toEqual([
      ['ads.example', true, 'Laptop'],
      ['example.com', false, null],
    ]);
  });

  it('adds and removes allow and block rules, keeps other rules, audits, and refuses rule syntax', async () => {
    const agent = await signedInAgent();
    expect((await agent.get('/api/dns/rules')).body).toEqual({
      rules: [{ domain: 'ads.example', action: 'block' }],
      otherRules: ['some-custom-rule$important'],
    });
    await agent.post('/api/dns/rules').send({ domain: 'Bank.Example.com', action: 'allow' });
    expect(adguard.rules).toContain('@@||bank.example.com^');
    await agent.post('/api/dns/rules/delete').send({ domain: 'ads.example', action: 'block' });
    expect(adguard.rules).not.toContain('||ads.example^');
    expect(adguard.rules).toContain('some-custom-rule$important');

    for (const domain of ['ads.example^$important', '*.example.com', 'a b.com', 'localhost']) {
      expect((await agent.post('/api/dns/rules').send({ domain, action: 'block' })).status).toBe(
        400
      );
    }
    const audit = await db('audit_logs').whereIn('action', ['dns.rule_added', 'dns.rule_removed']);
    expect(audit).toHaveLength(2);
  });

  it('shows AdGuard DHCP leases sorted by address and named after devices', async () => {
    const agent = await signedInAgent();
    const { body } = await agent.get('/api/dns/dhcp');
    expect(body).toMatchObject({
      enabled: true,
      rangeStart: '192.168.100.30',
      leaseSeconds: 86400,
    });
    expect(body.leases).toEqual([
      {
        mac: 'aa:bb:cc:00:00:50',
        ip: '192.168.100.50',
        hostname: null,
        deviceName: 'Laptop',
        expires: 'e50',
      },
      {
        mac: 'aa:bb:cc:00:00:99',
        ip: '192.168.100.99',
        hostname: 'phone',
        deviceName: null,
        expires: 'e99',
      },
    ]);
    expect(body.staticLeases).toHaveLength(1);
  });

  it('alerts once while AdGuard DHCP is off and once when it is back', async () => {
    adguard.dhcpEnabled = false;
    await container.dnsService.checkDhcp();
    await container.dnsService.checkDhcp();
    adguard.dhcpEnabled = true;
    await container.dnsService.checkDhcp();
    await container.dnsService.checkDhcp();
    const alerts = await db('alerts').orderBy('id');
    expect(alerts.map((a) => [a.kind, a.resolved_at !== null])).toEqual([
      ['dhcp_off', true],
      ['dhcp_on', false],
    ]);
  });

  it('fills missing discovery host names from DHCP leases, never overrides nmap names', async () => {
    const discoverer = withDhcpNames(
      {
        discover: async () => [
          {
            ipAddress: '192.168.100.99',
            macAddress: 'aa:bb:cc:00:00:99',
            vendor: null,
            hostname: null,
          },
          {
            ipAddress: '192.168.100.2',
            macAddress: 'AA:BB:CC:00:00:02',
            vendor: null,
            hostname: 'desk',
          },
          { ipAddress: '192.168.100.7', macAddress: null, vendor: null, hostname: null },
        ],
      },
      () => container.dnsService.dhcpHostnames()
    );
    const names = (await discoverer.discover('x')).map((h) => h.hostname);
    expect(names).toEqual(['phone', 'desk', null]);
  });
});
