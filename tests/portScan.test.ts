import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../src/config/db';
import { container, resetContainer } from '../src/container';
import { parsePortScanXml, type OpenPort } from '../src/modules/devices/portScan.service';
import { closeDatabase, prepareDatabase, signedInAgent } from './helpers/testDb';

class FakeScanner {
  ports = new Map<string, OpenPort[]>();
  scanned: string[][] = [];
  async scan(ips: string[]) {
    this.scanned.push(ips);
    return new Map(ips.filter((ip) => this.ports.has(ip)).map((ip) => [ip, this.ports.get(ip)!]));
  }
}

const ssh = (version: string): OpenPort => ({
  protocol: 'tcp',
  port: 22,
  service: 'ssh',
  product: 'OpenSSH',
  version,
});
const http: OpenPort = {
  protocol: 'tcp',
  port: 80,
  service: 'http',
  product: 'nginx',
  version: null,
};

let scanner: FakeScanner;

async function addDevice(ip: string, tags: string[] = []) {
  const [row] = await db('devices')
    .insert({
      ip_address: ip,
      mac_address: `aa:bb:cc:00:00:${ip.split('.').pop()!.padStart(2, '0')}`,
      first_seen_at: db.fn.now(),
      last_seen_at: db.fn.now(),
      tags,
    })
    .returning('id');
  return row.id as number;
}

async function scanAll() {
  const agent = await signedInAgent();
  const res = await agent.post('/api/port-scans').send({});
  await container.portScanService.waitForScan();
  return res;
}

const alertTitles = async () =>
  (await container.alertsService.list()).alerts.map((a) => a.title).reverse();

afterAll(async () => {
  resetContainer();
  await closeDatabase();
});

describe('port scans', () => {
  beforeEach(async () => {
    await prepareDatabase();
    scanner = new FakeScanner();
    resetContainer({ portScanner: scanner });
  });

  it('parses open ports with service and version from nmap XML', () => {
    const xml = `<?xml version="1.0"?><nmaprun><host><address addr="192.168.100.27" addrtype="ipv4"/>
      <ports><port protocol="tcp" portid="22"><state state="open"/><service name="ssh" product="OpenSSH" version="9.6p1"/></port>
      <port protocol="tcp" portid="25"><state state="closed"/></port></ports></host></nmaprun>`;
    expect(parsePortScanXml(xml).get('192.168.100.27')).toEqual([
      { protocol: 'tcp', port: 22, service: 'ssh', product: 'OpenSSH', version: '9.6p1' },
    ]);
  });

  it('takes the first scan as baseline, then reports opened, closed and changed services', async () => {
    const id = await addDevice('192.168.100.27');
    scanner.ports.set('192.168.100.27', [ssh('9.6p1')]);
    expect((await scanAll()).status).toBe(202);
    expect(await alertTitles()).toEqual([]);

    scanner.ports.set('192.168.100.27', [ssh('9.7p1'), http]);
    await scanAll();
    scanner.ports.set('192.168.100.27', [ssh('9.7p1')]);
    await scanAll();

    expect(await alertTitles()).toEqual([
      'Service changed on 192.168.100.27 port 22: ssh OpenSSH 9.6p1 → ssh OpenSSH 9.7p1',
      'New open port on 192.168.100.27: 80/tcp http nginx',
      'Port closed on 192.168.100.27: 80/tcp',
    ]);
    const agent = await signedInAgent();
    const { body } = await agent.get(`/api/devices/${id}/ports`);
    expect(
      body.ports.map((p: { port: number; closedAt: string | null }) => [
        p.port,
        p.closedAt === null,
      ])
    ).toEqual([
      [22, true],
      [80, false],
    ]);
    const audit = await db('audit_logs').where({ action: 'port_scan.started' });
    expect(audit).toHaveLength(3);
  });

  it('skips devices tagged no-scan and devices outside the allowed networks, and keeps ports of hosts that did not answer', async () => {
    await addDevice('192.168.100.40', ['no-scan']);
    await addDevice('10.0.0.5');
    const answering = await addDevice('192.168.100.41');
    scanner.ports.set('192.168.100.41', [http]);
    await scanAll();
    expect(scanner.scanned).toEqual([['192.168.100.41']]);

    scanner.ports.delete('192.168.100.41');
    await scanAll();
    const open = await db('device_ports').where({ device_id: answering }).whereNull('closed_at');
    expect(open).toHaveLength(1);
  });

  it('stores a port whose service banner is too long without losing the alert', async () => {
    await addDevice('192.168.100.27');
    scanner.ports.set('192.168.100.27', [ssh('1')]);
    await scanAll();
    const banner = 'x'.repeat(128);
    scanner.ports.set('192.168.100.27', [
      ssh('1'),
      { protocol: 'tcp', port: 8080, service: 'http', product: banner, version: 'y'.repeat(64) },
    ]);
    await scanAll();
    const event = await db('device_events').where({ kind: 'port_opened' }).first();
    expect(event.new_value.length).toBeLessThanOrEqual(255);
    expect((await alertTitles())[0]).toContain('New open port on 192.168.100.27: 8080/tcp');
  });

  it('refuses a second scan while one is running', async () => {
    await addDevice('192.168.100.27');
    let release!: () => void;
    scanner.scan = async () => {
      await new Promise<void>((resolve) => (release = resolve));
      return new Map();
    };
    const agent = await signedInAgent();
    expect((await agent.post('/api/port-scans').send({})).status).toBe(202);
    expect((await agent.post('/api/port-scans').send({})).status).toBe(409);
    release();
    await container.portScanService.waitForScan();
  });
});
