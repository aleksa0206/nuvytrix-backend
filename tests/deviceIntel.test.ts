import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../src/config/db';
import { container, resetContainer } from '../src/container';
import type { DiscoveredHost } from '../src/modules/devices/nmapXmlParser';
import type { RouterDevice } from '../src/modules/router/huaweiParser';
import { closeDatabase, prepareDatabase, signedInAgent } from './helpers/testDb';

class FakeDiscoverer {
  hosts: DiscoveredHost[] = [];
  async discover() {
    return this.hosts;
  }
}

const phone: DiscoveredHost = {
  ipAddress: '192.168.100.50',
  macAddress: 'aa:bb:cc:00:00:50',
  vendor: 'Apple',
  hostname: 'phone',
};

const routerDevice = (over: Partial<RouterDevice>): RouterDevice => ({
  macAddress: 'aa:bb:cc:00:00:50',
  ipAddress: '192.168.100.50',
  hostName: 'phone',
  online: true,
  connection: 'wifi',
  port: 'SSID5',
  addressSource: 'DHCP',
  dhcpVendorClass: null,
  onlineDuration: null,
  leaseRemainingSeconds: 3600,
  ...over,
});

const alertTitles = async () =>
  (await container.alertsService.list()).alerts.map((a) => a.title).reverse();

let discoverer: FakeDiscoverer;

async function scan() {
  await container.devicesService.startScan(undefined, null);
  await container.devicesService.waitForActiveScan();
}

afterAll(async () => {
  resetContainer();
  await closeDatabase();
});

