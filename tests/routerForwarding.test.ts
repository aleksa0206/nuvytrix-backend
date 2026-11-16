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

const x = (value: string) => value.replace(/\./g, '\\x2e');
const WAN = 'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.3.WANIPConnection.1';
const HOST = 'InternetGatewayDevice.LANDevice.1.LANHostConfigManagement';

function wanIp(domain: string, services: string) {
  const args = Array.from({ length: 60 }, () => '');
  Object.assign(args, { 0: domain, 12: 'IP_Routed', 25: services, 29: '1' });
  return `new WanIP(${args.map((a) => JSON.stringify(a)).join(',')})`;
}

const WAN_LIST = `var IPWanList = new Array(${wanIp(WAN, 'INTERNET')},null);`;
const DHCP_PAGE =
  `var LanIpInfos = new Array(new stipaddr("${HOST}.IPInterface.1","1","${x('192.168.100.1')}","255\\x2e255\\x2e255\\x2e0"),null);\n` +
  `var MainDhcpRange = new Array(new dhcpmainst("${HOST}","1","${x('192.168.100.2')}","${x('192.168.100.254')}","86400","1",${Array(10).fill('""').join(',')},"","1","","0"),null);`;

type Trigger = string[];

/** Router stand-in for dmz.asp and porttrigger.asp. */
class ForwardRouter extends HuaweiWebClient {
  dmz: { enabled: string; host: string } | null = null;
  triggers = new Map<number, Trigger>();
  next = 1;
  ignoreWrites = false;
  submissions: FormSubmission[] = [];

  constructor() {
    super({ baseUrl: 'http://router.test', username: 'admin', password: 'x' });
  }

  render(page: RouterPage): string {
    if (page === 'wanList') return WAN_LIST;
    if (page === 'dhcpServer') return DHCP_PAGE;
    if (page === 'dmz') {
      const row = this.dmz
        ? `new stDMZInfo("${WAN}.X_HW_DMZ","${this.dmz.enabled}","${x(this.dmz.host)}"),`
        : '';
      return `function stDMZInfo(domain,DMZEnable,DMZHostIPAddress, flag) {}\nvar IpDmzInfo = new Array(${row}null);`;
    }
    const rows = [...this.triggers.entries()].map(
      ([i, t]) =>
        `new stPortTrigger("${WAN}.X_HW_PortTrigger.${i}",${t.map((v) => JSON.stringify(v)).join(',')})`
    );
    return `function stPortTrigger(domain) {}\nvar WanIPPortTrigger = new Array(${[...rows, 'null'].join(',')});`;
  }

  override async fetchPages<T extends RouterPage>(names: readonly T[]) {
    return Object.fromEntries(names.map((name) => [name, this.render(name)])) as Record<T, string>;
  }

  override async submitForm(form: FormSubmission) {
    this.submissions.push(form);
    const f = form.fields;
    if (!this.ignoreWrites && form.page === 'dmz') {
      if (form.action === 'del') this.dmz = null;
      else this.dmz = { enabled: f['x.DMZEnable']!, host: f['x.DMZHostIPAddress']! };
    } else if (!this.ignoreWrites) {
      const trigger = () =>
        [
          'x.Enable',
          'x.TriggerPort',
          'x.TriggerPortEnd',
          'x.TriggerProtocol',
          'x.OpenPort',
          'x.OpenPortEnd',
          'x.OpenProtocol',
        ].map((k) => f[k]!);
      if (form.action === 'add') this.triggers.set(this.next++, trigger());
      else if (form.action === 'set') {
        this.triggers.set(Number(form.object!.split('.').pop()), trigger());
      } else for (const key of Object.keys(f)) this.triggers.delete(Number(key.split('.').pop()));
    }
    return this.render(form.page);
  }
}

const TRIGGER = {
  enabled: true,
  triggerProtocol: 'TCP',
  triggerPortStart: 6660,
  triggerPortEnd: 6669,
  openProtocol: 'TCP',
  openPortStart: 113,
  openPortEnd: 113,
};
let router: ForwardRouter;

function setup(writesEnabled = true) {
  router = new ForwardRouter();
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
    routerForwardingService: { settings: { protectedAddresses: string[] } };
  };
  internals.routerForwardingService.settings.protectedAddresses = ['192.168.100.27'];
}

afterAll(async () => {
  resetContainer();
  await closeDatabase();
});

