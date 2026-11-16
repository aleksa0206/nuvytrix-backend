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

const PC = 'InternetGatewayDevice.X_HW_Security.ParentalCtrl';
const q = (v: string) => JSON.stringify(v);

interface Tpl {
  name: string;
  urlPolicy: string;
  urlRight: string;
  durPolicy: string;
  durRight: string;
  durations: Map<number, string[]>;
  urls: Map<number, string>;
}

/** Router stand-in that keeps parental control in memory and renders parentalctrlinfo.asp. */
class ParentalRouter extends HuaweiWebClient {
  templates = new Map<number, Tpl>([[1, tpl('template')]]);
  macs = new Map<number, string[]>();
  submissions: FormSubmission[] = [];
  ignoreWrites = false;

  constructor() {
    super({ baseUrl: 'http://router.test', username: 'admin', password: 'x' });
  }

  render(page: RouterPage): string {
    if (page === 'devices') return DEVICES_PAGE;
    if (page === 'parental') return '<input id="hwonttoken" value="ab">';
    const t: string[] = [];
    const d: string[] = [];
    const u: string[] = [];
    for (const [i, x] of this.templates) {
      const dom = `${PC}.Templates.${i}`;
      t.push(
        `new TemplatesListClass(${[dom, x.name, x.urlPolicy, x.urlRight, '', '', x.durPolicy, x.durRight].map(q).join(',')})`
      );
      for (const [j, v] of x.durations)
        d.push(`new DurationListClass(${[`${dom}.Duration.${j}`, ...v].map(q).join(',')})`);
      for (const [j, v] of x.urls)
        u.push(`new UrlFilterUrlAddress(${q(`${dom}.UrlFilter.${j}`)},${q(v)})`);
    }
    const m = [...this.macs].map(
      ([i, v]) => `new ChildListClass(${[`${PC}.MAC.${i}`, ...v].map(q).join(',')})`
    );
    return (
      `function TemplatesListClass(domain) {}\n` +
      `var ChildListArray = new Array(${[...m, 'null'].join(',')});\n` +
      `var TemplatesListArray = new Array(${[...t, 'null'].join(',')});\n` +
      `var DurationListArray = new Array(${[...d, 'null'].join(',')});\n` +
      `var UrlValueArrayAll = new Array(${[...u, 'null'].join(',')});`
    );
  }

  override async fetchPages<T extends RouterPage>(names: readonly T[]) {
    return Object.fromEntries(names.map((n) => [n, this.render(n)])) as Record<T, string>;
  }

  override async submitForm(form: FormSubmission) {
    this.submissions.push(form);
    const f = form.fields;
    const next = (m: Map<number, unknown>) => Math.max(0, ...m.keys()) + 1;
    if (!this.ignoreWrites) {
      const obj = form.object ?? '';
      if (form.action === 'add' && obj.endsWith('.Templates')) {
        this.templates.set(next(this.templates), tpl(f['x_SAVE_A.Name']!));
      } else if (form.action === 'add' && obj.endsWith('.Duration')) {
        const t = this.templates.get(Number(obj.split('.').at(-2)))!;
        t.durations.set(next(t.durations), [f['x.StartTime']!, f['x.EndTime']!, f['x.RepeatDay']!]);
      } else if (form.action === 'add' && obj.endsWith('.UrlFilter')) {
        const t = this.templates.get(Number(obj.split('.').at(-2)))!;
        t.urls.set(next(t.urls), f['x.UrlAddress']!);
      } else if (form.action === 'add') {
        this.macs.set(next(this.macs), [
          f['x.MACAddress']!,
          f['x.Description']!,
          f['x.TemplateInst']!,
        ]);
      } else if (form.action === 'set' && obj.includes('.MAC.')) {
        this.macs.set(Number(obj.split('.').pop()), [
          f['x.MACAddress']!,
          f['x.Description']!,
          f['x.TemplateInst']!,
        ]);
      } else if (form.action === 'set') {
        const t = this.templates.get(Number(obj.split('.').pop()))!;
        t.name = f['x.Name'] ?? t.name;
        t.durRight = f['x.DurationRight'] ?? t.durRight;
        t.durPolicy = f['x.DurationPolicy'] ?? t.durPolicy;
        t.urlRight = f['x.UrlFilterRight'] ?? t.urlRight;
        t.urlPolicy = f['x.UrlFilterPolicy'] ?? t.urlPolicy;
      } else {
        for (const key of Object.keys(f)) {
          const parts = key.split('.');
          const id = Number(parts.pop());
          const kind = parts.pop();
          if (kind === 'MAC') this.macs.delete(id);
          else if (kind === 'Templates') this.templates.delete(id);
          else {
            const t = this.templates.get(Number(parts.pop()))!;
            (kind === 'Duration' ? t.durations : t.urls).delete(id);
          }
        }
      }
    }
    return this.render(form.readBack ?? form.page);
  }
}

function tpl(name: string): Tpl {
  return {
    name,
    urlPolicy: '0',
    urlRight: '0',
    durPolicy: '0',
    durRight: '0',
    durations: new Map(),
    urls: new Map(),
  };
}

let router: ParentalRouter;

function setup(writesEnabled = true) {
  router = new ParentalRouter();
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
    routerParentalService: { settings: { protectedAddresses: string[] } };
  };
  // aa:bb:cc:00:00:20 holds .20 in the device fixture.
  internals.routerParentalService.settings.protectedAddresses = ['192.168.100.20'];
}

afterAll(async () => {
  resetContainer();
  await closeDatabase();
});

