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

/** Router stand-in: radio values as WlanBasic.asp renders them. */
class RadioRouter extends HuaweiWebClient {
  radios = new Map<number, { channel: string; power: string; auto: string; width: string }>([
    [1, { channel: '0', power: '100', auto: '1', width: '0' }],
    [5, { channel: '0', power: '100', auto: '1', width: '4' }],
  ]);
  wps = new Map([
    [1, '1'],
    [5, '1'],
  ]);
  submissions: FormSubmission[] = [];
  ignoreWrites = false;

  constructor() {
    super({ baseUrl: 'http://router.test', username: 'admin', password: 'x' });
  }

  render(): string {
    const rows = [...this.radios].map(
      ([i, r]) =>
        `new stWlanWifi("${LAN}.WLANConfiguration.${i}","ath${i - 1}","1","Home","11ax","${r.channel}","${r.power}","RS","${r.auto}","${r.width}")`
    );
    const wps = [...this.wps].map(
      ([i, e]) =>
        `new stWpsPin("${LAN}.WLANConfiguration.${i}.WPS","PushButton","12345670","AP","${e}")`
    );
    return `function stWlanWifi(domain,name,enable,ssid,mode,channel,power,Country,AutoChannelEnable,channelWidth) {}\nvar WlanWifiArr = new Array(${[...rows, 'null'].join(',')});\nvar wpsPinNum = new Array(${[...wps, 'null'].join(',')});\nvar wpaPskKey = "secret";`;
  }

  override async fetchPages<T extends RouterPage>(names: readonly T[]) {
    return Object.fromEntries(names.map((n) => [n, this.render()])) as Record<T, string>;
  }

  override async submitForm(form: FormSubmission) {
    this.submissions.push(form);
    if (!this.ignoreWrites) {
      const f = form.fields;
      const i = Number(
        form
          .object!.replace(/\.WPS$/, '')
          .split('.')
          .pop()
      );
      if (form.objectKey === 'z') {
        this.wps.set(i, f['z.Enable']!);
        return this.render();
      }
      this.radios.set(i, {
        channel: f['y.Channel']!,
        power: f['y.TransmitPower']!,
        auto: f['y.AutoChannelEnable']!,
        width: f['y.X_HW_HT20']!,
      });
    }
    return this.render();
  }
}

let router: RadioRouter;

function setup(writesEnabled = true) {
  router = new RadioRouter();
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

describe('router Wi-Fi radio settings', () => {
  beforeEach(async () => {
    await prepareDatabase();
    setup();
  });

  it('lists both radios with the offered channels, and nothing secret', async () => {
    const agent = await signedInAgent();
    const res = await agent.get('/api/router/wifi-radios');
    expect(res.body.radios).toEqual([
      expect.objectContaining({ band: '2.4 GHz', width: 'auto-40', wpsEnabled: true }),
      expect.objectContaining({ band: '5 GHz', width: '160', wpsEnabled: true }),
    ]);
    expect(res.body.widths['2.4 GHz']).toEqual(['auto-40', '20', '40']);
    expect(JSON.stringify(res.body)).not.toContain('12345670');
    expect(res.body.channels['5 GHz']).toEqual([36, 40, 44, 48]);
    expect(JSON.stringify(res.body)).not.toContain('secret');
  });

  it('sets a manual channel and power on the band, then automatic again', async () => {
    const agent = await signedInAgent();

    const manual = await agent
      .put('/api/router/wifi-radios')
      .send({ band: '2.4 GHz', channel: 6, power: 80, width: '20' });
    const auto = await agent
      .put('/api/router/wifi-radios')
      .send({ band: '2.4 GHz', channel: 'auto', power: 100, width: 'auto-40' });

    expect(manual.body).toMatchObject({ channel: 6, autoChannel: false, power: 80, width: '20' });
    expect(router.submissions[0]).toMatchObject({
      page: 'wifiAdvanced',
      readBack: 'wifi',
      action: 'set',
      objectKey: 'y',
      object: `${LAN}.WLANConfiguration.1`,
      fields: {
        'y.Channel': '6',
        'y.AutoChannelEnable': '0',
        'y.TransmitPower': '80',
        'y.X_HW_HT20': '1',
      },
    });
    expect(auto.body).toMatchObject({ autoChannel: true, power: 100 });
    expect(router.submissions[1]!.fields).toMatchObject({
      'y.Channel': '0',
      'y.AutoChannelEnable': '1',
    });
    const audit = await db('audit_logs').where({ action: 'router.wifi_radio_changed' }).first();
    expect(audit.details.outcome).toBe('applied');
  });

  it('refuses DFS or invalid channels and power levels the router does not offer', async () => {
    const agent = await signedInAgent();
    const dfs = await agent
      .put('/api/router/wifi-radios')
      .send({ band: '5 GHz', channel: 100, power: 100, width: '20' });
    const wrongBand = await agent
      .put('/api/router/wifi-radios')
      .send({ band: '2.4 GHz', channel: 36, power: 100, width: '20' });
    const power = await agent
      .put('/api/router/wifi-radios')
      .send({ band: '5 GHz', channel: 'auto', power: 90, width: '20' });
    expect(dfs.status).toBe(422);
    expect(wrongBand.status).toBe(422);
    expect(power.status).toBe(400);
    expect(router.submissions).toHaveLength(0);
  });

  it('refuses widths the band does not offer', async () => {
    const agent = await signedInAgent();
    const wide = await agent
      .put('/api/router/wifi-radios')
      .send({ band: '2.4 GHz', channel: 'auto', power: 100, width: '160' });
    expect(wide.status).toBe(422);
    expect(router.submissions).toHaveLength(0);
  });

  it('turns WPS off and on for a band without touching the PIN', async () => {
    const agent = await signedInAgent();

    const off = await agent.put('/api/router/wifi-wps').send({ band: '5 GHz', enabled: false });

    expect(off.body).toMatchObject({ band: '5 GHz', wpsEnabled: false });
    expect(router.submissions[0]).toMatchObject({
      page: 'wifi',
      action: 'set',
      objectKey: 'z',
      object: `${LAN}.WLANConfiguration.5.WPS`,
      fields: { 'z.Enable': '0' },
    });
    expect(Object.keys(router.submissions[0]!.fields)).toEqual(['z.Enable']);
    const audit = await db('audit_logs').where({ action: 'router.wifi_wps_changed' }).first();
    expect(JSON.stringify(audit.details)).not.toContain('12345670');
    const on = await agent.put('/api/router/wifi-wps').send({ band: '5 GHz', enabled: true });
    expect(on.body.wpsEnabled).toBe(true);
  });

  it('reports a change the router did not apply, and refuses writes when turned off', async () => {
    router.ignoreWrites = true;
    const agent = await signedInAgent();
    const body = { band: '5 GHz', channel: 40, power: 100, width: '40' };
    expect((await agent.put('/api/router/wifi-radios').send(body)).status).toBe(502);
    setup(false);
    const off = await signedInAgent();
    expect((await off.put('/api/router/wifi-radios').send(body)).status).toBe(403);
  });
});
