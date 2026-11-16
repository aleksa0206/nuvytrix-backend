import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../src/config/db';
import { container, resetContainer } from '../src/container';
import { HuaweiWebClient, type RouterPage } from '../src/modules/router/huaweiWebClient';
import { UpnpClient, parseSoapValues, type WanStatus } from '../src/modules/router/upnpClient';
import {
  DEVICES_PAGE,
  DEVICE_INFO_PAGE,
  ETH_PAGE,
  FIREWALL_LOG_PAGE,
  IP_FILTER_PAGE,
  OPTIC_PAGE,
  WIFI_CLIENTS_PAGE,
  WLAN_PAGE,
} from './fixtures/huawei';
import { closeDatabase, prepareDatabase, signedInAgent } from './helpers/testDb';

const PAGES: Record<RouterPage, string> = {
  systemInfo: DEVICE_INFO_PAGE,
  optical: OPTIC_PAGE,
  ethernet: ETH_PAGE,
  wlan: WLAN_PAGE,
  wifiClients: WIFI_CLIENTS_PAGE,
  devices: DEVICES_PAGE,
  firewallLog: FIREWALL_LOG_PAGE,
  ipFilter: IP_FILTER_PAGE,
  dhcpServer: '',
  dhcpStatic: '',
  macFilter: '',
  wifiMacFilter: '',
  portMapping: '',
  wanList: '',
  dmz: '',
  portTrigger: '',
  wifi: '',
  parental: '',
  parentalInfo: '',
  dnsHosts: '',
  dnsHostsData: '',
  ddns: '',
  upnp: '',
  wifiSchedule: '',
  wifiAdvanced: '',
  led: '',
};

class FakeWeb extends HuaweiWebClient {
  constructor(private pages = PAGES) {
    super({ baseUrl: 'http://router.test', username: 'admin', password: 'x' });
  }
  override async fetchPages<T extends RouterPage>(names: readonly T[]) {
    return Object.fromEntries(names.map((name) => [name, this.pages[name]])) as Record<T, string>;
  }
}

class FakeUpnp extends UpnpClient {
  bytesReceived = 1_000_000;
  constructor() {
    super({ baseUrl: 'http://router.test', wanCommonControl: '/c', wanIpControl: '/i' });
  }
  override async getWanStatus(): Promise<WanStatus> {
    return {
      connected: true,
      connectionStatus: 'Connected',
      uptimeSeconds: 100,
      externalIp: '100.64.1.2',
      natEnabled: true,
      bytesSent: 500_000,
      bytesReceived: this.bytesReceived,
      packetsSent: 10,
      packetsReceived: 20,
    };
  }
  override async getPortMappings() {
    return [];
  }
}

afterAll(async () => {
  resetContainer();
  await closeDatabase();
});

describe('UPnP SOAP parsing', () => {
  it('reads New* values from a response envelope', () => {
    const xml =
      '<s:Envelope><s:Body><u:GetStatusInfoResponse><NewConnectionStatus>Connected</NewConnectionStatus>' +
      '<NewUptime>94925</NewUptime><NewPortMappingDescription>A &amp; B</NewPortMappingDescription>' +
      '</u:GetStatusInfoResponse></s:Body></s:Envelope>';
    expect(parseSoapValues(xml)).toEqual({
      NewConnectionStatus: 'Connected',
      NewUptime: '94925',
      NewPortMappingDescription: 'A & B',
    });
  });
});

