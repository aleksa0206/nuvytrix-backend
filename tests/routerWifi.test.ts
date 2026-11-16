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

const LAN = 'InternetGatewayDevice.LANDevice.1';
const MAIN_KEY = 'secret-main-key-123';

interface Net {
  enable: string;
  ssid: string;
  visible: string;
  beacon: string;
  basicEnc: string;
  key: string;
}

/** Router stand-in for WlanBasic.asp: SSIDs as `stWlan` and keys as `stPreSharedKey`. */
class WifiRouter extends HuaweiWebClient {
  nets = new Map<number, Net>([
    [
      1,
      { enable: '1', ssid: 'Home', visible: '1', beacon: '11i', basicEnc: 'None', key: MAIN_KEY },
    ],
    [
      5,
      {
        enable: '1',
        ssid: 'Home 5g',
        visible: '1',
        beacon: '11i',
        basicEnc: 'None',
        key: MAIN_KEY,
      },
    ],
  ]);
  ignoreKey = false;
  failSet = false;
  submissions: FormSubmission[] = [];

  constructor() {
    super({ baseUrl: 'http://router.test', username: 'admin', password: 'x' });
  }

  render(): string {
    const wlans = [...this.nets].map(
      ([i, n]) =>
        `new stWlan("${LAN}.WLANConfiguration.${i}","ath${i - 1}","${n.enable}","${n.ssid}","${n.visible}","32","1","${n.beacon}","${n.basicEnc}","None")`
    );
    const keys = [...this.nets].map(
      ([i, n]) => `new stPreSharedKey("${LAN}.WLANConfiguration.${i}.PreSharedKey.1","${n.key}","")`
    );
    return (
      `function stWlan(domain,name,enable,ssid) {}\n` +
      `Wlan[0] = ${wlans.join(';\nWlan[0] = ')};\n` +
      `var wpaPskKey = new Array(${[...keys, 'null'].join(',')});`
    );
  }

  override async fetchPages<T extends RouterPage>(names: readonly T[]) {
    return Object.fromEntries(names.map((name) => [name, this.render()])) as Record<T, string>;
  }

  override async submitForm(form: FormSubmission) {
    this.submissions.push(form);
    const f = form.fields;
    if (form.action === 'add') {
      const index = Math.max(...this.nets.keys()) === 5 ? 2 : 6;
      this.nets.set(index, {
        enable: f['y.Enable']!,
        ssid: f['y.SSID']!,
        visible: f['y.SSIDAdvertisementEnabled']!,
        beacon: 'Basic',
        basicEnc: 'None',
        key: '',
      });
    } else if (form.action === 'set' && !this.failSet) {
      const net = this.nets.get(Number(form.object!.split('.').pop()))!;
      Object.assign(net, {
        enable: f['y.Enable'],
        ssid: f['y.SSID'],
        visible: f['y.SSIDAdvertisementEnabled'],
        beacon: f['y.BeaconType'],
      });
      if (f['k.PreSharedKey'] && !this.ignoreKey) net.key = f['k.PreSharedKey'];
    } else if (form.action === 'del') {
      for (const key of Object.keys(f)) this.nets.delete(Number(key.split('.').pop()));
    }
    return this.render();
  }
}

let router: WifiRouter;

