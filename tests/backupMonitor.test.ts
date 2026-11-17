import { mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { container, resetContainer } from '../src/container';
import { closeDatabase, prepareDatabase, signedInAgent } from './helpers/testDb';

let dir: string;
const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000);
function put(name: string, data: Buffer, ageHours: number) {
  writeFileSync(join(dir, name), data);
  utimesSync(join(dir, name), hoursAgo(ageHours), hoursAgo(ageHours));
}

afterAll(async () => {
  resetContainer();
  await closeDatabase();
});

describe('backup monitoring', () => {
  beforeEach(async () => {
    await prepareDatabase();
    dir = mkdtempSync(join(tmpdir(), 'nvx-backups-'));
    resetContainer({ backups: { dir, expected: ['nuvytrix', 'remly', 'homewise'] } });
  });

  it('reports newest file, age and integrity per project, and missing projects', async () => {
    put('nuvytrix-2026-11-15.dump', Buffer.from('PGDMP old'), 30);
    put('nuvytrix-2026-11-16.dump', Buffer.from('PGDMP\x01\x0e rest'), 2);
    put('remly-2026-11-16.sql.gz', gzipSync('CREATE TABLE x;'), 3);
    put('notes.txt', Buffer.from('ignored'), 1);

    const agent = await signedInAgent();
    const { body } = await agent.get('/api/server/backups');

    expect(
      body.projects.map((p: { project: string; state: string; files: number }) => [
        p.project,
        p.state,
        p.files,
      ])
    ).toEqual([
      ['homewise', 'missing', 0],
      ['nuvytrix', 'ok', 2],
      ['remly', 'ok', 1],
    ]);
    expect(body.projects[1].latest).toMatchObject({
      name: 'nuvytrix-2026-11-16.dump',
      intact: true,
    });
  });

  it('flags late and unreadable backups, alerts once, and resolves when a good one arrives', async () => {
    resetContainer({ backups: { dir, expected: ['nuvytrix', 'remly'] } });
    put('nuvytrix-2026-11-14.dump', Buffer.from('PGDMP'), 50);
    put('remly-2026-11-16.sql.gz', Buffer.from('not gzip'), 1);
    const backups = container.backupMonitorService;
    const states = (await backups.check()).map((p) => p.state);
    await backups.check();
    expect(states).toEqual(['late', 'broken']);

    put('nuvytrix-2026-11-16.dump', Buffer.from('PGDMP'), 1);
    await backups.check();
    const alerts = (await container.alertsService.list()).alerts;
    expect(alerts.map((a) => a.title).reverse()).toEqual([
      'No new backup of nuvytrix for 50 h (limit 30 h)',
      'Latest backup of remly is unreadable (remly-2026-11-16.sql.gz)',
    ]);
    expect(alerts.find((a) => a.title.includes('nuvytrix'))!.resolvedAt).not.toBeNull();
  });
});
