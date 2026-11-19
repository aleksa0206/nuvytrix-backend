import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../src/config/db';
import { container, resetContainer } from '../src/container';
import { closeDatabase, prepareDatabase, signedInAgent } from './helpers/testDb';

const file = join(mkdtempSync(join(tmpdir(), 'nvx-vpn-')), 'vpn.json');
const write = (mode: string, checkedAt = new Date().toISOString()) =>
  writeFileSync(
    file,
    JSON.stringify({ mode, since: '2026-11-20T00:00:00Z', checkedAt, reason: 'test' })
  );

afterAll(async () => {
  resetContainer();
  await closeDatabase();
});

describe('home VPN monitor', () => {
  beforeEach(async () => {
    await prepareDatabase();
    resetContainer({ vpnStateFile: file });
  });

  it('alerts once while the home goes out directly, and once when the tunnel is back', async () => {
    write('direct');
    await container.vpnMonitorService.check();
    await container.vpnMonitorService.check();
    write('vpn');
    await container.vpnMonitorService.check();
    await container.vpnMonitorService.check();
    const alerts = await db('alerts').orderBy('id');
    expect(alerts.map((a) => [a.kind, a.resolved_at !== null])).toEqual([
      ['vpn_direct', true],
      ['vpn_restored', false],
    ]);
  });

  it('shows the state on the integrations list, and a stale file as a warning', async () => {
    write('vpn');
    await container.vpnMonitorService.check();
    const agent = await signedInAgent();
    const line = async () =>
      (await agent.get('/api/integrations')).body.find(
        (i: { name: string }) => i.name === 'Home VPN (Mullvad)'
      );
    expect(await line()).toMatchObject({ state: 'ok', detail: 'home traffic through Mullvad' });

    write('vpn', new Date(Date.now() - 10 * 60_000).toISOString());
    await container.vpnMonitorService.check();
    expect(await line()).toMatchObject({
      state: 'warning',
      error: 'Watchdog stopped writing its state',
    });
  });
});
