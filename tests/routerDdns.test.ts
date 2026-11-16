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

const WAN = 'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.3.WANIPConnection.1';

function wanIp(domain: string, services: string) {
  const args = Array.from({ length: 60 }, () => '');
  Object.assign(args, { 0: domain, 12: 'IP_Routed', 25: services, 29: '1' });
  return `new WanIP(${args.map((a) => JSON.stringify(a)).join(',')})`;
}

/** Router stand-in for ddns.asp; like the router it never renders passwords. */
class DdnsRouter extends HuaweiWebClient {
  entries = new Map<number, Record<string, string>>();
  passwords = new Map<number, string>();
  submissions: FormSubmission[] = [];
  ignoreWrites = false;

  constructor() {
    super({ baseUrl: 'http://router.test', username: 'admin', password: 'x' });
  }

  render(page: RouterPage): string {
    if (page === 'wanList') return `var IPWanList = new Array(${wanIp(WAN, 'INTERNET')},null);`;
    const rows = [...this.entries].map(
      ([i, e]) =>
        `new stDdns(${[
          `${WAN}.X_HW_DDNSConfiguration.${i}`,
          e['x.DDNSCfgEnabled'],
          e['x.DDNSProvider'],
          e['x.DDNSUsername'],
          e['x.ServicePort'],
          e['x.DDNSDomainName'],
          e['x.DDNSHostName'],
          '',
          'Unconfigured',
          '',
          '',
        ]
          .map((v) => JSON.stringify(v))
          .join(',')})`
    );
    return `function stDdns(domain) {}\nvar Ddns = new Array(${[...rows, 'null'].join(',')});`;
  }

  override async fetchPages<T extends RouterPage>(names: readonly T[]) {
    return Object.fromEntries(names.map((n) => [n, this.render(n)])) as Record<T, string>;
  }

  override async submitForm(form: FormSubmission) {
    this.submissions.push(form);
    if (!this.ignoreWrites) {
      if (form.action === 'add' || form.action === 'set') {
        const index =
          form.action === 'add'
            ? Math.max(0, ...this.entries.keys()) + 1
            : Number(form.object!.split('.').pop());
        const { 'x.DDNSPassword': password, ...rest } = form.fields;
        this.entries.set(index, rest);
        if (password) this.passwords.set(index, password);
      } else {
        for (const key of Object.keys(form.fields))
          this.entries.delete(Number(key.split('.').pop()));
      }
    }
    return this.render(form.page);
  }
}

const ENTRY = {
  enabled: false,
  provider: 'dyndns',
  username: 'me',
  password: 'secret-ddns-pass',
  domainName: 'home.example.com',
  serverHost: 'members.dyndns.org',
  port: 80,
};
let router: DdnsRouter;

function setup(writesEnabled = true) {
  router = new DdnsRouter();
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

describe('router DDNS', () => {
  beforeEach(async () => {
    await prepareDatabase();
    setup();
  });

  it('adds an entry on the internet WAN and never stores or returns the password', async () => {
    const agent = await signedInAgent();

    const res = await agent.post('/api/router/ddns').send(ENTRY);
    const list = await agent.get('/api/router/ddns');

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ index: 1, domainName: 'home.example.com', enabled: false });
    expect(router.submissions[0]).toMatchObject({
      action: 'add',
      object: `${WAN}.X_HW_DDNSConfiguration`,
      fields: { 'x.DDNSPassword': 'secret-ddns-pass', 'x.DDNSCfgEnabled': '0' },
    });
    expect(JSON.stringify([res.body, list.body])).not.toContain('secret-ddns-pass');
    const audit = await db('audit_logs').where({ action: 'router.ddns_created' }).first();
    expect(JSON.stringify(audit.details)).not.toContain('secret-ddns-pass');
    expect(audit.details.requested.password).toBe('[changed]');
  });

  it('changes an entry without sending a password unless a new one is given', async () => {
    const agent = await signedInAgent();
    await agent.post('/api/router/ddns').send(ENTRY);

    const withoutPassword: Partial<typeof ENTRY> = { ...ENTRY };
    delete withoutPassword.password;
    const res = await agent
      .put('/api/router/ddns/1')
      .send({ ...withoutPassword, domainName: 'home2.example.com' });

    expect(res.status).toBe(200);
    expect(res.body.domainName).toBe('home2.example.com');
    expect(router.submissions[1]!.fields['x.DDNSPassword']).toBeUndefined();
    expect(router.passwords.get(1)).toBe('secret-ddns-pass');
  });

  it('deletes an entry and refuses duplicates, more than four entries and invalid input', async () => {
    const agent = await signedInAgent();
    await agent.post('/api/router/ddns').send(ENTRY);

    const dup = await agent.post('/api/router/ddns').send(ENTRY);
    for (let i = 2; i <= 4; i++) router.entries.set(i, { 'x.DDNSDomainName': `h${i}.example.com` });
    const full = await agent
      .post('/api/router/ddns')
      .send({ ...ENTRY, domainName: 'more.example.com' });
    const bad = await agent.post('/api/router/ddns').send({ ...ENTRY, provider: 'gnudip' });
    const del = await agent.delete('/api/router/ddns/1');

    expect(dup.status).toBe(422);
    expect(full.status).toBe(422);
    expect(bad.status).toBe(400);
    expect(del.status).toBe(200);
    expect((await agent.delete('/api/router/ddns/9')).status).toBe(404);
  });

  it('reports an entry the router did not save, and refuses writes when turned off', async () => {
    router.ignoreWrites = true;
    const agent = await signedInAgent();
    expect((await agent.post('/api/router/ddns').send(ENTRY)).status).toBe(502);
    setup(false);
    const off = await signedInAgent();
    expect((await off.post('/api/router/ddns').send(ENTRY)).status).toBe(403);
  });
});
