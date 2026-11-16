import { AppError } from '../../common/errors/AppError';
import { ErrorCode } from '../../common/errors/errorCodes';
import type { RequestContext } from '../auth/auth.types';
import {
  parseConstructorCalls,
  parseInternetWan,
  parsePortMappings,
  type PortMappingRule,
} from './huaweiParser';
import { ipToInt } from './routerFirewall.schema';
import type { PortMappingInput } from './routerPortMapping.schema';
import type { RouterWriter } from './routerWriter';

const refuse = (message: string) => new AppError(ErrorCode.ROUTER_WRITE_REFUSED, 422, message);

/**
 * IPv4 port mappings (port forwarding) on the router's internet WAN connection, through the
 * router's own ajax forms, verified by reading back. Each mapping managed here has one port range;
 * mappings with several ranges are shown and can be deleted, but are edited in the router's UI.
 * Request formats: docs/huawei/port-mapping-management.md.
 */
export class RouterPortMappingService {
  constructor(private writer: RouterWriter) {}

  get writesEnabled(): boolean {
    return this.writer.writesEnabled;
  }

  async getState() {
    const pages = await this.writer.read(['portMapping', 'wanList'] as const);
    return { internetWan: parseInternetWan(pages.wanList), mappings: parse(pages.portMapping) };
  }

  async addMapping(input: PortMappingInput, adminId: number, context: RequestContext) {
    const { page, wan, before } = await this.prepare();
    check(input, page, before);
    return this.writer.write({
      action: 'router.port_mapping_created',
      entityType: 'router_port_mapping',
      // The page creates the mapping and its port range in one request: GROUP_a_ya is the range
      // inside the mapping that GROUP_a_x creates.
      form: {
        page: 'portMapping',
        action: 'addcfgajax',
        objectKey: 'GROUP_a_x',
        object: `${wan}.PortMapping`,
        extraQuery: { GROUP_a_ya: 'GROUP_a_x.X_HW_Portlist' },
        fields: { ...mappingFields('GROUP_a_x', input), ...rangeFields('GROUP_a_ya', input) },
      },
      parse,
      verify: (after) => {
        const added = after.find(
          (m) => !before.some((old) => old.domain === m.domain) && same(m, input)
        );
        return added ? { mapping: added } : null;
      },
      adminId,
      context,
      details: { requested: input },
    });
  }

  async updateMapping(
    index: number,
    input: PortMappingInput,
    adminId: number,
    context: RequestContext
  ) {
    const { page, wan, before } = await this.prepare();
    const current = find(before, `${wan}.PortMapping.${index}`);
    if (current.ranges.length !== 1) {
      throw refuse("This mapping has several port ranges; change it in the router's own interface");
    }
    check(
      input,
      page,
      before.filter((m) => m !== current)
    );
    return this.writer.write({
      action: 'router.port_mapping_updated',
      entityType: 'router_port_mapping',
      form: {
        page: 'portMapping',
        action: 'complexajax',
        object: current.domain,
        extraQuery: { ma: current.ranges[0]!.domain },
        fields: {
          ...mappingFields('x', input),
          ...rangeFields('ma', input),
          'ma.ExternalSrcPort': '',
        },
      },
      parse,
      verify: (after) => {
        const updated = after.find((m) => m.domain === current.domain);
        return updated && same(updated, input) ? { mapping: updated } : null;
      },
      adminId,
      context,
      details: { before: current, requested: input },
    });
  }

  async deleteMapping(index: number, adminId: number, context: RequestContext) {
    const { wan, before } = await this.prepare();
    const current = find(before, `${wan}.PortMapping.${index}`);
    return this.writer.write({
      action: 'router.port_mapping_deleted',
      entityType: 'router_port_mapping',
      form: { page: 'portMapping', action: 'del', fields: { [current.domain]: '' } },
      parse,
      verify: (after) => (after.some((m) => m.domain === current.domain) ? null : {}),
      adminId,
      context,
      details: { before: current },
    });
  }

