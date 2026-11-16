import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../src/config/db';
import { resetContainer } from '../src/container';
import {
  HuaweiWebClient,
  type FormSubmission,
  type RouterPage,
} from '../src/modules/router/huaweiWebClient';
import { parseDiagnosticsResult } from '../src/modules/router/routerDiagnostics.service';
import { UpnpClient } from '../src/modules/router/upnpClient';
import { closeDatabase, prepareDatabase, signedInAgent } from './helpers/testDb';

const esc = (s: string) => s.replace(/\n/g, '\\x0a').replace(/\[/g, '\\x5b').replace(/]/g, '\\x5d');

/** Router stand-in: a test runs for two polls, then completes. */
class DiagRouter extends HuaweiWebClient {
  submissions: FormSubmission[] = [];
  polls = 0;
  log = '';

  constructor() {
    super({ baseUrl: 'http://router.test', username: 'admin', password: 'x' });
  }

  result(): string {
    if (this.submissions.length === 0) return '"NONE[@#@]NONE";';
    const done = this.polls >= 2;
    const output = done
      ? 'PING 1.1.1.1\n4 packets transmitted, 4 packets received'
      : 'PING 1.1.1.1';
    return `"${esc(output)}" + "${esc(`[@#@]${done ? 'Complete' : 'Requested'}`)}";`;
  }

  override async fetchPages<T extends RouterPage>(names: readonly T[]) {
    return Object.fromEntries(
      names.map((n) => {
        if (n === 'userLog') {
          return [
            n,
            `document.getElementById("logarea").value='${this.log}';\n<textarea id="logarea"></textarea>`,
          ];
        }
        this.polls++;
        return [n, this.result()];
      })
    ) as Record<T, string>;
  }

  override async submitForm(form: FormSubmission) {
    this.submissions.push(form);
    return this.result();
  }
}

let router: DiagRouter;

function setup() {
  router = new DiagRouter();
  resetContainer({
    routerWebClient: router,
    upnpClient: new UpnpClient({
      baseUrl: 'http://router.test',
      wanCommonControl: '/c',
      wanIpControl: '/i',
    }),
    routerDiagnosticsTiming: { pollMs: 1, maxWaitMs: 1000 },
  });
}

afterAll(async () => {
  resetContainer();
  await closeDatabase();
});

describe('router diagnostics and user log', () => {
  beforeEach(async () => {
    await prepareDatabase();
    setup();
  });

  it('parses the result pages, joined literals included', () => {
    expect(parseDiagnosticsResult('"NONE\\x5b\\x40\\x23\\x40\\x5dNONE";')).toEqual({
      state: 'NONE',
      output: '',
    });
    expect(parseDiagnosticsResult('"a\\x0ab" + "[@#@]Complete";')).toEqual({
      state: 'Complete',
      output: 'a\nb',
    });
  });

  it('starts a ping the way the router page does and waits for the result', async () => {
    const agent = await signedInAgent();

    const res = await agent.post('/api/router/diagnostics').send({ kind: 'ping', host: '1.1.1.1' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      state: 'Complete',
      output: 'PING 1.1.1.1\n4 packets transmitted, 4 packets received',
    });
    expect(router.submissions[0]).toMatchObject({
      page: 'diagnostics',
      readBack: 'pingResult',
      action: 'complex',
      object: 'InternetGatewayDevice.IPPingDiagnostics',
      extraQuery: { RUNSTATE_FLAG: 'Ping' },
      fields: { 'x.Host': '1.1.1.1', 'RUNSTATE_FLAG.value': 'START' },
    });
    const audit = await db('audit_logs').where({ action: 'router.diagnostics_run' }).first();
    expect(audit.details.requested).toEqual({ kind: 'ping', host: '1.1.1.1' });
  });

  it('runs traceroute on its own object and rejects bad hosts', async () => {
    const agent = await signedInAgent();
    await agent.post('/api/router/diagnostics').send({ kind: 'traceroute', host: 'example.com' });
    expect(router.submissions[0]).toMatchObject({
      object: 'InternetGatewayDevice.TraceRouteDiagnostics',
      readBack: 'traceResult',
      extraQuery: { RUNSTATE_FLAG: 'Traceroute' },
    });
    const bad = await agent
      .post('/api/router/diagnostics')
      .send({ kind: 'ping', host: '1.1.1.1; reboot' });
    expect(bad.status).toBe(400);
  });

  it('returns user log entries without the header', async () => {
    router.log =
      'Manufacturer\\x3aX\\x3b\\x0d\\x0aSerialNumber\\x3aSECRET\\x3b\\x0d\\x0a\\x0d\\x0a' +
      '2026\\x2d11\\x2d16 10\\x3a00\\x3a00 \\x5bConfig\\x2dLog\\x5d login\\x0d\\x0a';
    const agent = await signedInAgent();
    const res = await agent.get('/api/router/user-log');
    expect(res.body).toEqual({ entries: ['2026-11-16 10:00:00 [Config-Log] login'] });
  });
});
