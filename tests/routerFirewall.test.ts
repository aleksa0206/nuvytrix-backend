import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../src/config/db';
import { container, resetContainer } from '../src/container';
import {
  HuaweiWebClient,
  type FormSubmission,
  type RouterPage,
} from '../src/modules/router/huaweiWebClient';
import { UpnpClient } from '../src/modules/router/upnpClient';
import { closeDatabase, prepareDatabase, signedInAgent } from './helpers/testDb';

type Rule = string[];

/** Router stand-in that keeps the IPv4 filter in memory and renders it like ipincoming.asp. */
class StatefulRouter extends HuaweiWebClient {
  enabled = '1';
  policy = '0';
  rules = new Map<number, Rule>();
  next = 1;
  ignoreWrites = false;
  submissions: FormSubmission[] = [];

  constructor() {
    super({ baseUrl: 'http://router.test', username: 'admin', password: 'x' });
  }

  page(): string {
    const rules = [...this.rules.entries()].map(
      ([index, r]) =>
        `new stFilterIn("InternetGatewayDevice.X_HW_Security.IpFilterIn.${index}",${r.map((v) => JSON.stringify(v)).join(',')})`
    );
    return (
      `var portFilters = new Array(new stPortFilter("InternetGatewayDevice.X_HW_Security","${this.enabled}","${this.policy}","Custom"),null);\n` +
      `var FilterIn = new Array(${[...rules, 'null'].join(',')});\n` +
      `<input type="hidden" name="onttoken" id="hwonttoken" value="abc123">`
    );
  }

  override async fetchPages<T extends RouterPage>(names: readonly T[]) {
    return Object.fromEntries(names.map((name) => [name, this.page()])) as Record<T, string>;
  }

  override async submitForm(form: FormSubmission) {
    this.submissions.push(form);
    if (this.ignoreWrites) return this.page();
    const f = form.fields;
    const rule = () => [
      '',
      f['x.Protocol']!,
      f['x.Direction']!,
      f['x.SourceIPStart']!,
      f['x.SourceIPEnd']!,
      f['x.DestIPStart']!,
      f['x.DestIPEnd']!,
      '',
      f['x.LanSideTcpPort']!,
      f['x.LanSideUdpPort']!,
      f['x.WanSideTcpPort']!,
      f['x.WanSideUdpPort']!,
      f['x.Name']!,
    ];
    if (form.action === 'add') this.rules.set(this.next++, rule());
    if (form.action === 'set' && form.object!.includes('IpFilterIn.')) {
      this.rules.set(Number(form.object!.split('.').pop()), rule());
    } else if (form.action === 'set') {
      this.enabled = f['x.IpFilterInRight'] ?? this.enabled;
      this.policy = f['x.IpFilterInPolicy'] ?? this.policy;
    }
    if (form.action === 'del') {
      for (const key of Object.keys(f)) this.rules.delete(Number(key.split('.').pop()));
    }
    return this.page();
  }
}

const RULE = {
  name: 'Block cameras',
  protocol: 'TCP',
  lanIpStart: '192.168.100.200',
  lanIpEnd: '192.168.100.210',
  lanTcpPorts: '80,8000:8080',
};

let router: StatefulRouter;

function setup(writesEnabled = true) {
  router = new StatefulRouter();
  resetContainer({
    routerWebClient: router,
    upnpClient: new UpnpClient({
      baseUrl: 'http://router.test',
      wanCommonControl: '/c',
      wanIpControl: '/i',
    }),
    routerWritesEnabled: writesEnabled,
  });
  const internals = container as unknown as {
    routerService: { settings: { host: string } };
    routerFirewallService: { settings: { protectedAddresses: string[] } };
  };
  internals.routerService.settings.host = '192.168.100.1';
  internals.routerFirewallService.settings.protectedAddresses = ['192.168.100.1', '192.168.100.27'];
}

afterAll(async () => {
  resetContainer();
  await closeDatabase();
});

