import type { AlertsService } from '../alerts/alerts.service';
import { AppError } from '../../common/errors/AppError';
import { ErrorCode } from '../../common/errors/errorCodes';
import { logger } from '../../config/logger';
import type { DevicesRepository } from '../devices/devices.repository';
import type { FirewallService } from '../firewall/firewall.service';
import {
  parseFirewallLogText,
  parseIpFilter,
  parseLanPorts,
  parseOptical,
  parseRouterDevices,
  parseSystemInfo,
  parseWifiClients,
  parseWlan,
  type IpFilterState,
  type LanPort,
  type OpticalInfo,
  type RouterDevice,
  type RouterSystemInfo,
  type WifiClient,
  type WlanInterface,
} from './huaweiParser';
import type { HuaweiWebClient } from './huaweiWebClient';
import type { RouterRepository, RouterSampleRow } from './router.repository';
import type { PortMapping, UpnpClient, WanStatus } from './upnpClient';

export interface RouterSnapshot {
  capturedAt: Date;
  system: RouterSystemInfo | null;
  optical: OpticalInfo | null;
  wan: WanStatus | null;
  lanPorts: LanPort[] | null;
  wlan: WlanInterface[] | null;
  ipFilter: IpFilterState | null;
  devices: RouterDevice[];
  wifiClients: WifiClient[];
  /** Sections that could not be read in this poll, with the reason. */
  errors: { section: string; message: string }[];
}

export interface RouterSettings {
  host: string;
  pollSeconds: number;
  retentionDays: number;
}

const POLL_PAGES = [
  'systemInfo',
  'optical',
  'ethernet',
  'wlan',
  'wifiClients',
  'devices',
  'ipFilter',
] as const;

type OpticalState = 'unknown' | 'ok' | 'weak' | 'loss';
const OPTICAL_WEAK_DBM = -27;
const OPTICAL_OK_DBM = -25;

/**
 * Reads the Huawei router through its web UI (with the administrator's account) and UPnP. Nothing
 * here changes router configuration; writes live in RouterFirewallService. See docs/huawei/.
 */
export class RouterService {
  private snapshot: RouterSnapshot | null = null;
  private opticalState: OpticalState = 'unknown';
  private polling: Promise<RouterSnapshot> | null = null;

  constructor(
    private web: HuaweiWebClient,
    private upnp: UpnpClient,
    private routerRepository: RouterRepository,
    private devicesRepository: DevicesRepository,
    private firewallService: FirewallService,
    private settings: RouterSettings,
    private alerts?: AlertsService
  ) {}

  get isConfigured(): boolean {
    return this.settings.host !== '' && this.web.isConfigured;
  }

  /** One poll at a time; a second caller gets the poll already running. */
  poll(): Promise<RouterSnapshot> {
    if (!this.polling) {
      this.polling = this.runPoll().finally(() => {
        this.polling = null;
      });
    }
    return this.polling;
  }

  get isPolling(): boolean {
    return this.polling !== null;
  }

