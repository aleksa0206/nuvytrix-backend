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

/** Router stand-in for ledcfg.asp. */
class LedRouter extends HuaweiWebClient {
  value = '0';
  submissions: FormSubmission[] = [];
  ignoreWrites = false;

  constructor() {
    super({ baseUrl: 'http://router.test', username: 'admin', password: 'x' });
  }

  render(): string {
    return `function stLedOffTimeInfo(domain,StartTime,EndTime) {}\nvar EnableLedSwitch = '${this.value}';`;
  }

  override async fetchPages<T extends RouterPage>(names: readonly T[]) {
    return Object.fromEntries(names.map((n) => [n, this.render()])) as Record<T, string>;
  }

  override async submitForm(form: FormSubmission) {
    this.submissions.push(form);
    if (!this.ignoreWrites) this.value = form.fields['x.X_HW_LedSwitch']!;
    return this.render();
  }
}

let router: LedRouter;

function setup(writesEnabled = true) {
  router = new LedRouter();
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

describe('router LED', () => {
  beforeEach(async () => {
    await prepareDatabase();
    setup();
  });

  it('reads the mode and switches the lights off and on', async () => {
    const agent = await signedInAgent();

    const read = await agent.get('/api/router/led');
    const off = await agent.put('/api/router/led').send({ mode: 'offAfterDelay' });
    const on = await agent.put('/api/router/led').send({ mode: 'on' });

    expect(read.body).toEqual({ writesEnabled: true, mode: 'on' });
    expect(off.body).toEqual({ mode: 'offAfterDelay' });
    expect(on.body).toEqual({ mode: 'on' });
    expect(router.submissions[0]).toMatchObject({
      page: 'led',
      action: 'set',
      object: 'InternetGatewayDevice.X_HW_SSMPPDT.Deviceinfo',
      fields: { 'x.X_HW_LedSwitch': '2' },
    });
    const audit = await db('audit_logs').where({ action: 'router.led_changed' }).first();
    expect(audit.details.outcome).toBe('applied');
  });

  it('rejects unknown modes, reports changes the router ignored and respects the switch', async () => {
    const agent = await signedInAgent();
    expect((await agent.put('/api/router/led').send({ mode: 'blink' })).status).toBe(400);
    router.ignoreWrites = true;
    expect((await agent.put('/api/router/led').send({ mode: 'off' })).status).toBe(502);
    setup(false);
    const off = await signedInAgent();
    expect((await off.put('/api/router/led').send({ mode: 'off' })).status).toBe(403);
  });
});
