import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../src/config/db';
import { resetContainer } from '../src/container';
import { parseInternetWan } from '../src/modules/router/huaweiParser';
import {
  HuaweiWebClient,
  type FormSubmission,
  type RouterPage,
} from '../src/modules/router/huaweiWebClient';
import { UpnpClient } from '../src/modules/router/upnpClient';
import { closeDatabase, prepareDatabase, signedInAgent } from './helpers/testDb';

const x = (value: string) => value.replace(/[.:]/g, (c) => (c === '.' ? '\\x2e' : '\\x3a'));
const WAN = 'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.3.WANIPConnection.1';

/** A WanIP call with the fields the parser reads; the rest are filler (and a fake WAN secret). */
function wanIp(domain: string, mode: string, services: string, ipv4 = '1') {
  const args = Array.from({ length: 60 }, () => '');
  args[0] = domain;
  args[7] = 'name';
  args[12] = mode;
  args[25] = services;
  args[29] = ipv4;
  args[51] = 'secret-ipoe-password';
  return `new WanIP(${args.map((a) => JSON.stringify(a)).join(',')})`;
}

const WAN_LIST =
  `var IPWanList = new Array(` +
  `${wanIp('InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANIPConnection.1', 'IP_Routed', 'TR069')},` +
  `${wanIp(WAN, 'IP_Routed', 'INTERNET')},` +
  `${wanIp('InternetGatewayDevice.WANDevice.1.WANConnectionDevice.4.WANIPConnection.1', 'IP_Routed', 'VOIP')},null);`;

interface Mapping {
  enabled: string;
  name: string;
  host: string;
  remoteStart: string;
  remoteEnd: string;
  ranges: Map<number, { protocol: string; internal: string; external: string }>;
}

/** Router stand-in for portmappingnew.asp and its ajax CGIs. */
class PortRouter extends HuaweiWebClient {
  mappings = new Map<number, Mapping>();
  next = 1;
  ignoreWrites = false;
  submissions: FormSubmission[] = [];

  constructor() {
    super({ baseUrl: 'http://router.test', username: 'admin', password: 'x' });
  }

  render(page: RouterPage): string {
    if (page === 'wanList') return WAN_LIST;
    const maps: string[] = [];
    const lists: string[] = [];
    for (const [i, m] of this.mappings) {
      const domain = `${WAN}.PortMapping.${i}`;
      maps.push(
        `new stPortMap("${domain}","${m.enabled}","${x(m.remoteStart)}","${x(m.remoteEnd)}","","${x(m.host)}","${m.name}","")`
      );
      for (const [j, r] of m.ranges) {
        lists.push(
          `new stPortMappingPortList("${domain}.X_HW_Portlist.${j}","${r.protocol}","${r.internal}","${x(r.external)}","")`
        );
      }
    }
    return (
      `var LanIpInfos = new Array(new stipaddr("InternetGatewayDevice.LANDevice.1.LANHostConfigManagement.IPInterface.1","1","${x('192.168.100.1')}","${x('255.255.255.0')}"),null);\n` +
      `function stPortMap(domain,ProtMapEnabled,RemoteHost,RemoteHostRange,OperateRule,InClient,Description,ExternalIP) {}\n` +
      `var WanIPPortMappingPortList = new Array(${[...lists, 'null'].join(',')});\n` +
      `var WanIPPortMapping = new Array(${[...maps, 'null'].join(',')});`
    );
  }

  override async fetchPages<T extends RouterPage>(names: readonly T[]) {
    return Object.fromEntries(names.map((name) => [name, this.render(name)])) as Record<T, string>;
  }

