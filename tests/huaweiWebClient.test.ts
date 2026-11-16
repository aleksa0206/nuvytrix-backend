import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HuaweiWebClient, RouterAuthError } from '../src/modules/router/huaweiWebClient';
import {
  DEVICE_INFO_PAGE,
  IP_FILTER_PAGE,
  LOGIN_REDIRECT_PAGE,
  OPTIC_PAGE,
} from './fixtures/huawei';

/** Minimal stand-in for the router: login, session cookie, two data pages, logout. */
class FakeRouter {
  server!: Server;
  password = 'right-password';
  requests: { method: string; path: string; body: string; referer?: string }[] = [];
  loggedOut = 0;
  sessionValid = true;

  async start(): Promise<string> {
    this.server = createServer(async (req, res) => {
      const body = await readBody(req);
      const path = req.url ?? '';
      this.requests.push({ method: req.method ?? '', path, body, referer: req.headers.referer });
      const session = (req.headers.cookie ?? '').includes('sid=s3ssion') && this.sessionValid;

      if (path === '/asp/GetRandCount.asp') return res.end('﻿tok123');
      if (path === '/login.cgi') {
        const form = new URLSearchParams(body);
        const ok =
          form.get('UserName') === 'admin' &&
          form.get('PassWord') === Buffer.from(this.password).toString('base64') &&
          form.get('x.X_HW_Token') === 'tok123';
        if (ok)
          res.setHeader('Set-Cookie', 'Cookie=sid=s3ssion:Language:english:id=1;path=/;HttpOnly');
        return res.end('<script>window.location="/index.asp"</script>');
      }
      if (path.startsWith('/logout.cgi')) {
        this.loggedOut++;
        return res.end('');
      }
      if (!session) return res.end(LOGIN_REDIRECT_PAGE);
      if (path === '/html/ssmp/deviceinfo/deviceinfo.asp') return res.end(DEVICE_INFO_PAGE);
      if (path === '/html/amp/opticinfo/opticinfo.asp') return res.end(OPTIC_PAGE);
      if (path === '/html/bbsp/ipincoming/ipincoming.asp') return res.end(IP_FILTER_PAGE);
      if (path.startsWith('/html/bbsp/ipincoming/add.cgi')) return res.end(IP_FILTER_PAGE);
      res.statusCode = 404;
      res.end('not found');
    });
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  stop() {
    return new Promise((resolve) => this.server.close(resolve));
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => resolve(data));
  });
}

describe('HuaweiWebClient', () => {
  let router: FakeRouter;
  let baseUrl: string;

  beforeEach(async () => {
    router = new FakeRouter();
    baseUrl = await router.start();
  });
  afterEach(() => router.stop());

  const client = (password = 'right-password') =>
    new HuaweiWebClient({ baseUrl, username: 'admin', password, loginCooldownMs: 60_000 });

  it('logs in like the router UI, reads pages with one session and logs out', async () => {
    const pages = await client().fetchPages(['systemInfo', 'optical'] as const);

    expect(pages.systemInfo).toContain('stDeviceInfo');
    expect(pages.optical).toContain('stOpticInfo');
    expect(router.requests.filter((r) => r.path === '/login.cgi')).toHaveLength(1);
    expect(router.loggedOut).toBe(1);
    const dataRequests = router.requests.filter(
      (r) => r.path.endsWith('.asp') && !r.path.startsWith('/asp/')
    );
    expect(dataRequests.every((r) => r.method === 'GET')).toBe(true);
  });

  it('does not retry a failed login and pauses further logins to avoid the 3-attempt lock', async () => {
    const wrong = client('wrong-password');

    await expect(wrong.fetchPages(['systemInfo'] as const)).rejects.toBeInstanceOf(RouterAuthError);
    await expect(wrong.fetchPages(['systemInfo'] as const)).rejects.toThrow(/paused/);

    expect(router.requests.filter((r) => r.path === '/login.cgi')).toHaveLength(1);
  });

  it('treats a login redirect in the middle of a poll as an error and still logs out', async () => {
    router.sessionValid = false;

    await expect(client().fetchPages(['systemInfo'] as const)).rejects.toThrow(/session ended/);
    expect(router.loggedOut).toBe(1);
  });

  it('refuses to work without credentials', async () => {
    const empty = new HuaweiWebClient({ baseUrl, username: '', password: '' });

    expect(empty.isConfigured).toBe(false);
    await expect(empty.fetchPages(['systemInfo'] as const)).rejects.toThrow(/not configured/);
    expect(router.requests).toHaveLength(0);
  });

  it('only ever requests allow-listed pages and never a configuration CGI', async () => {
    await client().fetchPages(['systemInfo', 'optical'] as const);

    const cgis = router.requests.map((r) => r.path).filter((p) => p.includes('.cgi'));
    expect(cgis.every((p) => p === '/login.cgi' || p.startsWith('/logout.cgi'))).toBe(true);
  });

  it('submits a form like the router page: page-relative CGI, page token, Referer, read-back', async () => {
    const after = await client().submitForm({
      page: 'ipFilter',
      action: 'add',
      object: 'InternetGatewayDevice.X_HW_Security.IpFilterIn',
      fields: { 'x.Name': 'test', 'x.Protocol': 'TCP/UDP' },
    });

    expect(after).toContain('stPortFilter');
    const post = router.requests.find((r) => r.path.includes('add.cgi'))!;
    expect(post.path).toBe(
      '/html/bbsp/ipincoming/add.cgi?x=InternetGatewayDevice.X_HW_Security.IpFilterIn&RequestFile=html/bbsp/ipincoming/ipincoming.asp'
    );
    expect(post.referer).toBe(`${baseUrl}/html/bbsp/ipincoming/ipincoming.asp`);
    expect(Object.fromEntries(new URLSearchParams(post.body))).toEqual({
      'x.Name': 'test',
      'x.Protocol': 'TCP/UDP',
      'x.X_HW_Token': '10403e71ab7741169fd252b637f4efbb',
    });
    const pageReads = router.requests.filter((r) => r.method === 'GET' && r.path.endsWith('.asp'));
    expect(pageReads).toHaveLength(2);
    expect(router.requests.filter((r) => r.path === '/login.cgi')).toHaveLength(1);
    expect(router.loggedOut).toBe(1);
  });

  it('refuses forms and object paths outside the allow-list without contacting the router', async () => {
    await expect(
      client().submitForm({ page: 'ipFilter', action: 'reboot' as 'add', fields: {} })
    ).rejects.toThrow(/Refusing/);
    await expect(
      client().submitForm({
        page: 'ipFilter',
        action: 'set',
        object: 'InternetGatewayDevice.X&RequestFile=x',
        fields: {},
      })
    ).rejects.toThrow(/Refusing/);
    await expect(
      client().submitForm({
        page: 'portMapping',
        action: 'complexajax',
        object: 'InternetGatewayDevice.X',
        extraQuery: { ma: 'x&RequestFile=evil' },
        fields: {},
      })
    ).rejects.toThrow(/Refusing/);
    await expect(
      client().submitForm({
        page: 'portMapping',
        action: 'addcfgajax',
        objectKey: 'a&b',
        object: 'InternetGatewayDevice.X',
        fields: {},
      })
    ).rejects.toThrow(/Refusing/);
    expect(router.requests).toHaveLength(0);
  });
});
