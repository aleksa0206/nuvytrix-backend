import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../src/config/db';
import { container, resetContainer } from '../src/container';
import {
  HuaweiWebClient,
  type FormSubmission,
  type RouterPage,
} from '../src/modules/router/huaweiWebClient';
import { UpnpClient } from '../src/modules/router/upnpClient';
import { DEVICES_PAGE, WLAN_PAGE } from './fixtures/huawei';
import { closeDatabase, prepareDatabase, signedInAgent } from './helpers/testDb';

const x = (value: string) => value.replace(/[.:]/g, (c) => (c === '.' ? '\\x2e' : '\\x3a'));
const SEC = 'InternetGatewayDevice.X_HW_Security';

interface Entry {
  mac: string;
  name: string;
  ssid: string;
}

/** One MAC filter list as the router keeps and renders it. */
class List {
  enabled = '0';
  mode = '0';
  entries = new Map<number, Entry>();
  next = 1;
}

/** Router stand-in for macfilter.asp and wlanmacfilter.asp. */
class MacRouter extends HuaweiWebClient {
  lists = { macFilter: new List(), wifiMacFilter: new List() };
  ignoreWrites = false;
  submissions: FormSubmission[] = [];

  constructor() {
    super({ baseUrl: 'http://router.test', username: 'admin', password: 'x' });
  }

  render(page: RouterPage): string {
    if (page === 'devices') return DEVICES_PAGE;
    if (page === 'wlan') return WLAN_PAGE;
    const list = this.lists[page as keyof MacRouter['lists']];
    const wifi = page === 'wifiMacFilter';
    const rows = [...list.entries.entries()].map(([i, e]) =>
      wifi
        ? `new stMacFilter("${SEC}.WLANMacFilter.${i}","${e.ssid}","${e.name}","${x(e.mac)}")`
        : `new stMacFilter("${SEC}.MacFilter.${i}","${x(e.mac)}","${e.name}")`
    );
    return (
      `var enableFilter = '${list.enabled}';\nvar Mode = '${list.mode}';\n` +
      `function stMacFilter(domain) {}\nvar MacFilter = new Array(${[...rows, 'null'].join(',')});`
    );
  }

  override async fetchPages<T extends RouterPage>(names: readonly T[]) {
    return Object.fromEntries(names.map((name) => [name, this.render(name)])) as Record<T, string>;
  }

  override async submitForm(form: FormSubmission) {
    this.submissions.push(form);
    const list = this.lists[form.page as keyof MacRouter['lists']];
    const f = form.fields;
    const entry = () => ({
      mac: f['x.SourceMACAddress']!,
      name: f['x.DeviceAlias'] ?? f['x.DeviceName']!,
      ssid: f['x.SSIDName'] ?? '',
    });
    if (!this.ignoreWrites) {
      if (form.action === 'add') list.entries.set(list.next++, entry());
      else if (form.action === 'set' && form.object === SEC) {
        list.enabled = f['x.MacFilterRight'] ?? f['x.WlanMacFilterRight']!;
      } else if (form.action === 'set')
        list.entries.set(Number(form.object!.split('.').pop()), entry());
      else for (const key of Object.keys(f)) list.entries.delete(Number(key.split('.').pop()));
    }
    return this.render(form.page);
  }
}

const ENTRY = { mac: '02:4E:56:00:00:01', name: 'Test phone' };
let router: MacRouter;

function setup(writesEnabled = true) {
  router = new MacRouter();
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
    routerMacFilterService: { settings: { protectedAddresses: string[] } };
  };
  // aa:bb:cc:00:00:20 holds .20 in the device fixture.
  internals.routerMacFilterService.settings.protectedAddresses = ['192.168.100.20'];
}

afterAll(async () => {
  resetContainer();
  await closeDatabase();
});

