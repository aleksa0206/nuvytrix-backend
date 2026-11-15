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

export interface ContainerOverrides {
  hostDiscoverer?: HostDiscoverer;
}

class Container {
  public auditRepository: AuditRepository;
  public auditService: AuditService;

  public authRepository: AuthRepository;
  public authService: AuthService;

  public devicesRepository: DevicesRepository;
  public devicesService: DevicesService;

  public firewallRepository: FirewallRepository;
  public firewallService: FirewallService;

  public policiesRepository: PoliciesRepository;
  public policiesService: PoliciesService;

  constructor(overrides: ContainerOverrides = {}) {
    this.auditRepository = new AuditRepository(db);
    this.auditService = new AuditService(this.auditRepository);

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
      }
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
  }
}

export let container = new Container();

/** Rebuilds the container with fakes for external processes; tests only. */
export function resetContainer(overrides: ContainerOverrides = {}): void {
  container = new Container(overrides);
}
