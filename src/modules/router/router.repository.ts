import type { Knex } from 'knex';

export interface RouterSampleInput {
  uptimeSeconds: number | null;
  cpuPercent: number | null;
  memoryPercent: number | null;
  opticalRxDbm: number | null;
  opticalTxDbm: number | null;
  opticalTemperatureC: number | null;
  opticalVoltageMv: number | null;
  opticalBiasMa: number | null;
  wanBytesSent: number | null;
  wanBytesReceived: number | null;
  ponBytesSent: number | null;
  ponBytesReceived: number | null;
  wifiClients: number | null;
  devicesOnline: number | null;
  lanPorts: unknown;
  wlan: unknown;
}

export interface RouterSampleRow {
  captured_at: Date;
  uptime_seconds: number | null;
  cpu_percent: number | null;
  memory_percent: number | null;
  optical_rx_dbm: number | null;
  optical_tx_dbm: number | null;
  optical_temperature_c: number | null;
  wan_bytes_sent: number | null;
  wan_bytes_received: number | null;
  pon_bytes_sent: number | null;
  pon_bytes_received: number | null;
  wifi_clients: number | null;
  devices_online: number | null;
  lan_ports: { bytesSent: number; bytesReceived: number }[] | null;
  wlan: { bytesSent: number; bytesReceived: number }[] | null;
}

export class RouterRepository {
  constructor(private db: Knex) {}

  async insertSample(sample: RouterSampleInput): Promise<void> {
    await this.db('router_samples').insert({
      uptime_seconds: sample.uptimeSeconds,
      cpu_percent: sample.cpuPercent,
      memory_percent: sample.memoryPercent,
      optical_rx_dbm: sample.opticalRxDbm,
      optical_tx_dbm: sample.opticalTxDbm,
      optical_temperature_c: sample.opticalTemperatureC,
      optical_voltage_mv: sample.opticalVoltageMv,
      optical_bias_ma: sample.opticalBiasMa,
      wan_bytes_sent: sample.wanBytesSent,
      wan_bytes_received: sample.wanBytesReceived,
      pon_bytes_sent: sample.ponBytesSent,
      pon_bytes_received: sample.ponBytesReceived,
      wifi_clients: sample.wifiClients,
      devices_online: sample.devicesOnline,
      lan_ports: JSON.stringify(sample.lanPorts ?? null),
      wlan: JSON.stringify(sample.wlan ?? null),
    });
  }

  findSamplesSince(since: Date): Promise<RouterSampleRow[]> {
    return this.db('router_samples')
      .where('captured_at', '>=', since)
      .orderBy('captured_at')
      .select(
        'captured_at',
        'uptime_seconds',
        'cpu_percent',
        'memory_percent',
        'optical_rx_dbm',
        'optical_tx_dbm',
        'optical_temperature_c',
        'wan_bytes_sent',
        'wan_bytes_received',
        'pon_bytes_sent',
        'pon_bytes_received',
        'wifi_clients',
        'devices_online',
        'lan_ports',
        'wlan'
      );
  }

  deleteSamplesBefore(cutoff: Date): Promise<number> {
    return this.db('router_samples').where('captured_at', '<', cutoff).delete();
  }
}
