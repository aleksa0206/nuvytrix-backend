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
  | 'router.port_trigger_deleted'
  | 'router.wifi_network_created'
  | 'router.wifi_network_updated'
  | 'router.wifi_network_deleted'
  | 'router.parental_template_created'
  | 'router.parental_template_updated'
  | 'router.parental_template_deleted'
  | 'router.parental_period_created'
  | 'router.parental_period_deleted'
  | 'router.parental_url_created'
  | 'router.parental_url_deleted'
  | 'router.parental_device_created'
  | 'router.parental_device_updated'
  | 'router.parental_device_deleted'
  | 'router.dns_host_created'
  | 'router.dns_host_updated'
  | 'router.dns_host_deleted'
  | 'router.ddns_created'
  | 'router.ddns_updated'
  | 'router.ddns_deleted'
  | 'router.upnp_changed'
  | 'router.wifi_schedule_changed'
  | 'router.wifi_radio_changed'
  | 'router.led_changed'
  | 'router.diagnostics_run'
  | 'router.device_access_changed';

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