describe('router parental control', () => {
  beforeEach(async () => {
    await prepareDatabase();
    setup();
  });

  it('builds a template with a schedule and a URL list, then binds a device', async () => {
    const agent = await signedInAgent();

    const created = await agent.post('/api/router/parental/templates').send({ name: 'Kids' });
    const period = await agent
      .post('/api/router/parental/templates/2/periods')
      .send({ start: '08:00', end: '20:30', days: [5, 1, 2] });
    const url = await agent
      .post('/api/router/parental/templates/2/urls')
      .send({ url: 'https://Example.com/games' });
    const switched = await agent
      .patch('/api/router/parental/templates/2')
      .send({ timeEnabled: true, timeMode: 'allow', urlEnabled: true, urlMode: 'block' });
    const device = await agent
      .post('/api/router/parental/devices')
      .send({ mac: '02:4E:56:00:00:01', description: 'Tablet', template: 2 });
    const state = await agent.get('/api/router/parental');

    expect(created.status).toBe(201);
    expect(router.submissions[0]).toMatchObject({
      page: 'parental',
      readBack: 'parentalInfo',
      action: 'add',
      objectKey: 'x_SAVE_A',
      object: `${PC}.Templates`,
      fields: { 'x_SAVE_A.Name': 'Kids' },
    });
    expect(period.body).toMatchObject({ start: '08:00', end: '20:30', days: [1, 2, 5] });
    expect(router.submissions[1]!.fields['x.RepeatDay']).toBe('1,2,5');
    expect(url.body.url).toBe('Example.com/games');
    expect(switched.body).toMatchObject({
      timeEnabled: true,
      timeMode: 'allow',
      urlEnabled: true,
      urlMode: 'block',
    });
    expect(router.submissions[3]!.fields).toEqual({
      'x.DurationRight': '1',
      'x.DurationPolicy': '1',
      'x.UrlFilterRight': '1',
      'x.UrlFilterPolicy': '0',
    });
    expect(device.body).toMatchObject({ mac: '02:4e:56:00:00:01', template: 2 });
    expect(state.body.devices).toHaveLength(1);
    const audit = await db('audit_logs')
      .where({ action: 'router.parental_device_created' })
      .first();
    expect(audit.details.outcome).toBe('applied');
  });

  it('refuses binding the server or admin PC, all devices, or one device twice', async () => {
    const agent = await signedInAgent();

    const server = await agent
      .post('/api/router/parental/devices')
      .send({ mac: 'aa:bb:cc:00:00:20', template: 1 });
    const all = await agent
      .post('/api/router/parental/devices')
      .send({ mac: 'FF:FF:FF:FF:FF:FF', template: 1 });
    await agent
      .post('/api/router/parental/devices')
      .send({ mac: '02:4e:56:00:00:01', template: 1 });
    const twice = await agent
      .post('/api/router/parental/devices')
      .send({ mac: '02:4e:56:00:00:01', template: 1 });
    const noTemplate = await agent
      .post('/api/router/parental/devices')
      .send({ mac: '02:4e:56:00:00:02', template: 9 });

    expect(server.status).toBe(422);
    expect(all.status).toBe(400);
    expect(twice.status).toBe(422);
    expect(noTemplate.status).toBe(404);
  });

  it('does not delete a template a device uses, and deletes items and devices', async () => {
    const agent = await signedInAgent();
    await agent
      .post('/api/router/parental/templates/1/periods')
      .send({ start: '22:00', end: '23:00', days: [7] });
    await agent.post('/api/router/parental/templates/1/urls').send({ url: 'example.com' });
    await agent
      .post('/api/router/parental/devices')
      .send({ mac: '02:4e:56:00:00:01', template: 1 });

    const busy = await agent.delete('/api/router/parental/templates/1');
    const period = await agent.delete('/api/router/parental/templates/1/periods/1');
    const url = await agent.delete('/api/router/parental/templates/1/urls/1');
    const device = await agent.delete('/api/router/parental/devices/1');
    const template = await agent.delete('/api/router/parental/templates/1');

    expect(busy.status).toBe(422);
    expect([period.status, url.status, device.status, template.status]).toEqual([
      200, 200, 200, 200,
    ]);
    expect(template.body.templates).toEqual([]);
    expect(router.submissions.at(-1)!.fields).toEqual({ [`${PC}.Templates.1`]: '' });
  });

  it.each([
    [
      '/api/router/parental/templates/1/periods',
      { start: '20:00', end: '08:00', days: [1] },
      'end',
    ],
    [
      '/api/router/parental/templates/1/periods',
      { start: '8:00', end: '09:00', days: [1] },
      'start',
    ],
    [
      '/api/router/parental/templates/1/periods',
      { start: '08:00', end: '09:00', days: [] },
      'days',
    ],
    ['/api/router/parental/templates/1/urls', { url: 'not a site' }, 'url'],
    ['/api/router/parental/templates', { name: 'bad"name' }, 'name'],
  ])('rejects invalid input %#', async (path, body, field) => {
    const agent = await signedInAgent();
    const res = await agent.post(path).send(body);
    expect(res.status).toBe(400);
    expect(res.body.details.map((d: { path: string }) => d.path)).toContain(field);
  });

  it('refuses duplicates and reports changes the router did not apply', async () => {
    const agent = await signedInAgent();
    expect(
      (await agent.post('/api/router/parental/templates').send({ name: 'template' })).status
    ).toBe(422);
    router.ignoreWrites = true;
    expect(
      (await agent.patch('/api/router/parental/templates/1').send({ urlEnabled: true })).status
    ).toBe(502);
  });

  it('refuses writes while ROUTER_WRITES_ENABLED is off', async () => {
    setup(false);
    const agent = await signedInAgent();
    expect((await agent.post('/api/router/parental/templates').send({ name: 'Kids' })).status).toBe(
      403
    );
  });
});