  private async runPoll(): Promise<RouterSnapshot> {
    const errors: RouterSnapshot['errors'] = [];
    const section = <T>(name: string, read: () => T): T | null => {
      try {
        const value = read();
        if (value === null) errors.push({ section: name, message: 'Not found in the router page' });
        return value;
      } catch (err) {
        errors.push({ section: name, message: (err as Error).message });
        return null;
      }
    };

    const [pagesResult, wanResult] = await Promise.allSettled([
      this.web.fetchPages(POLL_PAGES),
      this.upnp.getWanStatus(),
    ]);

    const pages = pagesResult.status === 'fulfilled' ? pagesResult.value : null;
    if (pagesResult.status === 'rejected') {
      errors.push({ section: 'web', message: (pagesResult.reason as Error).message });
    }
    const wan = wanResult.status === 'fulfilled' ? wanResult.value : null;
    if (wanResult.status === 'rejected') {
      errors.push({ section: 'wan', message: (wanResult.reason as Error).message });
    }

    const snapshot: RouterSnapshot = {
      capturedAt: new Date(),
      system: pages ? section('system', () => parseSystemInfo(pages.systemInfo)) : null,
      optical: pages ? section('optical', () => parseOptical(pages.optical)) : null,
      lanPorts: pages ? section('lanPorts', () => parseLanPorts(pages.ethernet)) : null,
      wlan: pages ? section('wlan', () => parseWlan(pages.wlan)) : null,
      ipFilter: pages ? section('ipFilter', () => parseIpFilter(pages.ipFilter)) : null,
      devices: pages ? (section('devices', () => parseRouterDevices(pages.devices)) ?? []) : [],
      wifiClients: pages
        ? (section('wifiClients', () => parseWifiClients(pages.wifiClients)) ?? [])
        : [],
      wan,
      errors,
    };

    if (pages || wan) {
      this.snapshot = snapshot;
      await this.routerRepository
        .insertSample({
          uptimeSeconds: snapshot.system?.uptimeSeconds ?? null,
          cpuPercent: snapshot.system?.cpuPercent ?? null,
          memoryPercent: snapshot.system?.memoryPercent ?? null,
          opticalRxDbm: snapshot.optical?.rxPowerDbm ?? null,
          opticalTxDbm: snapshot.optical?.txPowerDbm ?? null,
          opticalTemperatureC: snapshot.optical?.temperatureC ?? null,
          opticalVoltageMv: snapshot.optical?.voltageMv ?? null,
          opticalBiasMa: snapshot.optical?.biasMa ?? null,
          wanBytesSent: wan?.bytesSent ?? null,
          wanBytesReceived: wan?.bytesReceived ?? null,
          ponBytesSent: snapshot.optical?.ponBytesSent ?? null,
          ponBytesReceived: snapshot.optical?.ponBytesReceived ?? null,
          wifiClients: pages ? snapshot.wifiClients.length : null,
          devicesOnline: pages ? snapshot.devices.filter((d) => d.online).length : null,
          lanPorts: snapshot.lanPorts,
          wlan: snapshot.wlan,
        })
        .catch((err) => logger.error({ err }, 'Could not store router sample'));
    }
    if (snapshot.optical) await this.checkOptical(snapshot.optical);
    if (errors.length > 0) logger.warn({ errors }, 'Router poll incomplete');
    return snapshot;
  }

  /**
   * Alerts when the fiber signal is lost or weak (below -27 dBm, the receiver fails near -28) and
   * when it recovers (-25 dBm or better, so a value hovering at the limit does not repeat alerts).
   * ponytail: state in memory; after a restart a still-weak signal is reported once more.
   */
  private async checkOptical(optical: OpticalInfo): Promise<void> {
    if (!this.alerts) return;
    const rx = optical.rxPowerDbm;
    const state: OpticalState = optical.lossOfSignal
      ? 'loss'
      : rx === null
        ? this.opticalState
        : rx < OPTICAL_WEAK_DBM
          ? 'weak'
          : rx >= OPTICAL_OK_DBM || this.opticalState === 'ok' || this.opticalState === 'loss'
            ? 'ok'
            : this.opticalState;
    if (state === this.opticalState) return;
    const previous = this.opticalState;
    this.opticalState = state;
    const details = { rxPowerDbm: rx, lossOfSignal: optical.lossOfSignal };
    if (state === 'loss') {
      await this.alerts.raise('optical_loss', 'error', 'Fiber signal lost', details);
    } else if (state === 'weak') {
      await this.alerts.raise('optical_weak', 'warning', `Weak fiber signal: ${rx} dBm`, details);
    } else if (state === 'ok' && previous !== 'unknown') {
      await this.alerts.raise(
        'optical_ok',
        'info',
        `Fiber signal back to normal: ${rx} dBm`,
        details
      );
    }
  }

  /** Replaces the IPv4 filter in the last reading after Nuvytrix changed it on the router. */
  updateIpFilter(state: IpFilterState) {
    if (this.snapshot) this.snapshot = { ...this.snapshot, ipFilter: state };
  }

  /** Reads the firewall log page and feeds it to the firewall import (deduplicated). */
  async importFirewallLog() {
    const pages = await this.web.fetchPages(['firewallLog'] as const);
    const text = parseFirewallLogText(pages.firewallLog);
    if (text === null) throw new Error('Firewall log not found in the router page');
    return this.firewallService.importFromRouter(text);
  }

  private requireSnapshot(): RouterSnapshot {
    if (!this.isConfigured) throw new AppError(ErrorCode.ROUTER_NOT_CONFIGURED, 503);
    if (!this.snapshot) throw new AppError(ErrorCode.ROUTER_NO_DATA, 503);
    return this.snapshot;
  }

