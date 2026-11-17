import { createReadStream } from 'node:fs';
import { open, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createGunzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { Writable } from 'node:stream';
import { DEFAULT_THRESHOLDS, type AlertSettingsService } from '../alerts/alertSettings.service';
import type { AlertsService } from '../alerts/alerts.service';

export interface BackupSettings {
  /** The backup directory as mounted read-only into the container; empty turns this off. */
  dir: string;
  /** Projects that should have a backup, so a missing one shows up (e.g. "nuvytrix,remly"). */
  expected: string[];
}

export interface BackupStatus {
  project: string;
  files: number;
  latest: { name: string; sizeBytes: number; at: Date; intact: boolean | null } | null;
  ageHours: number | null;
  state: 'ok' | 'late' | 'missing' | 'broken';
}

// Files written by the backup scripts: <project>-YYYY-MM-DD.dump (pg_dump -Fc) or .sql.gz (mysqldump).
const FILE = /^([a-z0-9-]+?)-(\d{4}-\d{2}-\d{2})\.(dump|sql\.gz)$/;

/** A pg_dump custom-format file starts with "PGDMP"; a gzip file must decompress to the end. */
async function intact(path: string, kind: string): Promise<boolean> {
  try {
    if (kind === 'dump') {
      const handle = await open(path, 'r');
      try {
        const { buffer } = await handle.read(Buffer.alloc(5), 0, 5, 0);
        return buffer.toString('latin1') === 'PGDMP';
      } finally {
        await handle.close();
      }
    }
    await pipeline(
      createReadStream(path),
      createGunzip(),
      new Writable({ write: (_c, _e, cb) => cb() })
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * The server's existing database backups (written by cron'd backup.sh scripts to the data disk):
 * per project the newest file, its size, age and whether it is readable. Nothing is created or
 * changed here. Alerts when a project's newest good backup is older than the threshold.
 */
export class BackupMonitorService {
  private latest: { checkedAt: Date; projects: BackupStatus[]; error: string | null } | null = null;

  constructor(
    private settings: BackupSettings,
    private alerts?: AlertsService,
    private thresholds?: AlertSettingsService
  ) {}

  get enabled(): boolean {
    return this.settings.dir !== '';
  }

  get status() {
    return {
      enabled: this.enabled,
      checkedAt: this.latest?.checkedAt ?? null,
      error: this.latest?.error ?? null,
      projects: this.latest?.projects ?? [],
    };
  }

  async check(): Promise<BackupStatus[]> {
    if (!this.enabled) return [];
    let names: string[];
    try {
      names = await readdir(this.settings.dir);
    } catch (err) {
      this.latest = {
        checkedAt: new Date(),
        projects: [],
        error: (err as Error).message.slice(0, 200),
      };
      return [];
    }
    const byProject = new Map<string, { name: string; kind: string }[]>();
    for (const name of names) {
      const m = FILE.exec(name);
      if (!m) continue;
      byProject.set(m[1]!, [...(byProject.get(m[1]!) ?? []), { name, kind: m[3]! }]);
    }
    const maxAge = (this.thresholds?.current ?? DEFAULT_THRESHOLDS).backupMaxAgeHours;
    const projects: BackupStatus[] = [];
    for (const project of [...new Set([...this.settings.expected, ...byProject.keys()])].sort()) {
      const files = (byProject.get(project) ?? []).sort((a, b) => b.name.localeCompare(a.name));
      const newest = files[0];
      if (!newest) {
        projects.push({ project, files: 0, latest: null, ageHours: null, state: 'missing' });
        continue;
      }
      const path = join(this.settings.dir, newest.name);
      const info = await stat(path);
      const ok = await intact(path, newest.kind);
      const ageHours = Math.round(((Date.now() - info.mtime.getTime()) / 3_600_000) * 10) / 10;
      projects.push({
        project,
        files: files.length,
        latest: { name: newest.name, sizeBytes: info.size, at: info.mtime, intact: ok },
        ageHours,
        state: !ok ? 'broken' : ageHours > maxAge ? 'late' : 'ok',
      });
    }
    this.latest = { checkedAt: new Date(), projects, error: null };
    await this.checkAlerts(projects, maxAge);
    return projects;
  }

  private async checkAlerts(projects: BackupStatus[], maxAge: number) {
    if (!this.alerts) return;
    for (const p of projects) {
      const key = `backup:${p.project}`;
      if (p.state === 'ok') {
        await this.alerts.resolve(key);
        continue;
      }
      const title =
        p.state === 'missing'
          ? `No backup found for ${p.project}`
          : p.state === 'broken'
            ? `Latest backup of ${p.project} is unreadable (${p.latest!.name})`
            : `No new backup of ${p.project} for ${Math.floor(p.ageHours!)} h (limit ${maxAge} h)`;
      await this.alerts.raise(
        'backup_failed',
        p.state === 'late' ? 'warning' : 'error',
        title,
        { project: p.project, state: p.state },
        key
      );
    }
  }
}