describe('device intelligence', () => {
  beforeEach(async () => {
    await prepareDatabase();
    discoverer = new FakeDiscoverer();
    resetContainer({ hostDiscoverer: discoverer });
  });

  it('records IP and hostname changes from scans in the device history', async () => {
    discoverer.hosts = [phone];
    await scan();
    discoverer.hosts = [{ ...phone, ipAddress: '192.168.100.77', hostname: 'phone-2' }];
    await scan();

    const device = await db('devices').first();
    const agent = await signedInAgent();
    const { body } = await agent.get(`/api/devices/${device.id}`);
    expect(body.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'ip_changed',
          oldValue: '192.168.100.50',
          newValue: '192.168.100.77',
        }),
        expect.objectContaining({
          kind: 'hostname_changed',
          oldValue: 'phone',
          newValue: 'phone-2',
        }),
      ])
    );
  });

  it('warns when a recently used IP answers from a different MAC', async () => {
    discoverer.hosts = [phone];
    await scan();
    discoverer.hosts = [
      { ...phone, macAddress: 'de:ad:be:ef:00:01', hostname: null, vendor: null },
    ];
    await scan();

    expect(await alertTitles()).toEqual([
      'New device on the network: phone',
      'New device on the network: 192.168.100.50',
      '192.168.100.50 now answers from a different device',
    ]);
    const events = await db('device_events').where({ kind: 'mac_changed' });
    expect(events[0]).toMatchObject({
      old_value: 'aa:bb:cc:00:00:50',
      new_value: 'de:ad:be:ef:00:01',
    });
  });

  it('updates devices from the router list: DHCP details, reservation, presence, new devices', async () => {
    discoverer.hosts = [phone];
    await scan();

    const created = await container.deviceIntelService.syncFromRouter(
      [
        routerDevice({ ipAddress: '192.168.100.51' }),
        routerDevice({
          macAddress: 'aa:bb:cc:00:00:60',
          ipAddress: '192.168.100.60',
          hostName: 'tv',
          connection: 'ethernet',
        }),
        routerDevice({
          macAddress: 'aa:bb:cc:00:00:70',
          ipAddress: '192.168.100.70',
          online: false,
        }),
      ],
      [{ domain: 'd', enabled: true, ip: '192.168.100.51', mac: 'aa:bb:cc:00:00:50' }]
    );

    expect(created.map((d) => d.hostname)).toEqual(['tv']);
    const phoneRow = await db('devices').where({ mac_address: 'aa:bb:cc:00:00:50' }).first();
    expect(phoneRow).toMatchObject({
      ip_address: '192.168.100.51',
      address_source: 'dhcp',
      reserved_ip: '192.168.100.51',
      connection: 'wifi',
    });
    expect(phoneRow.lease_expires_at.getTime()).toBeGreaterThan(Date.now());
    expect(await db('devices').where({ mac_address: 'aa:bb:cc:00:00:70' })).toHaveLength(0);
    expect(await db('device_presence').count({ n: '*' }).first()).toEqual({ n: 2 });

    const agent = await signedInAgent();
    const presence = await agent.get(`/api/devices/${phoneRow.id}/presence?days=1`);
    expect(presence.body.points).toEqual([expect.objectContaining({ onlineShare: 1, samples: 1 })]);
    expect(await alertTitles()).toContain('New device on the network: tv');
  });

  it('gives the MAC-less server record its MAC from the router instead of a duplicate', async () => {
    resetContainer({ hostDiscoverer: discoverer, ownAddresses: ['192.168.100.27'] });
    const server = {
      ipAddress: '192.168.100.27',
      macAddress: null,
      vendor: null,
      hostname: 'aleksa',
    };
    discoverer.hosts = [server];
    await scan();
    await container.deviceIntelService.syncFromRouter(
      [
        routerDevice({
          macAddress: '78:84:3c:04:c3:14',
          ipAddress: '192.168.100.27',
          hostName: 'aleksa',
        }),
      ],
      null
    );
    await scan();

    const rows = await db('devices');
    expect(rows).toHaveLength(1);
    expect(rows[0].mac_address).toBe('78:84:3c:04:c3:14');
    expect(await alertTitles()).toEqual(['New device on the network: aleksa']);
  });

  it('never lets another device take over a record on the same IP', async () => {
    const stranger = {
      ipAddress: '192.168.100.80',
      macAddress: null,
      vendor: null,
      hostname: null,
    };
    discoverer.hosts = [stranger];
    await scan();
    await db('devices').update({ trusted: true });
    await container.deviceIntelService.syncFromRouter(
      [routerDevice({ macAddress: 'de:ad:be:ef:00:80', ipAddress: '192.168.100.80' })],
      null
    );

    const rows = await db('devices').orderBy('id');
    expect(rows.map((r) => [r.mac_address, r.trusted])).toEqual([
      [null, true],
      ['de:ad:be:ef:00:80', null],
    ]);
  });

  it('reports an IP conflict between two online devices once', async () => {
    const list = [
      routerDevice({ macAddress: 'aa:bb:cc:00:00:01', ipAddress: '192.168.100.90' }),
      routerDevice({ macAddress: 'aa:bb:cc:00:00:02', ipAddress: '192.168.100.90' }),
    ];
    await container.deviceIntelService.syncFromRouter(list, null);
    await container.deviceIntelService.syncFromRouter(list, null);

    const conflicts = (await alertTitles()).filter((t) => t.startsWith('IP conflict'));
    expect(conflicts).toEqual(['IP conflict: 192.168.100.90 is used by 2 devices']);
  });

  it('saves tags and trust, filters by them, and validates tags', async () => {
    discoverer.hosts = [
      phone,
      { ...phone, macAddress: 'aa:bb:cc:00:00:51', ipAddress: '192.168.100.51' },
    ];
    await scan();
    const [first] = await db('devices').orderBy('id');
    const agent = await signedInAgent();

    const patched = await agent
      .patch(`/api/devices/${first.id}`)
      .send({ tags: ['Family', 'phone', 'family'], trusted: true });
    expect(patched.body).toMatchObject({ tags: ['family', 'phone'], trusted: true });

    const trusted = await agent.get('/api/devices?trust=trusted');
    expect(trusted.body.data.map((d: { id: number }) => d.id)).toEqual([first.id]);
    expect((await agent.get('/api/devices?trust=unreviewed')).body.meta.total).toBe(1);
    expect((await agent.get('/api/devices?tag=family')).body.meta.total).toBe(1);
    const bad = await agent.patch(`/api/devices/${first.id}`).send({ tags: ['no spaces'] });
    expect(bad.status).toBe(400);
  });
});
