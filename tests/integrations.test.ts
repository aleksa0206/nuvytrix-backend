import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../src/config/db';
import { resetContainer } from '../src/container';
import { closeDatabase, prepareDatabase, signedInAgent } from './helpers/testDb';

afterAll(async () => {
  resetContainer();
  await closeDatabase();
});

describe('integration health', () => {
  beforeEach(async () => {
    await prepareDatabase();
  });

  it('reports every integration, with failures shown per integration only', async () => {
    resetContainer({
      backups: { dir: mkdtempSync(join(tmpdir(), 'nvx-b-')), expected: ['homewise'] },
      dockerProxyUrl: '',
      sshAuthLog: join(tmpdir(), 'nvx-none', 'auth.log'),
    });
    await db('discovery_scans').insert({
      target: '192.168.100.0/24',
      status: 'failed',
      error: 'nmap timed out',
      finished_at: db.fn.now(),
    });
    const agent = await signedInAgent();
    await agent.get('/api/server/backups'); // first check

    const { body } = await agent.get('/api/integrations');
    const byName = Object.fromEntries(body.map((i: { name: string }) => [i.name, i]));

    expect(Object.keys(byName)).toEqual([
      'Huawei router',
      'Network discovery',
      'Port scans',
      'Monitoring checks',
      'AdGuard Home (DNS)',
      'AdGuard Home (DHCP)',
      'Docker',
      'PostgreSQL',
      'SSH log',
      'Backups',
      'Home VPN (Mullvad)',
      'Tailscale',
    ]);
    expect(byName['Network discovery']).toMatchObject({ state: 'error', error: 'nmap timed out' });
    expect(byName['Docker'].state).toBe('off');
    expect(byName['Backups']).toMatchObject({ state: 'warning', error: 'homewise: missing' });
    expect(byName['Port scans'].state).toBe('off');
  });
});
