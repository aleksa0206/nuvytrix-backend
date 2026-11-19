import { AppError } from '../../common/errors/AppError';
import { ErrorCode } from '../../common/errors/errorCodes';
import type { RequestContext } from '../auth/auth.types';
import {
  parseDhcpReservations,
  parseDhcpServer,
  parseRouterDevices,
  type DhcpReservation,
  type DhcpServerState,
} from './huaweiParser';
import type { DhcpReservationInput, DhcpServerInput } from './routerDhcp.schema';
import { ipToInt } from './routerFirewall.schema';
import type { RouterWriter } from './routerWriter';

const HOST_CONFIG = 'InternetGatewayDevice.LANDevice.1.LANHostConfigManagement';
const RESERVATIONS = `${HOST_CONFIG}.DHCPStaticAddress`;

export interface RouterDhcpSettings {
  /** LAN addresses that must stay inside the pool: the server and the admin's PC. */
  protectedAddresses: string[];
}

const refuse = (message: string) => new AppError(ErrorCode.ROUTER_WRITE_REFUSED, 422, message);

/**
 * The router's main DHCP pool and its static reservations, changed through the router's own forms
 * and verified by reading back. Request formats: docs/huawei/dhcp-management.md.
 */
export class RouterDhcpService {
  constructor(
    private writer: RouterWriter,
    private settings: RouterDhcpSettings
  ) {}

  get writesEnabled(): boolean {
    return this.writer.writesEnabled;
  }

  async getState(): Promise<{ server: DhcpServerState; reservations: DhcpReservation[] }> {
    const pages = await this.writer.read(['dhcpServer', 'dhcpStatic'] as const);
    return { server: parseServer(pages.dhcpServer), reservations: parseStatic(pages.dhcpStatic) };
  }

  async changeServer(input: DhcpServerInput, adminId: number, context: RequestContext) {
    this.writer.requireWritable();
    const { server, reservations } = await this.getState();
    const start = ipToInt(input.startIp);
    const end = ipToInt(input.endIp);
    for (const ip of [input.startIp, input.endIp]) checkHostAddress(ip, server);
    const lan = ipToInt(server.lanIp);
    if (lan >= start && lan <= end) {
      throw refuse(`The pool must not include the router's own address ${server.lanIp}`);
    }
    const outside = (ip: string) => ipToInt(ip) < start || ipToInt(ip) > end;
    const lost = this.settings.protectedAddresses.find(outside);
    if (lost) throw refuse(`The pool must keep ${lost} (server or admin PC)`);
    const reserved = reservations.find((r) => outside(r.ip));
    if (reserved) throw refuse(`The reservation for ${reserved.ip} would fall outside the pool`);

    return this.writer.write({
      action: 'router.dhcp_server_changed',
      entityType: 'router_dhcp_server',
      form: {
        page: 'dhcpServer',
        action: 'set',
        objectKey: 'z',
        object: HOST_CONFIG,
        fields: {
          'z.MinAddress': input.startIp,
          'z.MaxAddress': input.endIp,
          'z.DHCPLeaseTime': String(input.leaseSeconds),
        },
      },
      parse: parseServer,
      verify: (after) =>
        after.startIp === input.startIp &&
        after.endIp === input.endIp &&
        after.leaseSeconds === input.leaseSeconds
          ? {}
          : null,
      adminId,
      context,
      details: {
        before: { startIp: server.startIp, endIp: server.endIp, leaseSeconds: server.leaseSeconds },
        requested: input,
      },
    });
  }

  async addReservation(input: DhcpReservationInput, adminId: number, context: RequestContext) {
    const before = await this.prepareReservation(input);
    return this.writer.write({
      action: 'router.dhcp_reservation_created',
      entityType: 'router_dhcp_reservation',
      form: {
        page: 'dhcpStatic',
        action: 'add',
        object: RESERVATIONS,
        fields: { 'x.Yiaddr': input.ip, 'x.Chaddr': input.mac, 'x.Enable': '1' },
      },
      parse: parseStatic,
      verify: (after) => {
        const added = after.find(
          (r) => !before.some((old) => old.domain === r.domain) && same(r, input)
        );
        return added ? { reservation: added } : null;
      },
      adminId,
      context,
      details: { requested: input },
    });
  }

