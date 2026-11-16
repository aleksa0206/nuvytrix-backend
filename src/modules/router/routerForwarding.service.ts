import { AppError } from '../../common/errors/AppError';
import { ErrorCode } from '../../common/errors/errorCodes';
import type { RequestContext } from '../auth/auth.types';
import {
  parseDhcpServer,
  parseDmz,
  parseInternetWan,
  parsePortTriggers,
  type DmzState,
  type PortTriggerRule,
} from './huaweiParser';
import { lanHostProblem } from './routerFirewall.schema';
import { MAX_TRIGGER_PORTS, type DmzInput, type PortTriggerInput } from './routerForwarding.schema';
import type { RouterWriter } from './routerWriter';

const refuse = (message: string) => new AppError(ErrorCode.ROUTER_WRITE_REFUSED, 422, message);

export interface RouterForwardingSettings {
  /** LAN addresses that must never be exposed as DMZ host: the server and the admin's PC. */
  protectedAddresses: string[];
}

/**
 * DMZ host and port triggers on the router's internet WAN connection, through the router's own
 * forms, verified by reading back. Request formats: docs/huawei/dmz-port-trigger-management.md.
 */
export class RouterForwardingService {
  constructor(
    private writer: RouterWriter,
    private settings: RouterForwardingSettings
  ) {}

  get writesEnabled(): boolean {
    return this.writer.writesEnabled;
  }

  async getDmz() {
    const pages = await this.writer.read(['dmz', 'wanList'] as const);
    const wan = parseInternetWan(pages.wanList);
    return { internetWan: wan, dmz: dmzOf(parseDmzPage(pages.dmz), wan) };
  }

  /** Creates the DMZ entry on the internet WAN, or changes it. */
  async setDmz(input: DmzInput, adminId: number, context: RequestContext) {
    this.writer.requireWritable();
    const pages = await this.writer.read(['dmz', 'wanList', 'dhcpServer'] as const);
    const wan = internetWan(pages.wanList);
    const lan = parseDhcpServer(pages.dhcpServer);
    if (!lan) throw new AppError(ErrorCode.ROUTER_UNAVAILABLE, 502, 'LAN address not found');
    const problem = lanHostProblem(input.host, lan.lanIp, lan.subnetMask);
    if (problem) throw refuse(problem);
    if (this.settings.protectedAddresses.includes(input.host)) {
      throw refuse(`${input.host} (server or admin PC) must not be exposed to the internet`);
    }
    const current = dmzOf(parseDmzPage(pages.dmz), wan);
    return this.writer.write({
      action: 'router.dmz_changed',
      entityType: 'router_dmz',
      form: {
        page: 'dmz',
        action: current ? 'set' : 'add',
        object: `${wan}.X_HW_DMZ`,
        fields: { 'x.DMZEnable': input.enabled ? '1' : '0', 'x.DMZHostIPAddress': input.host },
      },
      parse: (page) => dmzOf(parseDmzPage(page), wan),
      verify: (after) =>
        after && after.enabled === input.enabled && after.host === input.host
          ? { dmz: after }
          : null,
      adminId,
      context,
      details: { before: current, requested: input },
    });
  }

  async deleteDmz(adminId: number, context: RequestContext) {
    this.writer.requireWritable();
    const pages = await this.writer.read(['dmz', 'wanList'] as const);
    const wan = internetWan(pages.wanList);
    const current = dmzOf(parseDmzPage(pages.dmz), wan);
    if (!current) throw new AppError(ErrorCode.ROUTER_RULE_NOT_FOUND, 404);
    return this.writer.write({
      action: 'router.dmz_deleted',
      entityType: 'router_dmz',
      form: { page: 'dmz', action: 'del', fields: { [current.domain]: '' } },
      parse: (page) => dmzOf(parseDmzPage(page), wan),
      verify: (after) => (after ? null : {}),
      adminId,
      context,
      details: { before: current },
    });
  }

  async getTriggers() {
    const pages = await this.writer.read(['portTrigger', 'wanList'] as const);
    return {
      internetWan: parseInternetWan(pages.wanList),
      triggers: parseTriggerPage(pages.portTrigger),
    };
  }

  async addTrigger(input: PortTriggerInput, adminId: number, context: RequestContext) {
    const { wan, before } = await this.prepareTriggers();
    checkTrigger(input, before);
    return this.writer.write({
      action: 'router.port_trigger_created',
      entityType: 'router_port_trigger',
      form: {
        page: 'portTrigger',
        action: 'add',
        object: `${wan}.X_HW_PortTrigger`,
        fields: triggerFields(input),
      },
      parse: parseTriggerPage,
      verify: (after) => {
        const added = after.find(
          (t) => !before.some((old) => old.domain === t.domain) && sameTrigger(t, input)
        );
        return added ? { trigger: added } : null;
      },
      adminId,
      context,
      details: { requested: input },
    });
  }

