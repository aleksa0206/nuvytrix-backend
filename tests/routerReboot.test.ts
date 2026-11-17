import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../src/config/db';
import { resetContainer } from '../src/container';
import {
  HuaweiWebClient,
  RouterUnavailableError,
  type FormSubmission,
  type RouterPage,
} from '../src/modules/router/huaweiWebClient';
import { UpnpClient } from '../src/modules/router/upnpClient';
import { closeDatabase, prepareDatabase, signedInAgent } from './helpers/testDb';

/** Router stand-in: drops the connection on the reboot request, like a router going down. */
class RebootRouter extends HuaweiWebClient {
  submissions: FormSubmission[] = [];
  constructor() {
    super({ baseUrl: 'http://router.test', username: 'admin', password: 'x' });
  }
  override async fetchPages<T extends RouterPage>(names: readonly T[]) {
    return Object.fromEntries(names.map((n) => [n, 'function SaveandReboot() {}'])) as Record<
      T,
      string
    >;
  }
  override async submitForm(form: FormSubmission): Promise<string> {
    this.submissions.push(form);
    throw new RouterUnavailableError('Router not reachable: AbortError');
  }
}

let router: RebootRouter;

function setup(writesEnabled = true) {
  router = new RebootRouter();
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

describe('router reboot', () => {
  beforeEach(async () => {
    await prepareDatabase();
    setup();
  });

  it('sends the page own save-and-reboot request once, audited, and refuses a quick second one', async () => {
    const agent = await signedInAgent();

    const missing = await agent.post('/api/router/reboot').send({});
    const first = await agent.post('/api/router/reboot').send({ confirm: 'reboot' });
    const second = await agent.post('/api/router/reboot').send({ confirm: 'reboot' });

    expect(missing.status).toBe(400);
    expect(first.body).toEqual({ answered: false });
    expect(second.status).toBe(422);
    expect(router.submissions).toHaveLength(1);
    expect(router.submissions[0]).toMatchObject({
      page: 'cfgFile',
      action: 'set',
      object: 'InternetGatewayDevice.X_HW_DEBUG.SSP.DBSave',
      extraQuery: { y: 'InternetGatewayDevice.X_HW_DEBUG.SMP.DM.ResetBoard' },
      fields: {},
      readBack: false,
    });
    const audits = await db('audit_logs')
      .where({ action: 'router.reboot_requested' })
      .orderBy('id');
    expect(audits.map((a) => a.details.outcome)).toEqual(['requested', 'sent_no_answer']);
  });

  it('is off while router writes are disabled', async () => {
    setup(false);
    const agent = await signedInAgent();
    expect((await agent.post('/api/router/reboot').send({ confirm: 'reboot' })).status).toBe(403);
    expect(router.submissions).toHaveLength(0);
  });
});
