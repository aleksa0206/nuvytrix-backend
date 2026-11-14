import type { Knex } from 'knex';
import { offsetOf, type Pagination } from '../../common/utils/pagination';
import type { AuditEntry, AuditLogRow } from './audit.types';

export class AuditRepository {
  constructor(private db: Knex) {}

  async create(entry: AuditEntry): Promise<void> {
    await this.db('audit_logs').insert({
      admin_id: entry.adminId,
      action: entry.action,
      entity_type: entry.entityType ?? null,
      entity_id: entry.entityId === undefined ? null : String(entry.entityId),
      details: entry.details ?? null,
      ip_address: entry.ipAddress ?? null,
    });
  }

  async findPage(pagination: Pagination): Promise<{ rows: AuditLogRow[]; total: number }> {
    const [rows, countRow] = await Promise.all([
      this.db('audit_logs as a')
        .leftJoin('admins as u', 'u.id', 'a.admin_id')
        .select('a.*', 'u.username')
        .orderBy([
          { column: 'a.created_at', order: 'desc' },
          { column: 'a.id', order: 'desc' },
        ])
        .limit(pagination.pageSize)
        .offset(offsetOf(pagination)),
      this.db('audit_logs').count<{ count: number }[]>('* as count').first(),
    ]);
    return { rows, total: countRow?.count ?? 0 };
  }
}