describe('router IPv4 filter management', () => {
  beforeEach(async () => {
    await prepareDatabase();
    setup();
  });

  it('reads the filter state and whether writes are allowed', async () => {
    const agent = await signedInAgent();
    const { body } = await agent.get('/api/router/firewall');
    expect(body).toMatchObject({
      writesEnabled: true,
      enabled: true,
      mode: 'blacklist',
      rules: [],
    });
  });

  it('refuses every write while ROUTER_WRITES_ENABLED is off', async () => {
    setup(false);
    const agent = await signedInAgent();

    const res = await agent.post('/api/router/firewall/rules').send(RULE);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('ROUTER_WRITES_DISABLED');
    expect(router.submissions).toHaveLength(0);
  });

  it('adds a rule with the router form fields, verifies it and audits it', async () => {
    const agent = await signedInAgent();

    const res = await agent.post('/api/router/firewall/rules').send(RULE);

    expect(res.status).toBe(201);
    expect(res.body.rule).toMatchObject({
      domain: 'InternetGatewayDevice.X_HW_Security.IpFilterIn.1',
      name: 'Block cameras',
      sourceIpStart: '192.168.100.200',
      lanTcpPorts: '80,8000:8080',
    });
    expect(router.submissions[0]).toMatchObject({
      action: 'add',
      object: 'InternetGatewayDevice.X_HW_Security.IpFilterIn',
      fields: { 'x.Direction': 'Bidirectional', 'x.Protocol': 'TCP', 'x.LanSideUdpPort': '' },
    });
    const audit = await db('audit_logs').where({ action: 'router.firewall_rule_created' }).first();
    expect(audit.details).toMatchObject({
      outcome: 'applied',
      requested: { name: 'Block cameras' },
    });
  });

  it.each([
    [{ ...RULE, lanTcpPorts: '0' }, 'lanTcpPorts'],
    [{ ...RULE, lanTcpPorts: '90:80' }, 'lanTcpPorts'],
    [{ ...RULE, lanTcpPorts: '080' }, 'lanTcpPorts'],
    [
      { ...RULE, lanTcpPorts: Array.from({ length: 16 }, (_, i) => i + 1).join(',') },
      'lanTcpPorts',
    ],
    [{ ...RULE, protocol: 'ICMP' }, 'lanTcpPorts'],
    [{ ...RULE, lanUdpPorts: '53' }, 'lanUdpPorts'],
    [{ ...RULE, lanIpStart: '', lanIpEnd: '' }, 'lanIpStart'],
    [{ ...RULE, lanIpEnd: '192.168.100.100' }, 'lanIpEnd'],
    [{ ...RULE, lanIpStart: '192.168.100.300' }, 'lanIpStart'],
    [{ ...RULE, name: 'bad"name' }, 'name'],
    [{ ...RULE, protocol: 'GRE' }, 'protocol'],
  ])('rejects invalid input %#', async (input, path) => {
    const agent = await signedInAgent();

    const res = await agent.post('/api/router/firewall/rules').send(input);

    expect(res.status).toBe(400);
    expect(res.body.details.map((d: { path: string }) => d.path)).toContain(path);
    expect(router.submissions).toHaveLength(0);
  });

  it('refuses a LAN range that covers the router or a protected address', async () => {
    const agent = await signedInAgent();

    const res = await agent
      .post('/api/router/firewall/rules')
      .send({ ...RULE, lanIpStart: '192.168.100.20', lanIpEnd: '192.168.100.30' });

    expect(res.status).toBe(422);
    expect(res.body.message).toContain('192.168.100.27');
    expect(router.submissions).toHaveLength(0);
  });

  it('refuses a duplicate rule name', async () => {
    const agent = await signedInAgent();
    await agent.post('/api/router/firewall/rules').send(RULE);

    const res = await agent
      .post('/api/router/firewall/rules')
      .send({ ...RULE, lanIpStart: '192.168.100.220', lanIpEnd: '' });

    expect(res.status).toBe(422);
  });

  it('reports a write the router did not apply, and audits it', async () => {
    router.ignoreWrites = true;
    const agent = await signedInAgent();

    const res = await agent.post('/api/router/firewall/rules').send(RULE);

    expect(res.status).toBe(502);
    expect(res.body.code).toBe('ROUTER_WRITE_NOT_APPLIED');
    const audit = await db('audit_logs').where({ action: 'router.firewall_rule_created' }).first();
    expect(audit.details.outcome).toBe('not_applied');
  });

  it('updates a rule in place', async () => {
    const agent = await signedInAgent();
    await agent.post('/api/router/firewall/rules').send(RULE);

    const res = await agent
      .put('/api/router/firewall/rules/1')
      .send({ ...RULE, protocol: 'UDP', lanTcpPorts: '', lanUdpPorts: '53' });

    expect(res.status).toBe(200);
    expect(res.body.rule).toMatchObject({ protocol: 'UDP', lanUdpPorts: '53', lanTcpPorts: '' });
    expect(router.submissions[1]).toMatchObject({
      action: 'set',
      object: 'InternetGatewayDevice.X_HW_Security.IpFilterIn.1',
    });
  });

  it('deletes a rule and keeps the deleted rule in the audit log', async () => {
    const agent = await signedInAgent();
    await agent.post('/api/router/firewall/rules').send(RULE);

    const res = await agent.delete('/api/router/firewall/rules/1');

    expect(res.status).toBe(200);
    expect(res.body.rules).toEqual([]);
    expect(router.submissions[1]).toMatchObject({
      action: 'del',
      fields: { 'InternetGatewayDevice.X_HW_Security.IpFilterIn.1': '' },
    });
    const audit = await db('audit_logs').where({ action: 'router.firewall_rule_deleted' }).first();
    expect(audit.details.before).toMatchObject({ name: 'Block cameras' });
  });

  it('returns 404 for a rule that is not on the router', async () => {
    const agent = await signedInAgent();
    expect((await agent.delete('/api/router/firewall/rules/7')).status).toBe(404);
  });

  it('turns filtering off and on', async () => {
    const agent = await signedInAgent();

    const off = await agent.patch('/api/router/firewall').send({ enabled: false });
    const on = await agent.patch('/api/router/firewall').send({ enabled: true });

    expect(off.body.enabled).toBe(false);
    expect(on.body.enabled).toBe(true);
  });

  it('does not switch to whitelist mode and does not edit rules outside blacklist mode', async () => {
    const agent = await signedInAgent();

    expect((await agent.patch('/api/router/firewall').send({ mode: 'whitelist' })).status).toBe(
      400
    );
    router.policy = '1';
    const res = await agent.post('/api/router/firewall/rules').send(RULE);

    expect(res.status).toBe(422);
    expect(router.submissions).toHaveLength(0);
  });
});
