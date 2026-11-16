import { readFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import type { Knex } from 'knex';
import { logger } from '../../config/logger';
import type { AlertsService } from '../alerts/alerts.service';

export interface SshEvent {
  loggedAt: Date;
  pid: number;
  kind: 'accepted' | 'failed' | 'invalid_user';
  username: string | null;
  sourceIp: string | null;
  method: string | null;
}

export interface SshMonitorSettings {
  /** The host's auth.log as mounted read-only into the container; empty turns monitoring off. */
  logPath: string;
  retentionDays: number;
}

/** Failed attempts from one address within the window that raise an alert. */
const FAILED_THRESHOLD = 5;
const FAILED_WINDOW_MINUTES = 10;
const BASELINE_KEY = 'ssh_baseline_done';

// Each pattern ends where sshd ends the line, and the greedy user part makes the LAST
// "from <ip> port <n>" win: a username containing "from 1.2.3.4 port 1" cannot fake the source.
const PREFIX = /^(\S+)\s+\S+\s+sshd\[(\d+)\]:\s+(.*)$/;
const ACCEPTED = /^Accepted (\S+) for (\S+) from (\S+) port \d+ ssh2(?:: .*)?$/;
const FAILED = /^Failed (\S+) for (?:invalid user )?(.*) from (\S+) port \d+ ssh2$/;
const INVALID = /^Invalid user (.*) from (\S+) port \d+$/;

/** sshd lines of a syslog file with ISO timestamps (Ubuntu's rsyslog default). */
export function parseAuthLog(text: string): SshEvent[] {
  const events: SshEvent[] = [];
  for (const line of text.split('\n')) {
    if (!line.includes('sshd[')) continue;
    const head = PREFIX.exec(line);
    if (!head) continue;
    const loggedAt = new Date(head[1]!);
    if (Number.isNaN(loggedAt.getTime())) continue;
    const pid = Number(head[2]);
    const message = head[3]!;
    let m: RegExpExecArray | null;
    if ((m = ACCEPTED.exec(message)) && isIP(m[3]!)) {
      events.push({
        loggedAt,
        pid,
        kind: 'accepted',
        method: m[1]!,
        username: m[2]!,
        sourceIp: m[3]!,
      });
    } else if ((m = FAILED.exec(message)) && isIP(m[3]!)) {
      events.push({
        loggedAt,
        pid,
        kind: 'failed',
        method: m[1]!,
        username: m[2]!,
        sourceIp: m[3]!,
      });
    } else if ((m = INVALID.exec(message)) && isIP(m[2]!)) {
      events.push({
        loggedAt,
        pid,
        kind: 'invalid_user',
        method: null,
        username: m[1] || null,
        sourceIp: m[2]!,
      });
    }
  }
  return events;
}

/** Where an address comes from, for display. */
export function sourceKind(ip: string | null): 'tailscale' | 'lan' | 'internet' | 'unknown' {
  if (!ip) return 'unknown';
  const [a, b] = ip.split('.').map(Number);
  if (a === 100 && b! >= 64 && b! <= 127) return 'tailscale';
  if (a === 10 || (a === 192 && b === 168) || (a === 172 && b! >= 16 && b! <= 31) || a === 127)
    return 'lan';
  return 'internet';
}

/**
 * SSH logins on the server from its auth.log (mounted read-only; the API reads it as a member of
 * the adm group). Stores accepted and failed logins and alerts on a login from a new address and
 * on repeated failures. Changes nothing on the server.
 */
export class SshMonitorService {
  private lastError: { at: Date; message: string } | null = null;
  private lastRun: Date | null = null;
  /** Addresses already alerted for failures; ponytail: in memory, cleared hourly. */
  private reportedFailures = new Map<string, number>();

  constructor(
    private db: Knex,
    private settings: SshMonitorSettings,
    private alerts?: AlertsService
  ) {}

  get enabled(): boolean {
    return this.settings.logPath !== '';
  }

  get health() {
    return { enabled: this.enabled, lastRun: this.lastRun, error: this.lastError };
  }

  /** Reads the log (and once, the rotated one), stores new events and raises alerts. */
  async collect(): Promise<number> {
    if (!this.enabled) return 0;
    try {
      // A persistent marker, not "the table is empty": retention can never turn alerts off again.
      const firstRun =
        (await this.db('app_settings').where({ key: BASELINE_KEY }).first()) === undefined;
      const files = firstRun
        ? [`${this.settings.logPath}.1`, this.settings.logPath]
        : [this.settings.logPath];
      const events: SshEvent[] = [];
      for (const file of files) {
        const text = await readFile(file, 'utf8').catch((err) => {
          if (file === this.settings.logPath) throw err;
          return '';
        });
        events.push(...parseAuthLog(text));
      }
      const knownIps = new Set(
        (await this.db('ssh_events').where('kind', 'accepted').distinct('source_ip')).map((r) =>
          String(r.source_ip)
        )
      );
      let added = 0;
      for (const e of events) {
        const inserted = await this.db('ssh_events')
          .insert({
            logged_at: e.loggedAt,
            pid: e.pid,
            kind: e.kind,
            username: e.username?.slice(0, 64) ?? null,
            source_ip: e.sourceIp,
            method: e.method?.slice(0, 32) ?? null,
          })
          .onConflict(['logged_at', 'pid', 'kind'])
          .ignore()
          .returning('id');
        if (inserted.length === 0) continue;
        added++;
        // The first import is the baseline: no alerts for history.
        if (!firstRun && e.kind === 'accepted' && e.sourceIp && !knownIps.has(e.sourceIp)) {
          knownIps.add(e.sourceIp);
          await this.alerts?.raise(
            'ssh_new_source',
            'warning',
            `SSH login from a new address: ${e.username} from ${e.sourceIp} (${sourceKind(e.sourceIp)})`,
            { username: e.username, ip: e.sourceIp, method: e.method }
          );
        }
      }
      if (firstRun) {
        await this.db('app_settings')
          .insert({ key: BASELINE_KEY, value: 'true' })
          .onConflict('key')
          .ignore();
      } else {
        await this.checkFailures();
      }
      this.lastRun = new Date();
      this.lastError = null;
      return added;
    } catch (err) {
      this.lastError = { at: new Date(), message: (err as Error).message.slice(0, 300) };
      logger.warn({ err: (err as Error).message }, 'SSH log read failed');
      return 0;
    }
  }

  private async checkFailures(): Promise<void> {
    const now = Date.now();
    for (const [ip, at] of this.reportedFailures) {
      if (now - at > 3_600_000) this.reportedFailures.delete(ip);
    }
    const rows = await this.db('ssh_events')
      .whereIn('kind', ['failed', 'invalid_user'])
      .whereRaw('logged_at >= now() - make_interval(mins => ?)', [FAILED_WINDOW_MINUTES])
      .whereNotNull('source_ip')
      .groupBy('source_ip')
      .select('source_ip', this.db.raw('count(*)::int AS n'))
      .havingRaw('count(*) >= ?', [FAILED_THRESHOLD]);
    for (const r of rows) {
      const ip = String(r.source_ip);
      if (this.reportedFailures.has(ip)) continue;
      this.reportedFailures.set(ip, now);
      await this.alerts?.raise(
        'ssh_failures',
        'warning',
        `${r.n} failed SSH logins from ${ip} (${sourceKind(ip)}) in ${FAILED_WINDOW_MINUTES} minutes`,
        { ip, count: r.n }
      );
    }
  }

  async summary(hours: number) {
    const since = this.db.raw('now() - make_interval(hours => ?)', [hours]);
    const [counts, sources, recent] = await Promise.all([
      this.db('ssh_events')
        .where('logged_at', '>=', since)
        .select('kind', this.db.raw('count(*)::int AS n'))
        .groupBy('kind'),
      this.db('ssh_events')
        .where('logged_at', '>=', since)
        .whereNotNull('source_ip')
        .select(
          'source_ip',
          this.db.raw("count(*) FILTER (WHERE kind = 'accepted')::int AS accepted"),
          this.db.raw("count(*) FILTER (WHERE kind <> 'accepted')::int AS failed"),
          this.db.raw('max(logged_at) AS last_at')
        )
        .groupBy('source_ip')
        .orderByRaw('failed DESC, accepted DESC')
        .limit(20),
      this.db('ssh_events').orderBy('logged_at', 'desc').limit(50),
    ]);
    const count = (kind: string) => counts.find((c) => c.kind === kind)?.n ?? 0;
    return {
      hours,
      ...this.health,
      accepted: count('accepted'),
      failed: count('failed') + count('invalid_user'),
      sources: sources.map((s) => ({
        ip: String(s.source_ip),
        kind: sourceKind(String(s.source_ip)),
        accepted: s.accepted,
        failed: s.failed,
        lastAt: s.last_at,
      })),
      recent: recent.map((e) => ({
        at: e.logged_at,
        kind: e.kind,
        username: e.username,
        ip: e.source_ip ? String(e.source_ip) : null,
        source: sourceKind(e.source_ip ? String(e.source_ip) : null),
        method: e.method,
      })),
    };
  }

  /** Old events go, except the latest successful login per address (the "known sources"). */
  deleteExpired(): Promise<number> {
    return this.db('ssh_events')
      .whereRaw('logged_at < now() - make_interval(days => ?)', [this.settings.retentionDays])
      .whereNotIn(
        'id',
        this.db('ssh_events').where('kind', 'accepted').groupBy('source_ip').max('id')
      )
      .delete();
  }
}
