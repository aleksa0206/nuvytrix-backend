import type { Knex } from 'knex';
import type { DevicesService } from '../devices/devices.service';
import type { DnsService } from '../dns/dns.service';
import type { FirewallService } from '../firewall/firewall.service';
import type { PoliciesService } from '../firewall/policies.service';
import type { MonitoringService } from '../monitoring/monitoring.service';
import { ROUTER_TARGET_KEY } from '../monitoring/monitoring.service';

export type HealthState = 'operational' | 'warning' | 'error' | 'unknown' | 'not_configured';

export type CapabilityStatus =
  'implemented' | 'partial' | 'requires_hardware' | 'requires_router_support' | 'planned';

export interface OverviewSettings {
  routerHost: string;
  nmapPrivileged: boolean;
  discoveryIntervalMinutes: number;
  monitoringIntervalSeconds: number;
  allowedScanCidrs: string[];
}

const STALE_SCAN_HOURS = 24;

/** Answers "is everything fine?" from stored data only; anything not measured is "unknown". */
export class OverviewService {
  constructor(
    private db: Knex,
    private devicesService: DevicesService,
    private firewallService: FirewallService,
    private policiesService: PoliciesService,
    private monitoringService: MonitoringService,
    private dnsService: DnsService,
    private settings: OverviewSettings
  ) {}

  async getOverview() {
    const [database, devices, firewall, insights, targets, dns, policies] = await Promise.all([
      this.checkDatabase(),
      this.devicesService.getSummary(),
      this.firewallService.getSummary(),
      this.firewallService.getInsights(),
      this.monitoringService.listTargets(),
      this.dnsService.getStatus(),
      this.policiesService.countByStatus(),
    ]);

    const enabledTargets = targets.filter((target) => target.enabled);
    const failingTargets = enabledTargets.filter((target) => target.status === 'down');
    const routerTarget = targets.find((target) => target.managed);

    const scanAgeHours = devices.latestScan
      ? (Date.now() - new Date(devices.latestScan.startedAt).getTime()) / 3_600_000
      : null;

    return {
      generatedAt: new Date(),
      api: { state: 'operational' as HealthState, uptimeSeconds: Math.round(process.uptime()) },
      database: { state: (database ? 'operational' : 'error') as HealthState },
      router: {
        state: !this.settings.routerHost
          ? ('not_configured' as HealthState)
          : stateFromTarget(routerTarget?.status),
        host: this.settings.routerHost || null,
        lastCheck: routerTarget?.lastCheck ?? null,
        uptimePercent24h: routerTarget?.window?.uptimePercent ?? null,
      },
      devices: {
        state: (!devices.latestScan
          ? 'unknown'
          : devices.latestScan.status === 'failed'
            ? 'error'
            : scanAgeHours !== null && scanAgeHours > STALE_SCAN_HOURS
              ? 'warning'
              : 'operational') as HealthState,
        total: devices.total,
        online: devices.online,
        newLast24h: devices.new,
        latestScan: devices.latestScan,
      },
      firewall: firewall.hasData
        ? {
            state: (insights.hasData && insights.repeatedDeniedSources.length > 0
              ? 'warning'
              : 'operational') as HealthState,
            hasData: true,
            totalEvents: firewall.totalEvents,
            dataTo: firewall.dataTo,
            range: firewall.range,
            denied: firewall.denied,
            accepted: firewall.accepted,
            repeatedDeniedSources: insights.hasData ? insights.repeatedDeniedSources.length : 0,
            acceptedInbound: insights.hasData ? insights.acceptedInbound.length : 0,
          }
        : { state: 'not_configured' as HealthState, hasData: false },
      monitoring: {
        state: (enabledTargets.length === 0
          ? 'not_configured'
          : failingTargets.length > 0
            ? 'error'
            : enabledTargets.some((target) => target.status === 'unknown')
              ? 'unknown'
              : enabledTargets.some((target) => target.status === 'degraded')
                ? 'warning'
                : 'operational') as HealthState,
        targets: enabledTargets.length,
        failing: failingTargets.map((target) => ({ id: target.id, name: target.name })),
      },
      dns: {
        state: (!dns.configured
          ? 'not_configured'
          : !dns.reachable
            ? 'error'
            : dns.protectionEnabled
              ? 'operational'
              : 'warning') as HealthState,
        provider: dns.provider,
      },
      policies: { pendingManual: policies.pending_manual ?? 0, failed: policies.apply_failed ?? 0 },
    };
  }

  /** What this installation can and cannot do on the current hardware, shown in Settings. */
  getCapabilities() {
    const capability = (feature: string, status: CapabilityStatus, note: string) => ({
      feature,
      status,
      note,
    });
    return [
      capability(
        'Device discovery',
        this.settings.nmapPrivileged ? 'implemented' : 'partial',
        this.settings.nmapPrivileged
          ? 'nmap ping scan with ARP: IP, MAC, vendor and hostname where the network provides it.'
          : 'nmap runs without raw-socket privileges: MAC addresses and vendors are not available. Run the API in the Docker image on the server.'
      ),
      capability(
        'Scheduled discovery',
        this.settings.discoveryIntervalMinutes > 0 ? 'implemented' : 'partial',
        this.settings.discoveryIntervalMinutes > 0
          ? `Every ${this.settings.discoveryIntervalMinutes} minutes.`
          : 'Disabled; set DISCOVERY_INTERVAL_MINUTES to enable.'
      ),
      capability(
        'Firewall log analysis',
        'partial',
        'Manual upload of the log file downloaded from the router. Automatic collection would need syslog forwarding, which has not been verified on this firmware.'
      ),
      capability(
        'Firewall rule management',
        'requires_router_support',
        'The router exposes no supported management API. Rules are tracked here and applied by hand using generated instructions.'
      ),
      capability(
        'Availability and latency monitoring',
        'implemented',
        `ICMP and DNS checks every ${this.settings.monitoringIntervalSeconds} seconds from the server.`
      ),
      capability(
        'DNS statistics and filtering',
        'requires_router_support',
        'Requires AdGuard Home (set ADGUARD_URL) and devices using it as their DNS server.'
      ),
      capability(
        'Per-device traffic and bandwidth',
        'requires_hardware',
        'The TP-Link TL-SG1005D is unmanaged: no port mirroring or SNMP. Needs a managed switch with mirroring, a gateway that exports flow data, or a dedicated sensor.'
      ),
      capability(
        'Remote access',
        'planned',
        'The WAN address is behind CGNAT, so inbound IPv4 does not work. Use a VPN such as WireGuard or Tailscale; do not expose the dashboard publicly.'
      ),
    ];
  }

  getSettings() {
    return {
      routerHost: this.settings.routerHost || null,
      allowedScanCidrs: this.settings.allowedScanCidrs,
      discoveryIntervalMinutes: this.settings.discoveryIntervalMinutes,
      monitoringIntervalSeconds: this.settings.monitoringIntervalSeconds,
      routerTargetKey: ROUTER_TARGET_KEY,
    };
  }

  private async checkDatabase(): Promise<boolean> {
    try {
      await this.db.raw('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }
}

function stateFromTarget(status: string | undefined): HealthState {
  if (status === 'up') return 'operational';
  if (status === 'degraded') return 'warning';
  if (status === 'down') return 'error';
  return 'unknown';
}