  getStatus() {
    if (!this.isConfigured) {
      return { configured: false as const, host: this.settings.host || null };
    }
    const s = this.snapshot;
    return {
      configured: true as const,
      host: this.settings.host,
      polling: this.isPolling,
      pollSeconds: this.settings.pollSeconds,
      capturedAt: s?.capturedAt ?? null,
      system: s?.system ?? null,
      optical: s?.optical ?? null,
      wan: s?.wan ?? null,
      lanPorts: s?.lanPorts ?? null,
      wlan: s?.wlan ?? null,
      ipFilter: s?.ipFilter ?? null,
      devicesOnline: s ? s.devices.filter((d) => d.online).length : null,
      devicesKnown: s ? s.devices.length : null,
      wifiClients: s ? s.wifiClients.length : null,
      errors: s?.errors ?? [],
    };
  }

  /** Router's device list merged with Wi-Fi radio data and the matching Nuvytrix device. */
  async getClients() {
    const s = this.requireSnapshot();
    const radio = new Map(s.wifiClients.map((client) => [client.macAddress, client]));
    const known = await this.devicesRepository.findByMacAddresses(
      s.devices.map((d) => d.macAddress)
    );
    const byMac = new Map(known.map((device) => [device.mac_address, device]));
    return {
      capturedAt: s.capturedAt,
      clients: s.devices.map((device) => {
        const local = byMac.get(device.macAddress);
        return {
          ...device,
          deviceId: local?.id ?? null,
          customName: local?.custom_name ?? null,
          wifi: radio.get(device.macAddress) ?? null,
        };
      }),
    };
  }

  async getPortMappings(): Promise<PortMapping[]> {
    if (!this.settings.host) throw new AppError(ErrorCode.ROUTER_NOT_CONFIGURED, 503);
    return this.upnp.getPortMappings();
  }

  async getHistory(hours: number) {
    const rows = await this.routerRepository.findSamplesSince(
      new Date(Date.now() - hours * 3_600_000)
    );
    return {
      hours,
      points: rows.map((row, index) => {
        const previous = rows[index - 1];
        const seconds = previous
          ? (row.captured_at.getTime() - previous.captured_at.getTime()) / 1000
          : 0;
        // Counters reset on reboot or WAN reconnect; a negative delta is a reset, not traffic.
        const rate = (current: number | null, before: number | null | undefined) =>
          current === null || before == null || seconds <= 0 || current < before
            ? null
            : Math.round(((current - before) * 8) / seconds);
        return {
          at: row.captured_at,
          cpuPercent: row.cpu_percent,
          memoryPercent: row.memory_percent,
          opticalRxDbm: row.optical_rx_dbm,
          opticalTxDbm: row.optical_tx_dbm,
          opticalTemperatureC: row.optical_temperature_c,
          // Internet traffic from the GPON interface counters. The UPnP WAN counters
          // (wan_bytes_*) miss hardware-forwarded traffic, so they are stored but not charted.
          wanDownloadBps: rate(row.pon_bytes_received, previous?.pon_bytes_received),
          wanUploadBps: rate(row.pon_bytes_sent, previous?.pon_bytes_sent),
          // Bytes the router sent to / received from LAN ports and Wi-Fi, local traffic included.
          lanDownloadBps: rate(
            lanTotal(row, 'bytesSent'),
            previous && lanTotal(previous, 'bytesSent')
          ),
          lanUploadBps: rate(
            lanTotal(row, 'bytesReceived'),
            previous && lanTotal(previous, 'bytesReceived')
          ),
          wifiClients: row.wifi_clients,
          devicesOnline: row.devices_online,
        };
      }),
    };
  }

  deleteExpiredSamples(): Promise<number> {
    return this.routerRepository.deleteSamplesBefore(
      new Date(Date.now() - this.settings.retentionDays * 86_400_000)
    );
  }
}

function lanTotal(row: RouterSampleRow, field: 'bytesSent' | 'bytesReceived'): number | null {
  if (!row.lan_ports || !row.wlan) return null;
  return [...row.lan_ports, ...row.wlan].reduce((sum, item) => sum + (item[field] ?? 0), 0);
}
