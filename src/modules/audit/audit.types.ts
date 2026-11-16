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
  | 'router.firewall_settings_changed'
  | 'router.dhcp_server_changed'
  | 'router.dhcp_reservation_created'
  | 'router.dhcp_reservation_updated'
  | 'router.dhcp_reservation_deleted'
  | 'router.mac_filter_settings_changed'
  | 'router.mac_filter_entry_created'
  | 'router.mac_filter_entry_updated'
  | 'router.mac_filter_entry_deleted'
  | 'router.port_mapping_created'
  | 'router.port_mapping_updated'
  | 'router.port_mapping_deleted'
  | 'router.dmz_changed'
  | 'router.dmz_deleted'
  | 'router.port_trigger_created'
  | 'router.port_trigger_updated'
  | 'router.port_trigger_deleted';

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
