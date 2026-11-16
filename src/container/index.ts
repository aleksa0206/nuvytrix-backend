import { db } from '../config/db';
import { env } from '../config/env';
import { AuditRepository } from '../modules/audit/audit.repository';
import { AuditService } from '../modules/audit/audit.service';
import { AuthRepository } from '../modules/auth/auth.repository';
import { AuthService } from '../modules/auth/auth.service';
import { DevicesRepository } from '../modules/devices/devices.repository';
import { DevicesService } from '../modules/devices/devices.service';
import { NmapRunner, type HostDiscoverer } from '../modules/devices/nmapRunner';
import { FirewallRepository } from '../modules/firewall/firewall.repository';
import { FirewallService } from '../modules/firewall/firewall.service';
import { PoliciesRepository } from '../modules/firewall/policies.repository';
import { PoliciesService } from '../modules/firewall/policies.service';
import { MonitoringRepository } from '../modules/monitoring/monitoring.repository';
import { MonitoringService } from '../modules/monitoring/monitoring.service';
import { SystemProber, type Prober } from '../modules/monitoring/probes';
import { AdGuardClient } from '../modules/dns/adguardClient';
import { DnsService } from '../modules/dns/dns.service';
import { OverviewService } from '../modules/overview/overview.service';
import { HuaweiWebClient } from '../modules/router/huaweiWebClient';
import { RouterRepository } from '../modules/router/router.repository';
import { RouterService } from '../modules/router/router.service';
import { RouterDhcpService } from '../modules/router/routerDhcp.service';
import { RouterFirewallService } from '../modules/router/routerFirewall.service';
import { RouterForwardingService } from '../modules/router/routerForwarding.service';
import { RouterMacFilterService } from '../modules/router/routerMacFilter.service';
import { RouterPortMappingService } from '../modules/router/routerPortMapping.service';
import { RouterWifiService } from '../modules/router/routerWifi.service';
import { RouterParentalService } from '../modules/router/routerParental.service';
import { RouterDnsService } from '../modules/router/routerDns.service';
import { RouterDdnsService } from '../modules/router/routerDdns.service';
import { RouterUpnpService } from '../modules/router/routerUpnp.service';
import { RouterWifiScheduleService } from '../modules/router/routerWifiSchedule.service';
import { RouterWifiRadioService } from '../modules/router/routerWifiRadio.service';
import { RouterLedService } from '../modules/router/routerLed.service';
import { RouterDiagnosticsService } from '../modules/router/routerDiagnostics.service';
import { RouterAccessService } from '../modules/router/routerAccess.service';
import { RouterIpv6Service } from '../modules/router/routerIpv6.service';
import { AlertsService } from '../modules/alerts/alerts.service';
import { RouterWriter } from '../modules/router/routerWriter';
import { HUAWEI_UPNP_DEFAULTS, UpnpClient } from '../modules/router/upnpClient';

export interface ContainerOverrides {
  hostDiscoverer?: HostDiscoverer;
  prober?: Prober;
  adguardClient?: AdGuardClient;
  routerWebClient?: HuaweiWebClient;
  routerWritesEnabled?: boolean;
  routerDiagnosticsTiming?: { pollMs: number; maxWaitMs: number };
  upnpClient?: UpnpClient;
}

class Container {
  public auditRepository: AuditRepository;
  public auditService: AuditService;
  public alertsService: AlertsService;

  public authRepository: AuthRepository;
  public authService: AuthService;

  public devicesRepository: DevicesRepository;
  public devicesService: DevicesService;

  public firewallRepository: FirewallRepository;
  public firewallService: FirewallService;

  public policiesRepository: PoliciesRepository;
  public policiesService: PoliciesService;

  public monitoringRepository: MonitoringRepository;
  public monitoringService: MonitoringService;

  public dnsService: DnsService;
  public overviewService: OverviewService;

  public routerRepository: RouterRepository;
  public routerService: RouterService;
  public routerFirewallService: RouterFirewallService;
  public routerDhcpService: RouterDhcpService;
  public routerMacFilterService: RouterMacFilterService;
  public routerPortMappingService: RouterPortMappingService;
  public routerForwardingService: RouterForwardingService;
  public routerWifiService: RouterWifiService;
  public routerParentalService: RouterParentalService;
  public routerDnsService: RouterDnsService;
  public routerDdnsService: RouterDdnsService;
  public routerUpnpService: RouterUpnpService;
  public routerWifiScheduleService: RouterWifiScheduleService;
  public routerWifiRadioService: RouterWifiRadioService;
  public routerLedService: RouterLedService;
  public routerDiagnosticsService: RouterDiagnosticsService;
  public routerAccessService: RouterAccessService;
  public routerIpv6Service: RouterIpv6Service;

