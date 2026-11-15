import type { FirewallAction, FirewallDirection } from './huaweiLogParser';

export interface FirewallEventRow {
  id: number;
  import_id: number;
  occurred_at: Date;
  severity: string | null;
  in_interface: string | null;
  out_interface: string | null;
  direction_raw: string | null;
  direction: FirewallDirection | null;
  action_raw: string;
  action: FirewallAction;
  source_ip: string;
  destination_ip: string;
  ip_version: number;
  protocol: string;
  source_port: number | null;
  destination_port: number | null;
  raw_line: string;
}

export interface FirewallImportRow {
  id: number;
  file_name: string;
  file_size_bytes: number;
  file_sha256: string;
  total_lines: number;
  parsed_events: number;
  inserted_events: number;
  duplicate_events: number;
  rejected_lines: number;
  blank_lines: number;
  first_event_at: Date | null;
  last_event_at: Date | null;
  imported_by: number | null;
  created_at: Date;
}

export interface FirewallEventQuery {
  page: number;
  pageSize: number;
  action?: FirewallAction;
  direction?: FirewallDirection;
  flow?: 'inbound' | 'outbound';
  protocol?: string;
  ipVersion?: 4 | 6;
  ip?: string;
  port?: number;
  from?: Date;
  to?: Date;
  importId?: number;
  sort: 'occurred_at' | 'source_ip' | 'destination_ip' | 'destination_port';
  order: 'asc' | 'desc';
}

export interface TimeRange {
  from: Date;
  to: Date;
}
