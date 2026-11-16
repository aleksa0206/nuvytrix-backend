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
  | 'ssh_failures';
export type AlertSeverity = 'info' | 'warning' | 'error';

interface AlertRow {
  id: number;
  kind: AlertKind;
  severity: AlertSeverity;
  title: string;
  details: Record<string, unknown> | null;
  created_at: Date;
  read_at: Date | null;
}

const LIST_LIMIT = 50;
/** Matches the column length. */
const TITLE_MAX = 200;
const RETENTION_DAYS = 90;

/** Notifications shown in the app. Raising one never fails the caller. */
export class AlertsService {
  constructor(private db: Knex) {}

  async raise(
    kind: AlertKind,
    severity: AlertSeverity,
    title: string,
    details: Record<string, unknown> = {}
  ): Promise<void> {
    try {
      // Titles can carry names from the network (DHCP hostnames); never let a long one drop the alert.
      const safeTitle = title.length > TITLE_MAX ? `${title.slice(0, TITLE_MAX - 1)}…` : title;
      await this.db('alerts').insert({
        kind,
        severity,
        title: safeTitle,
        details: JSON.stringify(details),
      });
      logger.info({ kind, title }, 'Alert raised');
    } catch (err) {
      logger.error({ err, kind }, 'Could not store alert');
    }
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
