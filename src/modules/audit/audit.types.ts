export type AuditAction =
  | 'auth.login'
  | 'auth.login_failed'
  | 'auth.logout'
  | 'discovery.scan_started'
  | 'device.updated'
  | 'firewall.log_imported'
  | 'firewall.policy_created'
  | 'firewall.policy_updated'
  | 'firewall.policy_status_changed'
  | 'firewall.policy_deleted'
  | 'monitoring.target_created'
  | 'monitoring.target_updated'
  | 'monitoring.target_deleted'
  | 'router.firewall_rule_created'
  | 'router.firewall_rule_updated'
  | 'router.firewall_rule_deleted'
  | 'router.firewall_settings_changed';

export interface AuditEntry {
  adminId: number | null;
  action: AuditAction;
  entityType?: string;
  entityId?: string | number;
  details?: Record<string, unknown>;
  ipAddress?: string;
}

export interface AuditLogRow {
  id: number;
  admin_id: number | null;
  username: string | null;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  details: Record<string, unknown> | null;
  ip_address: string | null;
  created_at: Date;
}