describe('router DMZ', () => {
  beforeEach(async () => {
    await prepareDatabase();
    setup();
  });

  it('reads no DMZ', async () => {
    const agent = await signedInAgent();
    const { body } = await agent.get('/api/router/dmz');
    expect(body).toEqual({ writesEnabled: true, internetWan: WAN, dmz: null });
  });

  it('creates the DMZ entry, then changes it with set, then deletes it', async () => {
    const agent = await signedInAgent();

    const add = await agent.put('/api/router/dmz').send({ enabled: false, host: '192.168.100.50' });
    const on = await agent.put('/api/router/dmz').send({ enabled: true, host: '192.168.100.50' });
    const del = await agent.delete('/api/router/dmz');

    expect(add.body).toMatchObject({ enabled: false, host: '192.168.100.50' });
    expect(on.body.enabled).toBe(true);
    expect(del.status).toBe(204);
    expect(router.submissions.map((s) => s.action)).toEqual(['add', 'set', 'del']);
    expect(router.submissions[0]).toMatchObject({
      object: `${WAN}.X_HW_DMZ`,
      fields: { 'x.DMZEnable': '0', 'x.DMZHostIPAddress': '192.168.100.50' },
    });
    expect(router.submissions[2]!.fields).toEqual({ [`${WAN}.X_HW_DMZ`]: '' });
    const audit = await db('audit_logs').where({ action: 'router.dmz_deleted' }).first();
    expect(audit.details.before).toMatchObject({ host: '192.168.100.50' });
  });

  it.each([
    ['the router', '192.168.100.1'],
    ['an address outside the LAN', '10.0.0.5'],
    ['the server', '192.168.100.27'],
  ])('refuses %s as DMZ host', async (_label, host) => {
    const agent = await signedInAgent();
    expect((await agent.put('/api/router/dmz').send({ enabled: true, host })).status).toBe(422);
    expect(router.submissions).toHaveLength(0);
  });

  it('refuses writes while ROUTER_WRITES_ENABLED is off, and 404 without a DMZ', async () => {
    const agent = await signedInAgent();
    expect((await agent.delete('/api/router/dmz')).status).toBe(404);
    setup(false);
    const off = await signedInAgent();
    expect(
      (await off.put('/api/router/dmz').send({ enabled: true, host: '192.168.100.50' })).status
    ).toBe(403);
  });
});

describe('router port triggers', () => {
  beforeEach(async () => {
    await prepareDatabase();
    setup();
  });

  it('adds, changes and deletes a trigger with the router form fields', async () => {
    const agent = await signedInAgent();

    const add = await agent.post('/api/router/port-triggers').send(TRIGGER);
    const put = await agent
      .put('/api/router/port-triggers/1')
      .send({ ...TRIGGER, enabled: false, openProtocol: 'TCP/UDP', openPortEnd: 115 });
    const del = await agent.delete('/api/router/port-triggers/1');

    expect(add.status).toBe(201);
    expect(add.body.trigger).toMatchObject({ triggerPortStart: 6660, openPortEnd: 113 });
    expect(router.submissions[0]).toMatchObject({
      page: 'portTrigger',
      action: 'add',
      object: `${WAN}.X_HW_PortTrigger`,
      fields: { 'x.TriggerPort': '6660', 'x.TriggerPortEnd': '6669', 'x.OpenProtocol': 'TCP' },
    });
    expect(put.body.trigger).toMatchObject({ enabled: false, openProtocol: 'TCP/UDP' });
    expect(del.body).toEqual([]);
    const audit = await db('audit_logs').where({ action: 'router.port_trigger_created' }).first();
    expect(audit.details.outcome).toBe('applied');
  });

  it.each([
    [{ ...TRIGGER, triggerPortStart: 20, triggerPortEnd: 22 }, 'triggerPortStart'],
    [{ ...TRIGGER, triggerPortStart: 60, triggerPortEnd: 70 }, 'triggerPortStart'],
    [{ ...TRIGGER, openPortEnd: 100 }, 'openPortEnd'],
    [{ ...TRIGGER, openPortStart: 1000, openPortEnd: 2000 }, 'openPortEnd'],
    [{ ...TRIGGER, triggerProtocol: 'ICMP' }, 'triggerProtocol'],
  ])('rejects invalid input %#', async (input, path) => {
    const agent = await signedInAgent();
    const res = await agent.post('/api/router/port-triggers').send(input);
    expect(res.status).toBe(400);
    expect(res.body.details.map((d: { path: string }) => d.path)).toContain(path);
  });

  it('refuses overlapping triggers and more than 256 ports in total', async () => {
    const agent = await signedInAgent();
    await agent.post('/api/router/port-triggers').send(TRIGGER);

    const overlap = await agent
      .post('/api/router/port-triggers')
      .send({ ...TRIGGER, openPortStart: 200, openPortEnd: 200 });
    const otherProtocol = await agent
      .post('/api/router/port-triggers')
      .send({ ...TRIGGER, triggerProtocol: 'UDP', openProtocol: 'UDP' });
    const tooMany = await agent.post('/api/router/port-triggers').send({
      ...TRIGGER,
      triggerPortStart: 30000,
      triggerPortEnd: 30255,
      openPortStart: 40000,
      openPortEnd: 40000,
    });

    expect(overlap.status).toBe(422);
    expect(otherProtocol.status).toBe(201);
    expect(tooMany.status).toBe(422);
  });

  it('reports a trigger the router did not create, and 404 for a missing one', async () => {
    router.ignoreWrites = true;
    const agent = await signedInAgent();
    expect((await agent.post('/api/router/port-triggers').send(TRIGGER)).status).toBe(502);
    expect((await agent.delete('/api/router/port-triggers/3')).status).toBe(404);
  });
});