  async updateReservation(
    index: number,
    input: DhcpReservationInput,
    adminId: number,
    context: RequestContext
  ) {
    const domain = `${RESERVATIONS}.${index}`;
    const before = await this.prepareReservation(input, domain);
    const current = before.find((r) => r.domain === domain)!;
    return this.writer.write({
      action: 'router.dhcp_reservation_updated',
      entityType: 'router_dhcp_reservation',
      // The router's own form sends only address and MAC when editing.
      form: {
        page: 'dhcpStatic',
        action: 'set',
        object: domain,
        fields: { 'x.Yiaddr': input.ip, 'x.Chaddr': input.mac },
      },
      parse: parseStatic,
      verify: (after) => {
        const updated = after.find((r) => r.domain === domain);
        return updated && same(updated, input) ? { reservation: updated } : null;
      },
      adminId,
      context,
      details: { before: current, requested: input },
    });
  }

  async deleteReservation(index: number, adminId: number, context: RequestContext) {
    this.writer.requireWritable();
    const domain = `${RESERVATIONS}.${index}`;
    const { dhcpStatic } = await this.writer.read(['dhcpStatic'] as const);
    const current = parseStatic(dhcpStatic).find((r) => r.domain === domain);
    if (!current) throw new AppError(ErrorCode.ROUTER_RULE_NOT_FOUND, 404);
    return this.writer.write({
      action: 'router.dhcp_reservation_deleted',
      entityType: 'router_dhcp_reservation',
      form: { page: 'dhcpStatic', action: 'del', object: RESERVATIONS, fields: { [domain]: '' } },
      parse: parseStatic,
      verify: (after) => (after.some((r) => r.domain === domain) ? null : {}),
      adminId,
      context,
      details: { before: current },
    });
  }

  /** Checks a reservation against the live router; `domain` is the one being edited, if any. */
  private async prepareReservation(
    input: DhcpReservationInput,
    domain?: string
  ): Promise<DhcpReservation[]> {
    this.writer.requireWritable();
    const pages = await this.writer.read(['dhcpServer', 'dhcpStatic', 'devices'] as const);
    const server = parseServer(pages.dhcpServer);
    const reservations = parseStatic(pages.dhcpStatic);
    if (domain && !reservations.some((r) => r.domain === domain)) {
      throw new AppError(ErrorCode.ROUTER_RULE_NOT_FOUND, 404);
    }
    checkHostAddress(input.ip, server);
    if (input.ip === server.lanIp) throw refuse("That is the router's own address");
    const others = reservations.filter((r) => r.domain !== domain);
    if (others.some((r) => r.mac === input.mac)) {
      throw refuse('This MAC address already has a reservation');
    }
    if (others.some((r) => r.ip === input.ip)) {
      throw refuse('This address is already reserved');
    }
    // Reserving an address another device holds would give two devices the same address.
    const holder = parseRouterDevices(pages.devices).find(
      (d) => d.ipAddress === input.ip && d.macAddress.toLowerCase() !== input.mac
    );
    if (holder) {
      throw refuse(
        `${input.ip} is in use by ${holder.hostName || holder.macAddress}; pick a free address`
      );
    }
    return reservations;
  }
}

/** The address must be a host address in the router's LAN subnet. */
function checkHostAddress(ip: string, server: DhcpServerState) {
  const mask = ipToInt(server.subnetMask);
  const network = (ipToInt(server.lanIp) & mask) >>> 0;
  const value = ipToInt(ip);
  if ((value & mask) >>> 0 !== network) {
    throw refuse(`${ip} is not in the LAN subnet ${server.lanIp}/${server.subnetMask}`);
  }
  const host = (value & ~mask) >>> 0;
  if (host === 0 || host === ~mask >>> 0) {
    throw refuse(`${ip} is the network or broadcast address`);
  }
}

function same(r: DhcpReservation, input: DhcpReservationInput): boolean {
  return r.ip === input.ip && r.mac === input.mac;
}

function parseServer(page: string): DhcpServerState {
  const state = parseDhcpServer(page);
  if (!state) throw new AppError(ErrorCode.ROUTER_UNAVAILABLE, 502, 'DHCP server page not found');
  return state;
}

function parseStatic(page: string): DhcpReservation[] {
  const state = parseDhcpReservations(page);
  if (!state) throw new AppError(ErrorCode.ROUTER_UNAVAILABLE, 502, 'DHCP reservations not found');
  return state;
}
