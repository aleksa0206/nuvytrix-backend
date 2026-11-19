import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../src/config/db';
import { container, resetContainer } from '../src/container';
import {
  HuaweiWebClient,
  type FormSubmission,
  type RouterPage,
} from '../src/modules/router/huaweiWebClient';
import { parseDhcpServer } from '../src/modules/router/huaweiParser';
import { UpnpClient } from '../src/modules/router/upnpClient';
import { DEVICES_PAGE } from './fixtures/huawei';
import { closeDatabase, prepareDatabase, signedInAgent } from './helpers/testDb';

const x = (value: string) => value.replace(/[.:]/g, (c) => (c === '.' ? '\\x2e' : '\\x3a'));
const HOST = 'InternetGatewayDevice.LANDevice.1.LANHostConfigManagement';

/** Router stand-in that keeps the DHCP pool and reservations in memory, rendered like the router. */
class DhcpRouter extends HuaweiWebClient {
  pool = { start: '192.168.100.2', end: '192.168.100.254', lease: '86400' };
  dns = '';
  reservations = new Map<number, { ip: string; mac: string }>();
  next = 1;
  ignoreWrites = false;
  submissions: FormSubmission[] = [];

  constructor() {
    super({ baseUrl: 'http://router.test', username: 'admin', password: 'x' });
  }

  render(page: RouterPage): string {
    if (page === 'devices') return DEVICES_PAGE;
    if (page === 'dhcpServer') {
      const empty = Array(10).fill('""').join(',');
      return (
        `var LanIpInfos = new Array(new stipaddr("${HOST}.IPInterface.1","1","${x('192.168.100.1')}","${x('255.255.255.0')}"),null);\n` +
        `var MainDhcpRange = new Array(new dhcpmainst("${HOST}","1","${x(this.pool.start)}","${x(this.pool.end)}","${this.pool.lease}","1",${empty},"${x(this.dns)}","1","","0"),null);`
      );
    }
    const rows = [...this.reservations.entries()].map(
      ([i, r]) => `new stDhcp("${HOST}.DHCPStaticAddress.${i}","1","${x(r.ip)}","${x(r.mac)}")`
    );
    return `function stDhcp(domain,Enable,ipAddress,macAddress) {}\nvar Dhcps = new Array(${[...rows, 'null'].join(',')});`;
  }

  override async fetchPages<T extends RouterPage>(names: readonly T[]) {
    return Object.fromEntries(names.map((name) => [name, this.render(name)])) as Record<T, string>;
  }

  override async submitForm(form: FormSubmission) {
    this.submissions.push(form);
    const f = form.fields;
    if (!this.ignoreWrites) {
      if (form.page === 'dhcpServer') {
        this.pool = {
          start: f['z.MinAddress']!,
          end: f['z.MaxAddress']!,
          lease: f['z.DHCPLeaseTime']!,
        };
      } else if (form.action === 'add') {
        this.reservations.set(this.next++, { ip: f['x.Yiaddr']!, mac: f['x.Chaddr']! });
      } else if (form.action === 'set') {
        this.reservations.set(Number(form.object!.split('.').pop()), {
          ip: f['x.Yiaddr']!,
          mac: f['x.Chaddr']!,
        });
      } else {
        for (const key of Object.keys(f)) this.reservations.delete(Number(key.split('.').pop()));
      }
    }
    return this.render(form.page);
  }
}

const RESERVATION = { mac: '02:4E:56:00:00:01', ip: '192.168.100.250' };
let router: DhcpRouter;

function setup(writesEnabled = true) {
  router = new DhcpRouter();
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
    routerDhcpService: { settings: { protectedAddresses: string[] } };
  };
  internals.routerDhcpService.settings.protectedAddresses = ['192.168.100.27'];
}

afterAll(async () => {
  resetContainer();
  await closeDatabase();
});

