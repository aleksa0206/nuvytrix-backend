import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../src/config/db';
import { container, resetContainer } from '../src/container';
import type { DiscoveredHost } from '../src/modules/devices/nmapXmlParser';
import { closeDatabase, prepareDatabase, signedInAgent } from './helpers/testDb';

/** Stands in for nmap: returns whatever the test says the network looks like right now. */
class FakeDiscoverer {
  hosts: DiscoveredHost[] = [];
  targets: string[] = [];
  failWith: string | null = null;
  async discover(target: string) {
    this.targets.push(target);
    if (this.failWith) throw new Error(this.failWith);
    return this.hosts;
  }
}

const router: DiscoveredHost = {
  ipAddress: '192.168.100.1',
  macAddress: 'aa:bb:cc:00:00:01',
  vendor: 'Huawei Technologies',
  hostname: null,
};
const phone: DiscoveredHost = {
  ipAddress: '192.168.100.50',
  macAddress: 'aa:bb:cc:00:00:50',
  vendor: null,
  hostname: 'phone',
};

describe('device discovery', () => {
  let discoverer: FakeDiscoverer;

  beforeEach(async () => {
    await prepareDatabase();
    discoverer = new FakeDiscoverer();
    resetContainer({ hostDiscoverer: discoverer });
  });
  afterAll(async () => {
    resetContainer();
    await closeDatabase();
  });

  async function scan(agent: Awaited<ReturnType<typeof signedInAgent>>, body = {}) {
    const res = await agent.post('/api/discovery/scans').send(body);
    await container.devicesService.waitForActiveScan();
    return res;
  }

  it('scans the first allowed network by default and stores discovered devices', async () => {
    const agent = await signedInAgent();
    discoverer.hosts = [router, phone];

    const res = await scan(agent);

    expect(res.status).toBe(202);
    expect(discoverer.targets).toEqual(['192.168.100.0/24']);
    const finished = await agent.get(`/api/discovery/scans/${res.body.id}`);
    expect(finished.body).toMatchObject({ status: 'completed', hostsUp: 2, newDevices: 2 });

    const list = await agent.get('/api/devices');
    expect(list.body.meta.total).toBe(2);
    expect(list.body.data[0]).toMatchObject({
      ipAddress: '192.168.100.1',
      macAddress: 'aa:bb:cc:00:00:01',
      vendor: 'Huawei Technologies',
      status: 'online',
      isNew: true,
    });
  });

  it('recognizes a device by MAC when its IP changes, keeping the first-seen time', async () => {
    const agent = await signedInAgent();
    discoverer.hosts = [phone];
    await scan(agent);
    const before = await db('devices').first();

    discoverer.hosts = [{ ...phone, ipAddress: '192.168.100.77' }];
    const second = await scan(agent);

    const devices = await db('devices');
    expect(devices).toHaveLength(1);
    expect(devices[0].ip_address).toBe('192.168.100.77');
    expect(devices[0].first_seen_at).toEqual(before.first_seen_at);
    const detail = await agent.get(`/api/devices/${devices[0].id}`);
    expect(detail.body.observations.map((o: { ipAddress: string }) => o.ipAddress)).toEqual([
      '192.168.100.77',
      '192.168.100.50',
    ]);
    expect((await agent.get(`/api/discovery/scans/${second.body.id}`)).body.newDevices).toBe(0);
  });

  it('refuses targets outside the allowed networks without running nmap', async () => {
    const agent = await signedInAgent();

    for (const target of ['10.0.0.0/24', '192.168.0.0/16', '8.8.8.8', '192.168.100.1 -oN']) {
      const res = await agent.post('/api/discovery/scans').send({ target });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('SCAN_TARGET_NOT_ALLOWED');
    }
    const tooLong = await agent
      .post('/api/discovery/scans')
      .send({ target: '192.168.100.1 -oN /x' });
    expect(tooLong.body.code).toBe('VALIDATION_ERROR');
    expect(discoverer.targets).toEqual([]);
  });

  it('allows only one scan at a time', async () => {
    const agent = await signedInAgent();
    let release!: () => void;
    discoverer.discover = async () => {
      await new Promise<void>((resolve) => (release = resolve));
      return [];
    };

    expect((await agent.post('/api/discovery/scans').send({})).status).toBe(202);
    const second = await agent.post('/api/discovery/scans').send({});
    release();
    await container.devicesService.waitForActiveScan();

    expect(second.status).toBe(409);
    expect(second.body.code).toBe('SCAN_ALREADY_RUNNING');
  });

  it('records a failed scan with its reason instead of hiding the error', async () => {
    const agent = await signedInAgent();
    discoverer.failWith = 'nmap timed out';

    const res = await scan(agent);

    const finished = await agent.get(`/api/discovery/scans/${res.body.id}`);
    expect(finished.body).toMatchObject({ status: 'failed', error: 'nmap timed out' });
  });

  it('marks devices offline once they are not seen within the online window', async () => {
    const agent = await signedInAgent();
    discoverer.hosts = [router, phone];
    await scan(agent);
    await db('devices')
      .where({ ip_address: phone.ipAddress })
      .update({ last_seen_at: db.raw(`now() - interval '2 hours'`) });

    const online = await agent.get('/api/devices?status=online');
    const offline = await agent.get('/api/devices?status=offline');

    expect(online.body.data.map((d: { ipAddress: string }) => d.ipAddress)).toEqual([
      '192.168.100.1',
    ]);
    expect(offline.body.data.map((d: { ipAddress: string }) => d.ipAddress)).toEqual([
      '192.168.100.50',
    ]);
  });

  it('searches by name, vendor, IP and MAC, treating wildcards literally', async () => {
    const agent = await signedInAgent();
    discoverer.hosts = [router, phone];
    await scan(agent);

    const search = async (term: string) =>
      (await agent.get('/api/devices').query({ search: term })).body.data.map(
        (d: { ipAddress: string }) => d.ipAddress
      );

    expect(await search('huawei')).toEqual(['192.168.100.1']);
    expect(await search('.50')).toEqual(['192.168.100.50']);
    expect(await search('00:50')).toEqual(['192.168.100.50']);
    expect(await search('%')).toEqual([]);
  });

  it('saves a custom name, type and notes and audits the change', async () => {
    const agent = await signedInAgent();
    discoverer.hosts = [phone];
    await scan(agent);
    const device = await db('devices').first();

    const res = await agent
      .patch(`/api/devices/${device.id}`)
      .send({ customName: 'Aleksa phone', deviceType: 'phone', notes: 'Personal' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      customName: 'Aleksa phone',
      deviceType: 'phone',
      notes: 'Personal',
    });
    expect(await db('audit_logs').where({ action: 'device.updated' }).first()).toBeDefined();
    expect(
      (await agent.patch(`/api/devices/${device.id}`).send({ deviceType: 'toaster' })).status
    ).toBe(400);
    expect((await agent.get('/api/devices/9999')).status).toBe(404);
  });
});
