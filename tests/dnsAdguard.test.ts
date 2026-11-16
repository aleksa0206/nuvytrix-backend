import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../src/config/db';
import { resetContainer } from '../src/container';
import {
  AdGuardClient,
  type AdGuardQueryLogEntry,
  type AdGuardStats,
} from '../src/modules/dns/adguardClient';
import { closeDatabase, prepareDatabase, signedInAgent } from './helpers/testDb';

class FakeAdGuard extends AdGuardClient {
  rules = ['! comment', '||ads.example^', 'some-custom-rule$important'];
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
});
