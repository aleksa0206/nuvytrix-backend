import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { container, resetContainer } from '../src/container';
import { closeDatabase, prepareDatabase, signedInAgent } from './helpers/testDb';

const received: { headers: IncomingHttpHeaders; body: string }[] = [];
const ntfy = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    received.push({ headers: req.headers, body });
    res.writeHead(req.headers.authorization === 'Bearer tk_test' ? 200 : 403).end('{}');
  });
});
let url = '';

beforeAll(async () => {
  await new Promise<void>((r) => ntfy.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${(ntfy.address() as AddressInfo).port}/nuvytrix`;
});
afterAll(async () => {
  ntfy.close();
  resetContainer();
  await closeDatabase();
});

describe('phone push', () => {
  beforeEach(async () => {
    await prepareDatabase();
    received.length = 0;
  });

  it('pushes a raised alert with its priority and the token, and sends a test message', async () => {
    resetContainer({ push: { url, token: 'tk_test' } });
    await container.alertsService.raise('target_down', 'error', 'Internet is down – čćž');
    await expect.poll(() => received.length).toBe(1);
    const agent = await signedInAgent();
    const test = await agent.post('/api/alerts/push-test');

    expect(received[0]!.body).toBe('Internet is down – čćž');
    expect(received[0]!.headers).toMatchObject({ priority: '4', authorization: 'Bearer tk_test' });
    expect(test.body).toEqual({ enabled: true, sent: true });
  });

  it('keeps the alert when the push fails, and reports push as off when not configured', async () => {
    resetContainer({ push: { url, token: 'wrong' } });
    await container.alertsService.raise('backup_failed', 'warning', 'Backup missing');
    expect((await container.alertsService.list()).alerts).toHaveLength(1);
    resetContainer({ push: { url: '', token: '' } });
    const agent = await signedInAgent();
    expect((await agent.post('/api/alerts/push-test')).body).toEqual({
      enabled: false,
      sent: false,
    });
  });
});
