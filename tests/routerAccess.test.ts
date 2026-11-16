import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../src/config/db';
import { container, resetContainer } from '../src/container';
import {
  HuaweiWebClient,
  type FormSubmission,
  type RouterPage,
} from '../src/modules/router/huaweiWebClient';
import { UpnpClient } from '../src/modules/router/upnpClient';
import { DEVICES_PAGE } from './fixtures/huawei';
import { closeDatabase, prepareDatabase, signedInAgent } from './helpers/testDb';

/** Router stand-in for aclsmart.asp; DEVICES_PAGE has .20 on a cable and .31 on Wi-Fi. */
class AclRouter extends HuaweiWebClient {
  httpWifi = '1';
  submissions: FormSubmission[] = [];

  constructor() {
    super({ baseUrl: 'http://router.test', username: 'admin', password: 'x' });
  }

  render(): string {
    return (
      'function stAclInfo(domain,TelnetLanEnable,HTTPWifiEnable,TELNETWifiEnable) {}\n' +
      `var aclinfos = new Array(new stAclInfo("InternetGatewayDevice.X_HW_Security.AclServices","","${this.httpWifi}",""),null);`
    );
  }

  override async fetchPages<T extends RouterPage>(names: readonly T[]) {
    return Object.fromEntries(
      names.map((n) => [n, n === 'devices' ? DEVICES_PAGE : this.render()])
    ) as Record<T, string>;
  }

  override async submitForm(form: FormSubmission) {
    this.submissions.push(form);
    this.httpWifi = form.fields['x.HTTPWifiEnable']!;
    return this.render();
  }
}

let router: AclRouter;

function setup(protectedAddresses: string[]) {
  router = new AclRouter();
  resetContainer({
    routerWebClient: router,
    upnpClient: new UpnpClient({
      baseUrl: 'http://router.test',
      wanCommonControl: '/c',
      wanIpControl: '/i',
    }),
    routerWritesEnabled: true,
  });
  const internals = container as unknown as {
    routerAccessService: { settings: { protectedAddresses: string[] } };
  };
  internals.routerAccessService.settings.protectedAddresses = protectedAddresses;
}

afterAll(async () => {
  resetContainer();
  await closeDatabase();
});

describe('router device access control', () => {
  beforeEach(async () => {
    await prepareDatabase();
  });

  it('reads and switches web access from Wi-Fi the way the router page does', async () => {
    setup(['192.168.100.20']);
    const agent = await signedInAgent();

    expect((await agent.get('/api/router/device-access')).body).toEqual({
      writesEnabled: true,
      httpFromWifi: true,
    });
    const res = await agent.put('/api/router/device-access').send({ httpFromWifi: false });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ httpFromWifi: false });
    expect(router.submissions[0]).toMatchObject({
      page: 'deviceAccess',
      action: 'set',
      object: 'InternetGatewayDevice.X_HW_Security.AclServices',
      fields: { 'x.HTTPWifiEnable': '0' },
    });
    const audit = await db('audit_logs').where({ action: 'router.device_access_changed' }).first();
    expect(audit.details.before).toEqual({ httpFromWifi: true });
  });

  it.each([
    ['on Wi-Fi', '192.168.100.31'],
    ['not seen at all', '192.168.100.99'],
  ])('refuses to block Wi-Fi access while a protected address is %s', async (_case, ip) => {
    setup(['192.168.100.20', ip]);
    const agent = await signedInAgent();

    const res = await agent.put('/api/router/device-access').send({ httpFromWifi: false });

    expect(res.status).toBe(422);
    expect(res.body.message).toContain(ip);
    expect(router.submissions).toHaveLength(0);
  });

  it('allows switching Wi-Fi access back on without the cable check', async () => {
    setup(['192.168.100.31']);
    router.httpWifi = '0';
    const agent = await signedInAgent();

    const res = await agent.put('/api/router/device-access').send({ httpFromWifi: true });

    expect(res.body).toEqual({ httpFromWifi: true });
  });
});
