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

const CTRL = 'InternetGatewayDevice.LANDevice.1.X_HW_WLANShutDownCtrl';

/** Router stand-in for WlanSchedule.asp, including the page's own template constructor call. */
class ScheduleRouter extends HuaweiWebClient {
  enabled = '0';
  durations = new Map<number, [string, string, string]>();
  submissions: FormSubmission[] = [];
  ignoreWrites = false;

  constructor() {
    super({ baseUrl: 'http://router.test', username: 'admin', password: 'x' });
  }

  render(): string {
    const rows = [...this.durations]
      .filter(([, d]) => d[0])
      .map(([i, d]) => `new stDuration("${CTRL}.Duration.${i}","${d[0]}","${d[1]}","${d[2]}")`);
    return (
      `var DurationArr = new Array(${[...rows, 'null'].join(',')});\n` +
      `Druationitem[i-1] = new stDuration("${CTRL}.Duration."+i, "", "", "1,2,3,4,5,6,7");\n` +
      `var wlanSchecuelEnable = ${this.enabled};`
    );
  }

  override async fetchPages<T extends RouterPage>(names: readonly T[]) {
    return Object.fromEntries(names.map((n) => [n, this.render()])) as Record<T, string>;
  }

  override async submitForm(form: FormSubmission) {
    this.submissions.push(form);
    if (!this.ignoreWrites) {
      const p = form.before!.fields;
      (['x', 'y', 'z', 'w'] as const).forEach((k, i) =>
        this.durations.set(i + 1, [p[`${k}.StartTime`]!, p[`${k}.EndTime`]!, p[`${k}.RepeatDay`]!])
      );
      this.enabled = form.fields['x.Enable']!;
    }
    return this.render();
  }
}

let router: ScheduleRouter;

function setup(writesEnabled = true) {
  router = new ScheduleRouter();
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

describe('router Wi-Fi shutdown schedule', () => {
  beforeEach(async () => {
    await prepareDatabase();
    setup();
  });

  it('reads an empty schedule, ignoring the page template', async () => {
    const agent = await signedInAgent();
    const res = await agent.get('/api/router/wifi-schedule');
    expect(res.body).toEqual({ writesEnabled: true, enabled: false, periods: [] });
  });

  it('writes the periods and the switch in one session, and clears unused periods', async () => {
    const agent = await signedInAgent();

    const res = await agent.put('/api/router/wifi-schedule').send({
      enabled: true,
      periods: [{ start: '01:00', end: '06:00', days: [7, 1] }],
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      enabled: true,
      periods: [{ start: '01:00', end: '06:00', days: [1, 7] }],
    });
    expect(router.submissions[0]).toMatchObject({
      page: 'wifiSchedule',
      action: 'set',
      object: CTRL,
      fields: { 'x.Enable': '1' },
      before: {
        object: `${CTRL}.Duration.1`,
        extraQuery: {
          y: `${CTRL}.Duration.2`,
          z: `${CTRL}.Duration.3`,
          w: `${CTRL}.Duration.4`,
        },
        fields: {
          'x.StartTime': '01:00',
          'x.RepeatDay': '1,7',
          'y.StartTime': '',
          'y.RepeatDay': '1,2,3,4,5,6,7',
        },
      },
    });
    const audit = await db('audit_logs').where({ action: 'router.wifi_schedule_changed' }).first();
    expect(audit.details.outcome).toBe('applied');
  });

  it.each([
    [{ enabled: true, periods: [{ start: '06:00', end: '01:00', days: [1] }] }],
    [{ enabled: true, periods: [{ start: '01:00', end: '06:00', days: [] }] }],
    [{ enabled: true, periods: Array(5).fill({ start: '01:00', end: '02:00', days: [1] }) }],
  ])('rejects invalid input %#', async (input) => {
    const agent = await signedInAgent();
    expect((await agent.put('/api/router/wifi-schedule').send(input)).status).toBe(400);
  });

  it('reports a schedule the router did not save, and refuses writes when turned off', async () => {
    router.ignoreWrites = true;
    const agent = await signedInAgent();
    const body = { enabled: false, periods: [{ start: '01:00', end: '02:00', days: [1] }] };
    expect((await agent.put('/api/router/wifi-schedule').send(body)).status).toBe(502);
    setup(false);
    const off = await signedInAgent();
    expect((await off.put('/api/router/wifi-schedule').send(body)).status).toBe(403);
  });
});