describe('router MAC filter management', () => {
  beforeEach(async () => {
    await prepareDatabase();
    setup();
  });

  it('reads both lists and the active Wi-Fi networks', async () => {
    const agent = await signedInAgent();
    const { body } = await agent.get('/api/router/mac-filter');
    expect(body).toMatchObject({
      writesEnabled: true,
      lan: { enabled: false, mode: 'blacklist', entries: [] },
      wifi: { enabled: false, mode: 'blacklist', entries: [] },
      wifiNetworks: [
        { id: 'SSID-1', ssid: 'Home Net', band: '2.4 GHz' },
        { id: 'SSID-5', ssid: 'Home Net 5g', band: '5 GHz' },
      ],
    });
  });

  it('refuses writes while ROUTER_WRITES_ENABLED is off', async () => {
    setup(false);
    const agent = await signedInAgent();
    const res = await agent.post('/api/router/mac-filter/lan/entries').send(ENTRY);
    expect(res.status).toBe(403);
    expect(router.submissions).toHaveLength(0);
  });

  it('adds, renames and deletes a LAN entry with the router form fields', async () => {
    const agent = await signedInAgent();

    const add = await agent.post('/api/router/mac-filter/lan/entries').send(ENTRY);
    const put = await agent
      .put('/api/router/mac-filter/lan/entries/1')
      .send({ ...ENTRY, name: 'Old phone' });
    const del = await agent.delete('/api/router/mac-filter/lan/entries/1');

    expect(add.status).toBe(201);
    expect(add.body.entry).toMatchObject({ mac: '02:4e:56:00:00:01', name: 'Test phone' });
    expect(router.submissions[0]).toMatchObject({
      page: 'macFilter',
      action: 'add',
      object: `${SEC}.MacFilter`,
      fields: { 'x.SourceMACAddress': '02:4e:56:00:00:01', 'x.DeviceAlias': 'Test phone' },
    });
    expect(put.body.entry.name).toBe('Old phone');
    expect(del.status).toBe(200);
    expect(del.body.entries).toEqual([]);
    expect(router.submissions[2]).toMatchObject({
      action: 'del',
      object: `${SEC}.MacFilter`,
      fields: { [`${SEC}.MacFilter.1`]: '' },
    });
    const audit = await db('audit_logs')
      .where({ action: 'router.mac_filter_entry_deleted' })
      .first();
    expect(audit.details).toMatchObject({ list: 'lan', outcome: 'applied' });
    expect(audit.details.before).toMatchObject({ name: 'Old phone' });
  });

  it('adds a Wi-Fi entry for one network', async () => {
    const agent = await signedInAgent();

    const res = await agent
      .post('/api/router/mac-filter/wifi/entries')
      .send({ ...ENTRY, ssid: 'SSID-5' });

    expect(res.status).toBe(201);
    expect(res.body.entry).toMatchObject({ ssid: 'SSID-5', mac: '02:4e:56:00:00:01' });
    expect(router.submissions[0]).toMatchObject({
      page: 'wifiMacFilter',
      object: `${SEC}.WLANMacFilter`,
      fields: { 'x.SSIDName': 'SSID-5', 'x.DeviceName': 'Test phone', 'x.Enable': '1' },
    });
  });

  it.each([
    ['without a network', 'wifi', ENTRY],
    ['for an inactive network', 'wifi', { ...ENTRY, ssid: 'SSID-2' }],
    ['for the server or admin PC', 'lan', { ...ENTRY, mac: 'aa:bb:cc:00:00:20' }],
  ])('refuses an entry %s', async (_label, list, input) => {
    const agent = await signedInAgent();
    const res = await agent.post(`/api/router/mac-filter/${list}/entries`).send(input);
    expect(res.status).toBe(422);
    expect(router.submissions).toHaveLength(0);
  });

  it.each([
    [{ ...ENTRY, mac: '02:4e:56:00:01' }, 'mac'],
    [{ ...ENTRY, name: 'bad"name' }, 'name'],
    [{ ...ENTRY, ssid: 'ath0' }, 'ssid'],
  ])('rejects invalid input %#', async (input, path) => {
    const agent = await signedInAgent();
    const res = await agent.post('/api/router/mac-filter/wifi/entries').send(input);
    expect(res.status).toBe(400);
    expect(res.body.details.map((d: { path: string }) => d.path)).toContain(path);
  });

  it('refuses the same MAC twice in one list', async () => {
    const agent = await signedInAgent();
    await agent.post('/api/router/mac-filter/lan/entries').send(ENTRY);
    const res = await agent.post('/api/router/mac-filter/lan/entries').send(ENTRY);
    expect(res.status).toBe(422);
  });

  it('turns a list on and off, always in blacklist mode', async () => {
    const agent = await signedInAgent();

    const on = await agent.patch('/api/router/mac-filter/wifi').send({ enabled: true });
    const off = await agent.patch('/api/router/mac-filter/wifi').send({ enabled: false });

    expect(on.body.enabled).toBe(true);
    expect(off.body.enabled).toBe(false);
    expect(router.submissions[0]).toMatchObject({
      page: 'wifiMacFilter',
      action: 'set',
      object: SEC,
      fields: { 'x.WlanMacFilterRight': '1', 'x.WlanMacFilterPolicy': '0' },
    });
  });

  it('does not turn on a list that holds the server or admin PC', async () => {
    router.lists.macFilter.entries.set(1, { mac: 'aa:bb:cc:00:00:20', name: 'desktop', ssid: '' });
    const agent = await signedInAgent();
    const res = await agent.patch('/api/router/mac-filter/lan').send({ enabled: true });
    expect(res.status).toBe(422);
    expect(router.submissions).toHaveLength(0);
  });

  it('does not touch a list in whitelist mode', async () => {
    router.lists.macFilter.mode = '1';
    const agent = await signedInAgent();
    const res = await agent.post('/api/router/mac-filter/lan/entries').send(ENTRY);
    expect(res.status).toBe(422);
    expect(router.submissions).toHaveLength(0);
  });

  it('reports a change the router did not apply', async () => {
    router.ignoreWrites = true;
    const agent = await signedInAgent();
    const res = await agent.patch('/api/router/mac-filter/lan').send({ enabled: true });
    expect(res.status).toBe(502);
  });

  it('returns 404 for an entry that is not on the router', async () => {
    const agent = await signedInAgent();
    expect((await agent.delete('/api/router/mac-filter/lan/entries/9')).status).toBe(404);
    expect((await agent.get('/api/router/mac-filter/vpn')).status).toBe(404);
  });
});