  private async prepare() {
    this.writer.requireWritable();
    const pages = await this.writer.read(['portMapping', 'wanList'] as const);
    const wan = parseInternetWan(pages.wanList);
    if (!wan) throw refuse('The router has no routed internet WAN connection for port mapping');
    return { page: pages.portMapping, wan, before: parse(pages.portMapping) };
  }
}

function find(mappings: PortMappingRule[], domain: string): PortMappingRule {
  const mapping = mappings.find((m) => m.domain === domain);
  if (!mapping) throw new AppError(ErrorCode.ROUTER_RULE_NOT_FOUND, 404);
  return mapping;
}

/** Checks the target device and that no other mapping uses the same external ports. */
function check(input: PortMappingInput, page: string, others: PortMappingRule[]) {
  const lan = parseConstructorCalls(page, 'stipaddr').find((c) =>
    /IPInterface\.1$/.test(c[0] ?? '')
  );
  if (!lan) throw new AppError(ErrorCode.ROUTER_UNAVAILABLE, 502, 'LAN address not found');
  const lanIp = ipToInt(lan[2]!);
  const mask = ipToInt(lan[3]!);
  const host = ipToInt(input.internalHost);
  const hostPart = (host & ~mask) >>> 0;
  if ((host & mask) >>> 0 !== (lanIp & mask) >>> 0 || hostPart === 0 || hostPart === ~mask >>> 0) {
    throw refuse(`${input.internalHost} is not a device address in the LAN ${lan[2]}/${lan[3]}`);
  }
  if (host === lanIp)
    throw refuse('Port mapping to the router itself would expose its admin pages');
  if (others.some((m) => m.name === input.name)) throw refuse('A mapping with this name exists');
  const protocols = (p: string) => (p === 'TCP/UDP' ? ['TCP', 'UDP'] : [p]);
  for (const other of others) {
    for (const range of other.ranges) {
      const [start, end = start] = range.externalPort.split(':').map(Number) as [number, number?];
      const shared = protocols(range.protocol).some((p) => protocols(input.protocol).includes(p));
      if (shared && start <= input.externalPortEnd && end >= input.externalPortStart) {
        throw refuse(`External ports ${range.externalPort} are already used by “${other.name}”`);
      }
    }
  }
}

function mappingFields(key: string, input: PortMappingInput): Record<string, string> {
  return {
    [`${key}.PortMappingEnabled`]: input.enabled ? '1' : '0',
    [`${key}.PortMappingDescription`]: input.name,
    [`${key}.InternalClient`]: input.internalHost,
    [`${key}.RemoteHost`]: input.remoteHostStart,
    [`${key}.X_HW_RemoteHostRange`]: input.remoteHostEnd,
  };
}

function rangeFields(key: string, input: PortMappingInput): Record<string, string> {
  return {
    [`${key}.Protocol`]: input.protocol,
    [`${key}.InternalPort`]: String(input.internalPort),
    [`${key}.ExternalPort`]: `${input.externalPortStart}:${input.externalPortEnd}`,
  };
}

function same(m: PortMappingRule, input: PortMappingInput): boolean {
  const range = m.ranges[0];
  return (
    m.ranges.length === 1 &&
    m.name === input.name &&
    m.enabled === input.enabled &&
    m.internalHost === input.internalHost &&
    m.remoteHostStart === input.remoteHostStart &&
    m.remoteHostEnd === input.remoteHostEnd &&
    range!.protocol === input.protocol &&
    range!.internalPort === String(input.internalPort) &&
    range!.externalPort === `${input.externalPortStart}:${input.externalPortEnd}`
  );
}

function parse(page: string): PortMappingRule[] {
  const mappings = parsePortMappings(page);
  if (!mappings) {
    throw new AppError(ErrorCode.ROUTER_UNAVAILABLE, 502, 'Port mapping page not found');
  }
  return mappings;
}
