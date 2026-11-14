import { paginate, type Pagination } from '../../common/utils/pagination';
import { logger } from '../../config/logger';
import type { AuditRepository } from './audit.repository';
import type { AuditEntry } from './audit.types';

export class AuditService {
  constructor(private auditRepository: AuditRepository) {}

  /**
   * The audited action has already happened when this runs; failing the request now would
   * report an error for a change that took effect. The failure is logged loudly instead.
   */
  async record(entry: AuditEntry): Promise<void> {
    try {
      await this.auditRepository.create(entry);
    } catch (err) {
      logger.error({ err, action: entry.action }, 'Failed to write audit log entry');
    }
  }

  async list(pagination: Pagination) {
    const { rows, total } = await this.auditRepository.findPage(pagination);
    const entries = rows.map((row) => ({
      id: row.id,
      action: row.action,
      username: row.username,
      entityType: row.entity_type,
      entityId: row.entity_id,
      details: row.details,
      ipAddress: row.ip_address,
      createdAt: row.created_at,
    }));
    return paginate(entries, total, pagination);
  }
}