describe('router DHCP parsing', () => {
  it('reads the main pool, the LAN address and the DNS list', () => {
    const page = new DhcpRouter().render('dhcpServer');
    expect(parseDhcpServer(page)).toEqual({
      enabled: true,
      lanIp: '192.168.100.1',
      subnetMask: '255.255.255.0',
      startIp: '192.168.100.2',
      endIp: '192.168.100.254',
      leaseSeconds: 86400,
      dnsServers: [],
      l2RelayFlag: '1',
      option125Flag: '1',
    });
  });
});

describe('router DHCP management', () => {
  beforeEach(async () => {
    await prepareDatabase();
    setup();
  });

  it('reads the pool and the reservations', async () => {
    const agent = await signedInAgent();
    const { body } = await agent.get('/api/router/dhcp');
    expect(body).toMatchObject({
      writesEnabled: true,
      server: { startIp: '192.168.100.2', leaseSeconds: 86400 },
      reservations: [],
    });
  });

  it('refuses writes while ROUTER_WRITES_ENABLED is off', async () => {
    setup(false);
    const agent = await signedInAgent();
    const res = await agent.post('/api/router/dhcp/reservations').send(RESERVATION);
    expect(res.status).toBe(403);
    expect(router.submissions).toHaveLength(0);
  });

  it('adds a reservation with the router form fields and audits it', async () => {
    const agent = await signedInAgent();

    const res = await agent.post('/api/router/dhcp/reservations').send(RESERVATION);

    expect(res.status).toBe(201);
    expect(res.body.reservation).toMatchObject({ ip: '192.168.100.250', mac: '02:4e:56:00:00:01' });
    expect(router.submissions[0]).toMatchObject({
      page: 'dhcpStatic',
      action: 'add',
      object: `${HOST}.DHCPStaticAddress`,
      fields: { 'x.Yiaddr': '192.168.100.250', 'x.Chaddr': '02:4e:56:00:00:01', 'x.Enable': '1' },
    });
    const audit = await db('audit_logs')
      .where({ action: 'router.dhcp_reservation_created' })
      .first();
    expect(audit.details.outcome).toBe('applied');
  });

  it.each([
    [{ ...RESERVATION, mac: '02:4e:56:00:01' }, 'mac'],
    [{ ...RESERVATION, mac: '01:00:5e:00:00:01' }, 'mac'],
    [{ ...RESERVATION, ip: '192.168.100.256' }, 'ip'],
  ])('rejects invalid input %#', async (input, path) => {
    const agent = await signedInAgent();
    const res = await agent.post('/api/router/dhcp/reservations').send(input);
    expect(res.status).toBe(400);
    expect(res.body.details.map((d: { path: string }) => d.path)).toContain(path);
  });

  it.each([
    ['outside the LAN', { ...RESERVATION, ip: '192.168.2.10' }],
    ['the broadcast address', { ...RESERVATION, ip: '192.168.100.255' }],
    ['the router', { ...RESERVATION, ip: '192.168.100.1' }],
    ['held by another device', { ...RESERVATION, ip: '192.168.100.20' }],
  ])('refuses an address %s', async (_label, input) => {
    const agent = await signedInAgent();
    const res = await agent.post('/api/router/dhcp/reservations').send(input);
    expect(res.status).toBe(422);
    expect(router.submissions).toHaveLength(0);
  });

  it('allows reserving the address a device already holds for that device', async () => {
    const agent = await signedInAgent();
    const res = await agent
      .post('/api/router/dhcp/reservations')
      .send({ mac: 'aa:bb:cc:00:00:20', ip: '192.168.100.20' });
    expect(res.status).toBe(201);
  });

  it('refuses a second reservation for the same MAC or address', async () => {
    const agent = await signedInAgent();
    await agent.post('/api/router/dhcp/reservations').send(RESERVATION);

    const sameMac = await agent
      .post('/api/router/dhcp/reservations')
      .send({ ...RESERVATION, ip: '192.168.100.251' });
    const sameIp = await agent
      .post('/api/router/dhcp/reservations')
      .send({ ...RESERVATION, mac: '02:4e:56:00:00:02' });

    expect(sameMac.status).toBe(422);
    expect(sameIp.status).toBe(422);
  });

  it('changes and deletes a reservation, keeping the old one in the audit log', async () => {
    const agent = await signedInAgent();
    await agent.post('/api/router/dhcp/reservations').send(RESERVATION);

    const put = await agent
      .put('/api/router/dhcp/reservations/1')
      .send({ ...RESERVATION, ip: '192.168.100.251' });
    const del = await agent.delete('/api/router/dhcp/reservations/1');

    expect(put.status).toBe(200);
    expect(put.body.reservation.ip).toBe('192.168.100.251');
    expect(router.submissions[1]).toMatchObject({
      action: 'set',
      object: `${HOST}.DHCPStaticAddress.1`,
    });
    expect(del.status).toBe(200);
    expect(del.body).toEqual([]);
    expect(router.submissions[2]).toMatchObject({
      action: 'del',
      object: `${HOST}.DHCPStaticAddress`,
      fields: { [`${HOST}.DHCPStaticAddress.1`]: '' },
    });
    const audit = await db('audit_logs')
      .where({ action: 'router.dhcp_reservation_deleted' })
      .first();
    expect(audit.details.before).toMatchObject({ ip: '192.168.100.251' });
  });

  it('returns 404 for a reservation that is not on the router', async () => {
    const agent = await signedInAgent();
    expect((await agent.delete('/api/router/dhcp/reservations/9')).status).toBe(404);
    expect((await agent.put('/api/router/dhcp/reservations/9').send(RESERVATION)).status).toBe(404);
  });

  it('changes the pool and lease time with the z= object', async () => {
    const agent = await signedInAgent();

    const res = await agent
      .patch('/api/router/dhcp')
      .send({ startIp: '192.168.100.2', endIp: '192.168.100.200', leaseSeconds: 43200 });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ endIp: '192.168.100.200', leaseSeconds: 43200 });
    expect(router.submissions[0]).toMatchObject({
      page: 'dhcpServer',
      action: 'set',
      objectKey: 'z',
      object: HOST,
      fields: { 'z.MinAddress': '192.168.100.2', 'z.DHCPLeaseTime': '43200' },
    });
    const audit = await db('audit_logs').where({ action: 'router.dhcp_server_changed' }).first();
    expect(audit.details.before).toMatchObject({ endIp: '192.168.100.254', leaseSeconds: 86400 });
  });

  it.each([
    ['includes the router', { startIp: '192.168.100.1', endIp: '192.168.100.254' }],
    ['leaves out a protected address', { startIp: '192.168.100.100', endIp: '192.168.100.254' }],
    ['leaves the subnet', { startIp: '192.168.100.2', endIp: '192.168.101.10' }],
  ])('refuses a pool that %s', async (_label, pool) => {
    const agent = await signedInAgent();
    const res = await agent.patch('/api/router/dhcp').send({ ...pool, leaseSeconds: 86400 });
    expect(res.status).toBe(422);
    expect(router.submissions).toHaveLength(0);
  });

  it('refuses a pool that leaves out a reservation', async () => {
    const agent = await signedInAgent();
    await agent.post('/api/router/dhcp/reservations').send(RESERVATION);
    const res = await agent
      .patch('/api/router/dhcp')
      .send({ startIp: '192.168.100.2', endIp: '192.168.100.200', leaseSeconds: 86400 });
    expect(res.status).toBe(422);
    expect(res.body.message).toContain('192.168.100.250');
  });

  it.each([30, 90, 604800 * 10 + 60])('rejects lease time %s', async (leaseSeconds) => {
    const agent = await signedInAgent();
    const res = await agent
      .patch('/api/router/dhcp')
      .send({ startIp: '192.168.100.2', endIp: '192.168.100.254', leaseSeconds });
    expect(res.status).toBe(400);
  });

  it('reports a change the router did not apply', async () => {
    router.ignoreWrites = true;
    const agent = await signedInAgent();
    const res = await agent
      .patch('/api/router/dhcp')
      .send({ startIp: '192.168.100.2', endIp: '192.168.100.254', leaseSeconds: 3600 });
    expect(res.status).toBe(502);
    const audit = await db('audit_logs').where({ action: 'router.dhcp_server_changed' }).first();
    expect(audit.details.outcome).toBe('not_applied');
  });
});