  override async submitForm(form: FormSubmission) {
    this.submissions.push(form);
    const f = form.fields;
    if (!this.ignoreWrites) {
      const mapping = (k: string, ranges: Mapping['ranges']): Mapping => ({
        enabled: f[`${k}.PortMappingEnabled`]!,
        name: f[`${k}.PortMappingDescription`]!,
        host: f[`${k}.InternalClient`]!,
        remoteStart: f[`${k}.RemoteHost`]!,
        remoteEnd: f[`${k}.X_HW_RemoteHostRange`]!,
        ranges,
      });
      const range = (k: string) => ({
        protocol: f[`${k}.Protocol`]!,
        internal: f[`${k}.InternalPort`]!,
        external: f[`${k}.ExternalPort`]!,
      });
      if (form.action === 'addcfgajax') {
        this.mappings.set(this.next++, mapping('GROUP_a_x', new Map([[1, range('GROUP_a_ya')]])));
      } else if (form.action === 'complexajax') {
        const index = Number(form.object!.split('.').pop());
        const rangeIndex = Number(form.extraQuery!.ma!.split('.').pop());
        this.mappings.set(index, mapping('x', new Map([[rangeIndex, range('ma')]])));
      } else {
        for (const key of Object.keys(f)) this.mappings.delete(Number(key.split('.').pop()));
      }
    }
    return this.render(form.page);
  }
}

const MAPPING = {
  name: 'Game server',
  enabled: true,
  protocol: 'TCP',
  internalHost: '192.168.100.50',
  internalPort: 25565,
  externalPortStart: 25565,
  externalPortEnd: 25565,
};
let router: PortRouter;

