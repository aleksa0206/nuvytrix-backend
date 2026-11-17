import type { Knex } from 'knex';
import { logger } from '../../config/logger';

export type AlertKind =
  | 'target_down'
  | 'target_up'
  | 'new_device'
  | 'mac_changed'
  | 'ip_conflict'
  | 'optical_weak'
  | 'optical_ok'
  | 'optical_loss'
  | 'certificate_expiring'
  | 'server_power'
  | 'server_disk'
  | 'server_memory'
  | 'server_temperature'
  | 'database_down'
  | 'container_down'
  | 'container_up'
  | 'container_restarted'
  | 'container_unhealthy'
  | 'port_opened'
  | 'port_closed'
  | 'service_changed'
  | 'ssh_new_source'
  | 'ssh_failures'
  | 'high_latency'
  | 'backup_failed';
export type AlertSeverity = 'info' | 'warning' | 'error';

interface AlertRow {
  id: number;
  kind: AlertKind;
  severity: AlertSeverity;
  title: string;
  details: Record<string, unknown> | null;
  created_at: Date;
  read_at: Date | null;
  resolved_at: Date | null;
}

const LIST_LIMIT = 50;
/** Matches the column length. */
const TITLE_MAX = 200;
const RETENTION_DAYS = 90;
/** ntfy priorities: 4 high, 3 default, 2 low. */
const PUSH_PRIORITY: Record<AlertSeverity, string> = { error: '4', warning: '3', info: '2' };

/**
 * Where alerts are also pushed to phones: a self-hosted ntfy topic URL (reachable only over
 * Tailscale), and its access token. Empty url = in-app only.
 */
export interface PushSettings {
  url: string;
  token: string;
}

/** Notifications shown in the app and pushed to phones. Raising one never fails the caller. */
export class AlertsService {
  constructor(
    private db: Knex,
    private push: PushSettings = { url: '', token: '' }
  ) {}

  get pushEnabled(): boolean {
    return this.push.url !== '';
  }

  /**
   * Sends one push message. Failures are logged without the token or URL credentials and never
   * reach the caller (the alert is already stored in the app).
   */
  async sendPush(title: string, severity: AlertSeverity): Promise<boolean> {
    if (!this.pushEnabled) return false;
    try {
      const res = await fetch(this.push.url, {
        method: 'POST',
        headers: {
          // Header values must be Latin-1; the full title goes in the UTF-8 body.
          Title: 'Nuvytrix',
          Priority: PUSH_PRIORITY[severity],
          ...(this.push.token ? { Authorization: `Bearer ${this.push.token}` } : {}),
        },
        body: title,
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) logger.warn({ status: res.status }, 'Push notification rejected');
      return res.ok;
    } catch (err) {
      logger.warn({ error: (err as Error).name }, 'Push notification not sent');
      return false;
    }
  }

  async raise(
    kind: AlertKind,
    severity: AlertSeverity,
    title: string,
    details: Record<string, unknown> = {},
    /**
     * The subject of an ongoing problem (e.g. `target:3`): while an alert with this key is open
     * (not resolved), the same problem is not raised again, also across restarts.
     */
    key?: string
  ): Promise<void> {
    try {
      if (key) {
        const open = await this.db('alerts').where({ key }).whereNull('resolved_at').first('id');
        if (open) return;
      }
      // Titles can carry names from the network (DHCP hostnames); never let a long one drop the alert.
      const safeTitle = title.length > TITLE_MAX ? `${title.slice(0, TITLE_MAX - 1)}…` : title;
      await this.db('alerts').insert({
        kind,
        severity,
        title: safeTitle,
        details: JSON.stringify(details),
        key: key?.slice(0, 160) ?? null,
      });
      logger.info({ kind, title }, 'Alert raised');
      void this.sendPush(safeTitle, severity);
    } catch (err) {
      logger.error({ err, kind }, 'Could not store alert');
    }
  }

  /** Marks the open alert for a subject as resolved; returns whether there was one. */
  async resolve(key: string): Promise<boolean> {
    try {
      const n = await this.db('alerts')
        .where({ key })
        .whereNull('resolved_at')
        .update({ resolved_at: this.db.fn.now() });
      return n > 0;
    } catch (err) {
      logger.error({ err, key }, 'Could not resolve alert');
      return false;
    }
  }

  /** Whether a subject currently has an open alert. */
  async isOpen(key: string): Promise<boolean> {
    return (
      (await this.db('alerts').where({ key }).whereNull('resolved_at').first('id')) !== undefined
    );
  }

  async unreadCount(): Promise<number> {
    const row = await this.db('alerts')
      .whereNull('read_at')
      .count<{ count: number }[]>({ count: '*' })
      .first();
    return Number(row?.count ?? 0);
  }

  async list() {
    const [rows, unread] = await Promise.all([
      this.db<AlertRow>('alerts').orderBy('id', 'desc').limit(LIST_LIMIT),
      this.unreadCount(),
    ]);
    return {
      unread,
      alerts: rows.map((row) => ({
        id: row.id,
        kind: row.kind,
        severity: row.severity,
        title: row.title,
        details: row.details,
        createdAt: row.created_at,
        read: row.read_at !== null,
        resolvedAt: row.resolved_at,
      })),
    };
  }

  async markAllRead(): Promise<number> {
    return this.db('alerts').whereNull('read_at').update({ read_at: this.db.fn.now() });
  }

  deleteExpired(): Promise<number> {
    return this.db('alerts')
      .where('created_at', '<', new Date(Date.now() - RETENTION_DAYS * 86_400_000))
      .delete();
  }
}