  constructor(overrides: ContainerOverrides = {}) {
    this.auditRepository = new AuditRepository(db);
    this.auditService = new AuditService(this.auditRepository);
    this.alertsService = new AlertsService(db);

    this.authRepository = new AuthRepository(db);
    this.authService = new AuthService(this.authRepository, this.auditService, {
      idleMinutes: env.SESSION_IDLE_MINUTES,
      maxAgeHours: env.SESSION_MAX_AGE_HOURS,
    });

    this.devicesRepository = new DevicesRepository(db);
    this.devicesService = new DevicesService(
      this.devicesRepository,
      overrides.hostDiscoverer ??
        new NmapRunner({
          nmapPath: env.NMAP_PATH,
          timeoutSeconds: env.SCAN_TIMEOUT_SECONDS,
          privileged: env.NMAP_PRIVILEGED,
        }),
      this.auditService,
      {
        allowedCidrs: env.ALLOWED_SCAN_CIDRS,
        onlineWindowMinutes: env.DEVICE_ONLINE_WINDOW_MINUTES,
      },
      this.alertsService
    );

    this.firewallRepository = new FirewallRepository(db);
    this.firewallService = new FirewallService(
      this.firewallRepository,
      this.auditService,
      env.ROUTER_TIMEZONE
    );

    this.policiesRepository = new PoliciesRepository(db);
    this.policiesService = new PoliciesService(this.policiesRepository, this.auditService, {
      routerHost: env.ROUTER_HOST,
    });

    this.monitoringRepository = new MonitoringRepository(db);
    this.monitoringService = new MonitoringService(
      this.monitoringRepository,
      overrides.prober ?? new SystemProber(env.PING_PATH),
      this.auditService,
      { routerHost: env.ROUTER_HOST, retentionDays: env.MONITORING_RETENTION_DAYS },
      this.alertsService
    );

    this.dnsService = new DnsService(
      overrides.adguardClient ??
        new AdGuardClient({
          url: env.ADGUARD_URL,
          username: env.ADGUARD_USERNAME,
          password: env.ADGUARD_PASSWORD,
        })
    );

    this.routerRepository = new RouterRepository(db);
    const routerWebClient =
      overrides.routerWebClient ??
      new HuaweiWebClient({
        baseUrl: 'http://' + env.ROUTER_HOST,
        username: env.ROUTER_USERNAME,
        password: env.ROUTER_PASSWORD,
      });
    this.routerService = new RouterService(
      routerWebClient,
      overrides.upnpClient ??
        new UpnpClient({
          baseUrl: 'http://' + env.ROUTER_HOST + ':' + HUAWEI_UPNP_DEFAULTS.port,
          wanCommonControl: HUAWEI_UPNP_DEFAULTS.wanCommonControl,
          wanIpControl: HUAWEI_UPNP_DEFAULTS.wanIpControl,
        }),
      this.routerRepository,
      this.devicesRepository,
      this.firewallService,
      {
        host: env.ROUTER_HOST,
        pollSeconds: env.ROUTER_POLL_SECONDS,
        retentionDays: env.MONITORING_RETENTION_DAYS,
      },
      this.alertsService
    );
    const routerWriter = new RouterWriter(routerWebClient, this.auditService, {
      writesEnabled: overrides.routerWritesEnabled ?? env.ROUTER_WRITES_ENABLED,
    });
    this.routerFirewallService = new RouterFirewallService(routerWriter, this.routerService, {
      protectedAddresses: [env.ROUTER_HOST, ...env.ROUTER_PROTECTED_ADDRESSES].filter(Boolean),
    });
    this.routerDhcpService = new RouterDhcpService(routerWriter, {
      protectedAddresses: env.ROUTER_PROTECTED_ADDRESSES,
    });
    this.routerMacFilterService = new RouterMacFilterService(routerWriter, {
      protectedAddresses: env.ROUTER_PROTECTED_ADDRESSES,
    });
    this.routerPortMappingService = new RouterPortMappingService(routerWriter);
    this.routerWifiService = new RouterWifiService(routerWriter);
    this.routerDnsService = new RouterDnsService(routerWriter);
    this.routerDdnsService = new RouterDdnsService(routerWriter);
    this.routerUpnpService = new RouterUpnpService(routerWriter);
    this.routerWifiScheduleService = new RouterWifiScheduleService(routerWriter);
    this.routerWifiRadioService = new RouterWifiRadioService(routerWriter);
    this.routerLedService = new RouterLedService(routerWriter);
    this.routerDiagnosticsService = new RouterDiagnosticsService(
      routerWriter,
      overrides.routerDiagnosticsTiming
    );
    this.routerIpv6Service = new RouterIpv6Service(routerWriter);
    this.routerAccessService = new RouterAccessService(routerWriter, {
      protectedAddresses: env.ROUTER_PROTECTED_ADDRESSES,
    });
    this.routerParentalService = new RouterParentalService(routerWriter, {
      protectedAddresses: env.ROUTER_PROTECTED_ADDRESSES,
    });
    this.routerForwardingService = new RouterForwardingService(routerWriter, {
      protectedAddresses: env.ROUTER_PROTECTED_ADDRESSES,
    });

    this.overviewService = new OverviewService(
      db,
      this.devicesService,
      this.firewallService,
      this.policiesService,
      this.monitoringService,
      this.dnsService,
      {
        routerHost: env.ROUTER_HOST,
        nmapPrivileged: env.NMAP_PRIVILEGED,
        discoveryIntervalMinutes: env.DISCOVERY_INTERVAL_MINUTES,
        monitoringIntervalSeconds: env.MONITORING_INTERVAL_SECONDS,
        allowedScanCidrs: env.ALLOWED_SCAN_CIDRS,
      },
      this.alertsService
    );
  }
}

export let container = new Container();

/** Rebuilds the container with fakes for external processes; tests only. */
export function resetContainer(overrides: ContainerOverrides = {}): void {
  container = new Container(overrides);
}