function setup(writesEnabled = true) {
  router = new WifiRouter();
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

const UPDATE = { ssid: 'Home', enabled: true, visible: true, security: 'wpa2' };

afterAll(async () => {
  resetContainer();
  await closeDatabase();
});

describe('router Wi-Fi management', () => {
  beforeEach(async () => {
    await prepareDatabase();
    setup();
  });

  it('lists the networks without any key', async () => {
    const agent = await signedInAgent();
    const res = await agent.get('/api/router/wifi');
    expect(res.body.networks).toEqual([
      {
        domain: `${LAN}.WLANConfiguration.1`,
        instance: 1,
        band: '2.4 GHz',
        enabled: true,
        ssid: 'Home',
        visible: true,
        security: 'wpa2',
      },
      expect.objectContaining({ instance: 5, band: '5 GHz', ssid: 'Home 5g' }),
    ]);
    expect(JSON.stringify(res.body)).not.toContain(MAIN_KEY);
  });

  it('renames and hides a network without touching its key', async () => {
    const agent = await signedInAgent();

    const res = await agent
      .put('/api/router/wifi/1')
      .send({ ...UPDATE, ssid: 'Home2', visible: false });

    expect(res.status).toBe(200);
    expect(res.body.network).toMatchObject({ ssid: 'Home2', visible: false });
    expect(router.submissions[0]).toMatchObject({
      action: 'set',
      objectKey: 'y',
      object: `${LAN}.WLANConfiguration.1`,
      fields: { 'y.SSID': 'Home2', 'y.SSIDAdvertisementEnabled': '0', 'y.BeaconType': '11i' },
    });
    expect(router.submissions[0]!.extraQuery).toBeUndefined();
    expect(router.submissions[0]!.fields['k.PreSharedKey']).toBeUndefined();
  });

  it('changes the key, verifies it on the router and never stores it', async () => {
    const agent = await signedInAgent();

    const res = await agent
      .put('/api/router/wifi/1')
      .send({ ...UPDATE, password: 'new-password-42' });

    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain('new-password-42');
    expect(router.submissions[0]).toMatchObject({
      extraQuery: { k: `${LAN}.WLANConfiguration.1.PreSharedKey.1` },
      fields: { 'k.PreSharedKey': 'new-password-42' },
    });
    const audits = await db('audit_logs').where({ action: 'router.wifi_network_updated' });
    expect(JSON.stringify(audits)).not.toContain('new-password-42');
    expect(audits[0].details.requested.password).toBe('[changed]');
  });

  it('reports a key the router did not take', async () => {
    router.ignoreKey = true;
    const agent = await signedInAgent();
    const res = await agent
      .put('/api/router/wifi/1')
      .send({ ...UPDATE, password: 'new-password-42' });
    expect(res.status).toBe(502);
  });

  it('adds a network switched off, then secures it with a key', async () => {
    const agent = await signedInAgent();

    const res = await agent.post('/api/router/wifi').send({
      band: '2.4 GHz',
      ssid: 'Guests',
      enabled: true,
      visible: true,
      security: 'wpa2',
      password: 'guest-password-1',
    });

    expect(res.status).toBe(201);
    expect(res.body.network).toMatchObject({
      instance: 2,
      ssid: 'Guests',
      enabled: true,
      security: 'wpa2',
    });
    expect(router.submissions[0]).toMatchObject({
      action: 'add',
      object: `${LAN}.WLANConfiguration`,
      fields: { 'y.Enable': '0', 'y.LowerLayers': `${LAN}.WiFi.Radio.1` },
    });
    expect(router.submissions[1]).toMatchObject({ action: 'set', fields: { 'y.Enable': '1' } });
  });

  it('removes a new network again when securing it fails, so no open network stays', async () => {
    router.failSet = true;
    const agent = await signedInAgent();

    const res = await agent.post('/api/router/wifi').send({
      band: '2.4 GHz',
      ssid: 'Guests',
      enabled: true,
      visible: true,
      security: 'wpa2',
      password: 'guest-password-1',
    });

    expect(res.status).toBe(502);
    expect(router.submissions.map((s) => s.action)).toEqual(['add', 'set', 'del']);
    expect([...router.nets.keys()]).toEqual([1, 5]);
  });

  it('deletes an extra network with the page pre-request, but never a main network', async () => {
    router.nets.set(2, {
      enable: '0',
      ssid: 'Old',
      visible: '1',
      beacon: '11i',
      basicEnc: 'None',
      key: 'x',
    });
    const agent = await signedInAgent();

    const main = await agent.delete('/api/router/wifi/1');
    const extra = await agent.delete('/api/router/wifi/2');

    expect(main.status).toBe(422);
    expect(extra.status).toBe(200);
    expect(router.submissions).toHaveLength(1);
    expect(router.submissions[0]).toMatchObject({
      action: 'del',
      fields: { [`${LAN}.WLANConfiguration.2`]: '' },
      before: {
        action: 'set',
        object: 'InternetGatewayDevice.X_HW_DEBUG.AMP.ParallelDelSsid',
        fields: { 'y.DeleteInstArray': '2' },
      },
    });
  });

  it.each([
    [{ ...UPDATE, ssid: '' }, 'ssid'],
    [{ ...UPDATE, ssid: 'x'.repeat(33) }, 'ssid'],
    [{ ...UPDATE, ssid: ' lead' }, 'ssid'],
    [{ ...UPDATE, ssid: 'Žuto' }, 'ssid'],
    [{ ...UPDATE, password: 'short' }, 'password'],
    [{ ...UPDATE, security: 'open' }, 'security'],
  ])('rejects invalid input %#', async (input, path) => {
    const agent = await signedInAgent();
    const res = await agent.put('/api/router/wifi/1').send(input);
    expect(res.status).toBe(400);
    expect(res.body.details.map((d: { path: string }) => d.path)).toContain(path);
  });

  it('refuses a duplicate name on a band and changing security without a key', async () => {
    const agent = await signedInAgent();
    router.nets.set(2, {
      enable: '0',
      ssid: 'Old',
      visible: '1',
      beacon: '11i',
      basicEnc: 'None',
      key: 'x',
    });

    const dup = await agent.put('/api/router/wifi/2').send({ ...UPDATE, ssid: 'Home' });
    const mode = await agent.put('/api/router/wifi/1').send({ ...UPDATE, security: 'wpa-wpa2' });

    expect(dup.status).toBe(422);
    expect(mode.status).toBe(422);
    expect(router.submissions).toHaveLength(0);
  });

  it('refuses writes while ROUTER_WRITES_ENABLED is off', async () => {
    setup(false);
    const agent = await signedInAgent();
    expect((await agent.put('/api/router/wifi/1').send(UPDATE)).status).toBe(403);
  });
});