describe('router integration', () => {
  let upnp: FakeUpnp;

  beforeEach(async () => {
    await prepareDatabase();
    upnp = new FakeUpnp();
    resetContainer({ routerWebClient: new FakeWeb(), upnpClient: upnp });
  });

  it('reports not configured without credentials', async () => {
    resetContainer({
      routerWebClient: new HuaweiWebClient({ baseUrl: 'http://x', username: '', password: '' }),
      upnpClient: upnp,
    });
    const agent = await signedInAgent();

    expect((await agent.get('/api/router/status')).body).toEqual({
      configured: false,
      host: null,
    });
  });

  it('polls the router into a status snapshot and stores a sample', async () => {
    (container.routerService as unknown as { settings: { host: string } }).settings.host =
      '192.168.100.1';
    const agent = await signedInAgent();

    const res = await agent.post('/api/router/refresh');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      configured: true,
      system: { model: 'HN8546X6', cpuPercent: 3 },
      optical: { rxPowerDbm: -17.1 },
      wan: { connected: true, externalIp: '100.64.1.2' },
      ipFilter: { enabled: true, mode: 'blacklist' },
      devicesOnline: 2,
      devicesKnown: 3,
      wifiClients: 1,
      errors: [],
    });
    expect(res.body.lanPorts[0]).toMatchObject({ port: 1, speedMbps: 1000 });
    expect(await db('router_samples').count('* as count').first()).toEqual({ count: 1 });
  });

  it('merges router clients with Wi-Fi radio data and known Nuvytrix devices', async () => {
    (container.routerService as unknown as { settings: { host: string } }).settings.host =
      '192.168.100.1';
    const [device] = await db('devices')
      .insert({
        mac_address: 'aa:bb:cc:00:00:31',
        ip_address: '192.168.100.31',
        custom_name: 'Phone',
        first_seen_at: db.fn.now(),
        last_seen_at: db.fn.now(),
      })
      .returning('id');
    await container.routerService.poll();
    const agent = await signedInAgent();

    const { body } = await agent.get('/api/router/clients');

    const phone = body.clients.find(
      (c: { macAddress: string }) => c.macAddress === 'aa:bb:cc:00:00:31'
    );
    expect(phone).toMatchObject({
      deviceId: device.id,
      customName: 'Phone',
      port: 'SSID5',
      connection: 'wifi',
      wifi: { rssiDbm: -65, band: '5 GHz' },
    });
  });

  it('computes WAN rates from consecutive samples and ignores counter resets', async () => {
    (container.routerService as unknown as { settings: { host: string } }).settings.host =
      '192.168.100.1';
    const base = Date.now() - 60_000;
    await container.routerService.poll();
    upnp.bytesReceived = 2_250_000;
    await container.routerService.poll();
    upnp.bytesReceived = 100;
    await container.routerService.poll();
    const ids = (await db('router_samples').orderBy('id').select('id')).map((row) => row.id);
    for (const [index, offset] of [0, 10_000, 15_000].entries()) {
      await db('router_samples')
        .where('id', ids[index])
        .update({ captured_at: new Date(base + offset) });
    }

    const history = await container.routerService.getHistory(1);

    expect(history.points.map((p) => p.wanDownloadBps)).toEqual([null, 1_000_000, null]);
  });

  it('computes LAN-side rates from the sum of LAN port and Wi-Fi counters', async () => {
    const base = Date.now() - 60_000;
    await container.routerService.poll();
    await container.routerService.poll();
    const ids = (await db('router_samples').orderBy('id').select('id')).map((row) => row.id);
    const counters = (sent: number) => ({
      lan_ports: JSON.stringify([{ bytesSent: sent, bytesReceived: 0 }]),
      wlan: JSON.stringify([
        { bytesSent: sent, bytesReceived: 0 },
        { bytesSent: 0, bytesReceived: 0 },
      ]),
    });
    await db('router_samples')
      .where('id', ids[0])
      .update({ captured_at: new Date(base), ...counters(1_000_000) });
    await db('router_samples')
      .where('id', ids[1])
      .update({ captured_at: new Date(base + 10_000), ...counters(1_625_000) });

    const history = await container.routerService.getHistory(1);

    // (2 × 625 000 bytes × 8) / 10 s
    expect(history.points.map((p) => p.lanDownloadBps)).toEqual([null, 1_000_000]);
    expect(history.points.map((p) => p.lanUploadBps)).toEqual([null, 0]);
  });

  it('imports the router firewall log once and skips repeated reads of the same log', async () => {
    const first = await container.routerService.importFirewallLog();
    const second = await container.routerService.importFirewallLog();

    expect(first).toMatchObject({ insertedEvents: 1, rejectedLines: 0 });
    expect(second).toBeNull();
    expect(await db('firewall_log_imports').count('* as count').first()).toEqual({ count: 1 });
    expect(await db('firewall_events').count('* as count').first()).toEqual({ count: 1 });
  });
});