function setup(writesEnabled = true) {
  router = new PortRouter();
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

describe('internet WAN parsing', () => {
  it('picks the routed IPv4 WAN with internet service and copies nothing else', () => {
    expect(parseInternetWan(WAN_LIST)).toBe(WAN);
    expect(parseInternetWan(WAN_LIST.replace('"INTERNET"', '"OTHER"'))).toBeNull();
  });
});

describe('router port mapping management', () => {
  beforeEach(async () => {
    await prepareDatabase();
    setup();
  });

  it('reads the mappings and the internet WAN, without WAN account fields', async () => {
    const agent = await signedInAgent();
    const res = await agent.get('/api/router/port-mappings');
    expect(res.body).toEqual({ writesEnabled: true, internetWan: WAN, mappings: [] });
    expect(JSON.stringify(res.body)).not.toContain('secret');
  });

  it('refuses writes while ROUTER_WRITES_ENABLED is off', async () => {
    setup(false);
    const agent = await signedInAgent();
    expect((await agent.post('/api/router/port-mappings').send(MAPPING)).status).toBe(403);
    expect(router.submissions).toHaveLength(0);
  });

  it('adds a mapping with the page ajax request and audits it', async () => {
    const agent = await signedInAgent();

    const res = await agent.post('/api/router/port-mappings').send(MAPPING);

    expect(res.status).toBe(201);
    expect(res.body.mapping).toMatchObject({
      domain: `${WAN}.PortMapping.1`,
      name: 'Game server',
      internalHost: '192.168.100.50',
      ranges: [{ protocol: 'TCP', internalPort: '25565', externalPort: '25565:25565' }],
    });
    expect(router.submissions[0]).toMatchObject({
      action: 'addcfgajax',
      objectKey: 'GROUP_a_x',
      object: `${WAN}.PortMapping`,
      extraQuery: { GROUP_a_ya: 'GROUP_a_x.X_HW_Portlist' },
      fields: {
        'GROUP_a_x.PortMappingEnabled': '1',
        'GROUP_a_x.InternalClient': '192.168.100.50',
        'GROUP_a_ya.ExternalPort': '25565:25565',
      },
    });
    const audit = await db('audit_logs').where({ action: 'router.port_mapping_created' }).first();
    expect(audit.details.outcome).toBe('applied');
  });

  it('changes a mapping in place and deletes it, keeping it in the audit log', async () => {
    const agent = await signedInAgent();
    await agent.post('/api/router/port-mappings').send(MAPPING);

    const put = await agent
      .put('/api/router/port-mappings/1')
      .send({ ...MAPPING, enabled: false, protocol: 'UDP', externalPortEnd: 25570 });
    const del = await agent.delete('/api/router/port-mappings/1');

    expect(put.status).toBe(200);
    expect(put.body.mapping).toMatchObject({ enabled: false });
    expect(router.submissions[1]).toMatchObject({
      action: 'complexajax',
      object: `${WAN}.PortMapping.1`,
      extraQuery: { ma: `${WAN}.PortMapping.1.X_HW_Portlist.1` },
      fields: { 'ma.Protocol': 'UDP', 'ma.ExternalPort': '25565:25570' },
    });
    expect(del.body).toEqual([]);
    expect(router.submissions[2]).toMatchObject({
      action: 'del',
      fields: { [`${WAN}.PortMapping.1`]: '' },
    });
    const audit = await db('audit_logs').where({ action: 'router.port_mapping_deleted' }).first();
    expect(audit.details.before).toMatchObject({ name: 'Game server' });
  });

  it.each([
    ['the router itself', { ...MAPPING, internalHost: '192.168.100.1' }],
    ['outside the LAN', { ...MAPPING, internalHost: '10.0.0.5' }],
    ['the broadcast address', { ...MAPPING, internalHost: '192.168.100.255' }],
  ])('refuses forwarding to %s', async (_label, input) => {
    const agent = await signedInAgent();
    expect((await agent.post('/api/router/port-mappings').send(input)).status).toBe(422);
    expect(router.submissions).toHaveLength(0);
  });

  it('refuses external ports another mapping uses with the same protocol', async () => {
    const agent = await signedInAgent();
    await agent
      .post('/api/router/port-mappings')
      .send({ ...MAPPING, externalPortStart: 25560, externalPortEnd: 25570 });

    const clash = await agent
      .post('/api/router/port-mappings')
      .send({ ...MAPPING, name: 'Other', protocol: 'TCP/UDP' });
    const udpOnly = await agent
      .post('/api/router/port-mappings')
      .send({ ...MAPPING, name: 'Voice', protocol: 'UDP' });

    expect(clash.status).toBe(422);
    expect(udpOnly.status).toBe(201);
  });

  it.each([
    [{ ...MAPPING, externalPortEnd: 100 }, 'externalPortEnd'],
    [{ ...MAPPING, internalPort: 70000 }, 'internalPort'],
    [{ ...MAPPING, protocol: 'ICMP' }, 'protocol'],
    [{ ...MAPPING, name: '' }, 'name'],
    [{ ...MAPPING, remoteHostEnd: '1.2.3.4' }, 'remoteHostEnd'],
  ])('rejects invalid input %#', async (input, path) => {
    const agent = await signedInAgent();
    const res = await agent.post('/api/router/port-mappings').send(input);
    expect(res.status).toBe(400);
    expect(res.body.details.map((d: { path: string }) => d.path)).toContain(path);
  });

  it('does not edit a mapping with several port ranges', async () => {
    router.mappings.set(1, {
      enabled: '1',
      name: 'Multi',
      host: '192.168.100.50',
      remoteStart: '',
      remoteEnd: '',
      ranges: new Map([
        [1, { protocol: 'TCP', internal: '80', external: '80:80' }],
        [2, { protocol: 'TCP', internal: '443', external: '443:443' }],
      ]),
    });
    const agent = await signedInAgent();
    const res = await agent.put('/api/router/port-mappings/1').send(MAPPING);
    expect(res.status).toBe(422);
    expect((await agent.delete('/api/router/port-mappings/1')).status).toBe(200);
  });

  it('reports a mapping the router did not create', async () => {
    router.ignoreWrites = true;
    const agent = await signedInAgent();
    const res = await agent.post('/api/router/port-mappings').send(MAPPING);
    expect(res.status).toBe(502);
  });

  it('returns 404 for a mapping that is not on the router', async () => {
    const agent = await signedInAgent();
    expect((await agent.delete('/api/router/port-mappings/4')).status).toBe(404);
  });
});
