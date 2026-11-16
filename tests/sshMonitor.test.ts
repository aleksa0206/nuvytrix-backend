import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../src/config/db';
import { container, resetContainer } from '../src/container';
import { parseAuthLog, sourceKind } from '../src/modules/security/sshMonitor.service';
import { closeDatabase, prepareDatabase, signedInAgent } from './helpers/testDb';

const ts = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
const accepted = (m: number, pid: number, ip: string) =>
  `${ts(m)} aleksa sshd[${pid}]: Accepted publickey for aleksa from ${ip} port 52132 ssh2: ED25519 SHA256:x\n`;
const failed = (m: number, pid: number, ip: string) =>
  `${ts(m)} aleksa sshd[${pid}]: Failed password for invalid user admin from ${ip} port 4000 ssh2\n`;

let log: string;

afterAll(async () => {
  resetContainer();
  await closeDatabase();
});

describe('ssh monitoring', () => {
  beforeEach(async () => {
    await prepareDatabase();
    log = join(mkdtempSync(join(tmpdir(), 'nvx-auth-')), 'auth.log');
    writeFileSync(
      log,
      `${ts(60)} aleksa CRON[1]: pam_unix(cron:session): session opened\n` +
        accepted(50, 100, '100.101.1.1')
    );
    resetContainer({ sshAuthLog: log });
  });

  it('parses accepted, failed and invalid-user lines and classifies sources', () => {
    const text =
      accepted(1, 1, '100.101.1.1') +
      failed(1, 2, '203.0.113.9') +
      `${ts(1)} aleksa sshd[3]: Invalid user test from 192.168.100.8 port 1\n` +
      `${ts(1)} aleksa sshd[4]: Received disconnect from 1.2.3.4 port 1:11: bye\n`;
    expect(parseAuthLog(text).map((e) => [e.kind, e.username, e.sourceIp])).toEqual([
      ['accepted', 'aleksa', '100.101.1.1'],
      ['failed', 'admin', '203.0.113.9'],
      ['invalid_user', 'test', '192.168.100.8'],
    ]);
    expect(['100.101.1.1', '192.168.100.8', '203.0.113.9'].map(sourceKind)).toEqual([
      'tailscale',
      'lan',
      'internet',
    ]);
  });

  it('takes the first read as baseline, then alerts on a new source and on repeated failures once', async () => {
    const ssh = container.sshMonitorService;
    expect(await ssh.collect()).toBe(1);
    appendFileSync(log, accepted(5, 101, '100.101.1.1') + accepted(4, 102, '192.168.100.2'));
    for (let i = 0; i < 6; i++) appendFileSync(log, failed(3, 200 + i, '203.0.113.9'));
    await ssh.collect();
    await ssh.collect(); // nothing new: no duplicates, no repeated alerts

    const titles = (await container.alertsService.list()).alerts.map((a) => a.title).reverse();
    expect(titles).toEqual([
      'SSH login from a new address: aleksa from 192.168.100.2 (lan)',
      '6 failed SSH logins from 203.0.113.9 (internet) in 10 minutes',
    ]);

    const agent = await signedInAgent();
    const { body } = await agent.get('/api/security/ssh?hours=24');
    expect(body).toMatchObject({ accepted: 3, failed: 6, error: null });
    expect(body.sources[0]).toMatchObject({ ip: '203.0.113.9', kind: 'internet', failed: 6 });
  });

  it('counts failed key logins with a key suffix, and unparseable failures without an address', () => {
    const text =
      `${ts(1)} aleksa sshd[11]: Failed publickey for root from 203.0.113.5 port 22 ssh2: RSA SHA256:abc
` +
      `${ts(1)} aleksa sshd[12]: Failed password for root from not-an-ip port 22 ssh2
`;
    expect(parseAuthLog(text).map((e) => [e.kind, e.sourceIp])).toEqual([
      ['failed', '203.0.113.5'],
      ['failed', null],
    ]);
  });

  it('takes the last "from <ip>" so a crafted username cannot fake the source', () => {
    const crafted =
      `${ts(1)} aleksa sshd[9]: Invalid user x from 10.0.0.1 port 1 from 203.0.113.50 port 4242\n` +
      `${ts(1)} aleksa sshd[10]: Failed password for invalid user y from 192.168.100.2 port 22 from 198.51.100.7 port 555 ssh2\n`;
    expect(parseAuthLog(crafted).map((e) => e.sourceIp)).toEqual(['203.0.113.50', '198.51.100.7']);
  });

  it('keeps alerting after retention emptied the table', async () => {
    const ssh = container.sshMonitorService;
    await ssh.collect(); // baseline
    await db('ssh_events').delete();
    writeFileSync(log, accepted(1, 300, '192.168.100.9'));
    await ssh.collect();
    const titles = (await container.alertsService.list()).alerts.map((a) => a.title);
    expect(titles).toEqual(['SSH login from a new address: aleksa from 192.168.100.9 (lan)']);
  });

  it('reports an unreadable log as an error instead of failing', async () => {
    resetContainer({ sshAuthLog: join(tmpdir(), 'nvx-missing', 'auth.log') });
    expect(await container.sshMonitorService.collect()).toBe(0);
    expect(container.sshMonitorService.health.error).not.toBeNull();
  });
});
