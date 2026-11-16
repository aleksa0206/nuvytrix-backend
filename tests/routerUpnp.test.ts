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

/** Router stand-in for upnp.asp. */
class UpnpRouter extends HuaweiWebClient {
  main = '1';
  slave = '1';
  submissions: FormSubmission[] = [];
  ignoreWrites = false;

  constructor() {
    super({ baseUrl: 'http://router.test', username: 'admin', password: 'x' });
  }

  render(): string {
    return `var enblMainUpnp = '${this.main}';\nvar enblSlvUpnp = '${this.slave}';\nfunction stUpnpPortMapping(a) {}`;
  }

  override async fetchPages<T extends RouterPage>(names: readonly T[]) {
    return Object.fromEntries(names.map((n) => [n, this.render()])) as Record<T, string>;
  }

  override async submitForm(form: FormSubmission) {
    this.submissions.push(form);
    if (!this.ignoreWrites) {
      this.main = form.fields['x.Enable']!;
      this.slave = form.fields['y.Enable']!;
    }
    return this.render();
  }
}

let router: UpnpRouter;

function setup(writesEnabled = true) {
  router = new UpnpRouter();
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

describe('router UPnP switch', () => {
  beforeEach(async () => {
    await prepareDatabase();
    setup();
  });

  it('reads the state and turns UPnP off and on with both services', async () => {
    const agent = await signedInAgent();

    const read = await agent.get('/api/router/upnp-settings');
    const off = await agent.patch('/api/router/upnp-settings').send({ enabled: false });
    const on = await agent.patch('/api/router/upnp-settings').send({ enabled: true });

    expect(read.body).toEqual({ writesEnabled: true, enabled: true });
    expect(off.body).toEqual({ enabled: false });
    expect(on.body).toEqual({ enabled: true });
    expect(router.submissions[0]).toMatchObject({
      page: 'upnp',
      action: 'set',
      object: 'InternetGatewayDevice.X_HW_MainUPnP',
      extraQuery: { y: 'InternetGatewayDevice.X_HW_SlvUPnP' },
      fields: { 'x.Enable': '0', 'y.Enable': '0' },
    });
    const audit = await db('audit_logs').where({ action: 'router.upnp_changed' }).first();
    expect(audit.details).toMatchObject({ outcome: 'applied', before: { enabled: true } });
  });

  it('reports a change the router did not apply, rejects bad input and respects the switch', async () => {
    router.ignoreWrites = true;
    const agent = await signedInAgent();
    expect((await agent.patch('/api/router/upnp-settings').send({ enabled: false })).status).toBe(
      502
    );
    expect((await agent.patch('/api/router/upnp-settings').send({ enabled: 'no' })).status).toBe(
      400
    );
    setup(false);
    const off = await signedInAgent();
    expect((await off.patch('/api/router/upnp-settings').send({ enabled: false })).status).toBe(
      403
    );
  });
});