  async updateTrigger(
    index: number,
    input: PortTriggerInput,
    adminId: number,
    context: RequestContext
  ) {
    const { wan, before } = await this.prepareTriggers();
    const domain = `${wan}.X_HW_PortTrigger.${index}`;
    const current = before.find((t) => t.domain === domain);
    if (!current) throw new AppError(ErrorCode.ROUTER_RULE_NOT_FOUND, 404);
    checkTrigger(
      input,
      before.filter((t) => t !== current)
    );
    return this.writer.write({
      action: 'router.port_trigger_updated',
      entityType: 'router_port_trigger',
      form: { page: 'portTrigger', action: 'set', object: domain, fields: triggerFields(input) },
      parse: parseTriggerPage,
      verify: (after) => {
        const updated = after.find((t) => t.domain === domain);
        return updated && sameTrigger(updated, input) ? { trigger: updated } : null;
      },
      adminId,
      context,
      details: { before: current, requested: input },
    });
  }

  async deleteTrigger(index: number, adminId: number, context: RequestContext) {
    const { wan, before } = await this.prepareTriggers();
    const domain = `${wan}.X_HW_PortTrigger.${index}`;
    const current = before.find((t) => t.domain === domain);
    if (!current) throw new AppError(ErrorCode.ROUTER_RULE_NOT_FOUND, 404);
    return this.writer.write({
      action: 'router.port_trigger_deleted',
      entityType: 'router_port_trigger',
      form: { page: 'portTrigger', action: 'del', fields: { [domain]: '' } },
      parse: parseTriggerPage,
      verify: (after) => (after.some((t) => t.domain === domain) ? null : {}),
      adminId,
      context,
      details: { before: current },
    });
  }

  private async prepareTriggers() {
    this.writer.requireWritable();
    const pages = await this.writer.read(['portTrigger', 'wanList'] as const);
    return { wan: internetWan(pages.wanList), before: parseTriggerPage(pages.portTrigger) };
  }
}

function internetWan(page: string): string {
  const wan = parseInternetWan(page);
  if (!wan) throw refuse('The router has no routed internet WAN connection');
  return wan;
}

function dmzOf(entries: DmzState[], wan: string | null): DmzState | null {
  return entries.find((d) => d.domain === `${wan}.X_HW_DMZ`) ?? null;
}

/** No overlap with another trigger on the same protocol, and the router's 256-port totals. */
function checkTrigger(input: PortTriggerInput, others: PortTriggerRule[]) {
  const protocols = (p: string) => (p === 'TCP/UDP' ? ['TCP', 'UDP'] : [p]);
  const clash = (
    aProto: string,
    aStart: number,
    aEnd: number,
    bProto: string,
    b: [number, number]
  ) =>
    protocols(aProto).some((p) => protocols(bProto).includes(p)) && aStart <= b[1] && aEnd >= b[0];
  for (const other of others) {
    if (
      clash(
        input.triggerProtocol,
        input.triggerPortStart,
        input.triggerPortEnd,
        other.triggerProtocol,
        [other.triggerPortStart, other.triggerPortEnd]
      )
    ) {
      throw refuse('The trigger ports overlap another port trigger');
    }
    if (
      clash(input.openProtocol, input.openPortStart, input.openPortEnd, other.openProtocol, [
        other.openPortStart,
        other.openPortEnd,
      ])
    ) {
      throw refuse('The open ports overlap another port trigger');
    }
  }
  const count = (list: { start: number; end: number }[]) =>
    list.reduce((sum, r) => sum + r.end - r.start + 1, 0);
  const all = [...others, input];
  if (
    count(all.map((t) => ({ start: t.triggerPortStart, end: t.triggerPortEnd }))) >
    MAX_TRIGGER_PORTS
  ) {
    throw refuse(`All port triggers together may use at most ${MAX_TRIGGER_PORTS} trigger ports`);
  }
  if (count(all.map((t) => ({ start: t.openPortStart, end: t.openPortEnd }))) > MAX_TRIGGER_PORTS) {
    throw refuse(`All port triggers together may open at most ${MAX_TRIGGER_PORTS} ports`);
  }
}

function triggerFields(t: PortTriggerInput): Record<string, string> {
  return {
    'x.Enable': t.enabled ? '1' : '0',
    'x.TriggerPort': String(t.triggerPortStart),
    'x.TriggerPortEnd': String(t.triggerPortEnd),
    'x.TriggerProtocol': t.triggerProtocol,
    'x.OpenPort': String(t.openPortStart),
    'x.OpenPortEnd': String(t.openPortEnd),
    'x.OpenProtocol': t.openProtocol,
  };
}

function sameTrigger(t: PortTriggerRule, input: PortTriggerInput): boolean {
  return (
    t.enabled === input.enabled &&
    t.triggerProtocol === input.triggerProtocol &&
    t.triggerPortStart === input.triggerPortStart &&
    t.triggerPortEnd === input.triggerPortEnd &&
    t.openProtocol === input.openProtocol &&
    t.openPortStart === input.openPortStart &&
    t.openPortEnd === input.openPortEnd
  );
}

function parseDmzPage(page: string): DmzState[] {
  const state = parseDmz(page);
  if (!state) throw new AppError(ErrorCode.ROUTER_UNAVAILABLE, 502, 'DMZ page not found');
  return state;
}

function parseTriggerPage(page: string): PortTriggerRule[] {
  const state = parsePortTriggers(page);
  if (!state) throw new AppError(ErrorCode.ROUTER_UNAVAILABLE, 502, 'Port trigger page not found');
  return state;
}
