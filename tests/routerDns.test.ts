import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../src/config/db';
import { resetContainer } from '../src/container';
import {
  HuaweiWebClient,
  type FormSubmission,
  type RouterPage,
} from '../src/modules/router/huaweiWebClient';
import { UpnpClient } from '../src/modules/router/upnpClient';
import { closeDatabase, prepareDatabase, signedInAgent } from './helpers/testDb';

const HOSTS = 'InternetGatewayDevice.X_HW_DNS.HOSTS';

/** Router stand-in for dnshosts.asp and dnshostslist.asp. */
class DnsRouter extends HuaweiWebClient {
  hosts = new Map<number, [string, string]>();
  submissions: FormSubmission[] = [];
  ignoreWrites = false;

  constructor() {
    super({ baseUrl: 'http://router.test', username: 'admin', password: 'x' });
  }

  render(): string {
    const rows = [...this.hosts].map(
      ([i, [ip, name]]) => `new DnsHostsItemClass("${HOSTS}.${i}","${ip}","${name}")`
    );
    return `function DnsHostsItemClass(domain, IPAddress, DomainName) {}\nvar DnsHostsListTemp = new Array(${[...rows, 'null'].join(',')});`;
  }

  override async fetchPages<T extends RouterPage>(names: readonly T[]) {
    return Object.fromEntries(names.map((n) => [n, this.render()])) as Record<T, string>;
  }

  override async submitForm(form: FormSubmission) {
    this.submissions.push(form);
    const f = form.fields;
    if (!this.ignoreWrites) {
      if (form.action === 'add') {
        this.hosts.set(Math.max(0, ...this.hosts.keys()) + 1, [
          f['x.IPAddress']!,
          f['x.DomainName']!,
        ]);
      } else if (form.action === 'set') {
        this.hosts.set(Number(form.object!.split('.').pop()), [
          f['x.IPAddress']!,
          f['x.DomainName']!,
        ]);
      } else {
        for (const key of Object.keys(f)) this.hosts.delete(Number(key.split('.').pop()));
      }
    }
    return this.render();
  }
}

let router: DnsRouter;

function setup(writesEnabled = true) {
  router = new DnsRouter();
  resetContainer({
    routerWebClient: router,
    upnpClient: new UpnpClient({
      baseUrl: 'http://router.test',
      wanCommonControl: '/c',
      wanIpControl: '/i',
    }),
    routerWritesEnabled: writesEnabled,
  });
}

afterAll(async () => {
  resetContainer();
  await closeDatabase();
});

describe('router static DNS', () => {
  beforeEach(async () => {
    await prepareDatabase();
    setup();
  });

  it('adds, changes and deletes an entry with the router form fields', async () => {
    const agent = await signedInAgent();

    const add = await agent
      .post('/api/router/dns-hosts')
      .send({ name: 'NAS.lan', ip: '192.168.100.50' });
    const put = await agent
      .put('/api/router/dns-hosts/1')
      .send({ name: 'nas.lan', ip: '192.168.100.51' });
    const list = await agent.get('/api/router/dns-hosts');
    const del = await agent.delete('/api/router/dns-hosts/1');

    expect(add.status).toBe(201);
    expect(add.body).toMatchObject({ name: 'nas.lan', ip: '192.168.100.50', index: 1 });
    expect(router.submissions[0]).toMatchObject({
      page: 'dnsHosts',
      readBack: 'dnsHostsData',
      action: 'add',
      object: HOSTS,
      fields: { 'x.IPAddress': '192.168.100.50', 'x.DomainName': 'nas.lan' },
    });
    expect(put.body.ip).toBe('192.168.100.51');
    expect(list.body).toMatchObject({ writesEnabled: true, hosts: [{ name: 'nas.lan' }] });
    expect(del.body).toEqual([]);
    expect(router.submissions[2]).toMatchObject({
      action: 'del',
      object: HOSTS,
      fields: { [`${HOSTS}.1`]: '' },
    });
    const audit = await db('audit_logs').where({ action: 'router.dns_host_deleted' }).first();
    expect(audit.details.before).toMatchObject({ name: 'nas.lan' });
  });

  it.each([
    [{ name: 'bad name', ip: '192.168.100.50' }, 'name'],
    [{ name: '-nas.lan', ip: '192.168.100.50' }, 'name'],
    [{ name: 'nas.lan', ip: '192.168.100.500' }, 'ip'],
  ])('rejects invalid input %#', async (input, path) => {
    const agent = await signedInAgent();
    const res = await agent.post('/api/router/dns-hosts').send(input);
    expect(res.status).toBe(400);
    expect(res.body.details.map((d: { path: string }) => d.path)).toContain(path);
  });

  it('refuses a second entry for a name and more than 20 entries', async () => {
    const agent = await signedInAgent();
    await agent.post('/api/router/dns-hosts').send({ name: 'nas.lan', ip: '192.168.100.50' });
    const dup = await agent
      .post('/api/router/dns-hosts')
      .send({ name: 'nas.lan', ip: '192.168.100.51' });
    for (let i = 2; i <= 20; i++) router.hosts.set(i, ['192.168.100.60', `h${i}.lan`]);
    const full = await agent
      .post('/api/router/dns-hosts')
      .send({ name: 'more.lan', ip: '192.168.100.70' });
    expect(dup.status).toBe(422);
    expect(full.status).toBe(422);
  });

  it('reports an entry the router did not save, and refuses writes when turned off', async () => {
    router.ignoreWrites = true;
    const agent = await signedInAgent();
    expect(
      (await agent.post('/api/router/dns-hosts').send({ name: 'nas.lan', ip: '192.168.100.50' }))
        .status
    ).toBe(502);
    setup(false);
    const off = await signedInAgent();
    expect(
      (await off.post('/api/router/dns-hosts').send({ name: 'nas.lan', ip: '192.168.100.50' }))
        .status
    ).toBe(403);
  });
});
