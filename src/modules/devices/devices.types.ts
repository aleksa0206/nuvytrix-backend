export const DEVICE_TYPES = [
  'router',
  'switch',
  'access_point',
  'server',
  'computer',
  'laptop',
  'phone',
  'tablet',
  'tv',
  'printer',
  'iot',
  'console',
  'other',
] as const;

export type DeviceType = (typeof DEVICE_TYPES)[number];

export interface DeviceRow {
  id: number;
  mac_address: string | null;
  ip_address: string;
  hostname: string | null;
  vendor: string | null;
  custom_name: string | null;
  device_type: DeviceType | null;
  notes: string | null;
  tags: string[];
  trusted: boolean | null;
  address_source: string | null;
  lease_expires_at: Date | null;
  reserved_ip: string | null;
  connection: string | null;
  ports_scanned_at: Date | null;
  first_seen_at: Date;
  last_seen_at: Date;
  last_scan_id: number | null;
}

export interface ScanRow {
  id: number;
  target: string;
  status: 'running' | 'completed' | 'failed';
  triggered_by: number | null;
  started_at: Date;
  finished_at: Date | null;
  hosts_up: number | null;
  new_devices: number | null;
  error: string | null;
}

export interface ObservationRow {
  id: number;
  scan_id: number;
  ip_address: string;
  hostname: string | null;
  observed_at: Date;
}

export type DeviceStatusFilter = 'online' | 'offline' | 'new';

export interface DeviceListQuery {
  page: number;
  pageSize: number;
  search?: string;
  status?: DeviceStatusFilter;
  trust?: 'trusted' | 'untrusted' | 'unreviewed';
  tag?: string;
  sort: 'last_seen_at' | 'first_seen_at' | 'ip_address' | 'name';
  order: 'asc' | 'desc';
}
