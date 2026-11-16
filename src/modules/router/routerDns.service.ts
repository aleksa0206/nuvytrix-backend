import { AppError } from '../../common/errors/AppError';
import { ErrorCode } from '../../common/errors/errorCodes';
import type { RequestContext } from '../auth/auth.types';
import { parseDnsHosts, type DnsHost } from './huaweiParser';
import type { DnsHostInput } from './routerDns.schema';
import type { RouterWriter } from './routerWriter';

const HOSTS = 'InternetGatewayDevice.X_HW_DNS.HOSTS';
/** The router's page allows 20 entries. */
const MAX_HOSTS = 20;

const refuse = (message: string) => new AppError(ErrorCode.ROUTER_WRITE_REFUSED, 422, message);

/**
 * Static DNS entries on the router (Application → Static DNS): names the router answers itself for
 * devices that use it as DNS server. Request formats: docs/huawei/dns-management.md.
 */
export class RouterDnsService {
  constructor(private writer: RouterWriter) {}

  get writesEnabled(): boolean {
    return this.writer.writesEnabled;
  }

  async getHosts(): Promise<DnsHost[]> {
    const { dnsHostsData } = await this.writer.read(['dnsHostsData'] as const);
    return parse(dnsHostsData);
  }

  async addHost(input: DnsHostInput, adminId: number, context: RequestContext) {
    const before = await this.prepare(input);
    if (before.length >= MAX_HOSTS) throw refuse(`The router holds at most ${MAX_HOSTS} entries`);
    return this.writer.write({
      action: 'router.dns_host_created',
      entityType: 'router_dns_host',
      form: {
        page: 'dnsHosts',
        readBack: 'dnsHostsData',
        action: 'add',
        object: HOSTS,
        fields: { 'x.IPAddress': input.ip, 'x.DomainName': input.name },
      },
      parse,
      verify: (after) => {
        const added = after.find(
          (h) =>
            h.name === input.name && h.ip === input.ip && !before.some((o) => o.domain === h.domain)
        );
        return added ? { host: added } : null;
      },
      adminId,
      context,
      details: { requested: input },
    });
  }

  async updateHost(index: number, input: DnsHostInput, adminId: number, context: RequestContext) {
    const before = await this.prepare(input, index);
    const current = find(before, index);
    return this.writer.write({
      action: 'router.dns_host_updated',
      entityType: 'router_dns_host',
      form: {
        page: 'dnsHosts',
        readBack: 'dnsHostsData',
        action: 'set',
        object: current.domain,
        fields: { 'x.IPAddress': input.ip, 'x.DomainName': input.name },
      },
      parse,
      verify: (after) => {
        const updated = after.find((h) => h.domain === current.domain);
        return updated && updated.name === input.name && updated.ip === input.ip
          ? { host: updated }
          : null;
      },
      adminId,
      context,
      details: { before: current, requested: input },
    });
  }

  async deleteHost(index: number, adminId: number, context: RequestContext) {
    this.writer.requireWritable();
    const current = find(await this.getHosts(), index);
    return this.writer.write({
      action: 'router.dns_host_deleted',
      entityType: 'router_dns_host',
      form: {
        page: 'dnsHosts',
        readBack: 'dnsHostsData',
        action: 'del',
        object: HOSTS,
        fields: { [current.domain]: '' },
      },
      parse,
      verify: (after) => (after.some((h) => h.domain === current.domain) ? null : {}),
      adminId,
      context,
      details: { before: current },
    });
  }

  private async prepare(input: DnsHostInput, index?: number) {
    this.writer.requireWritable();
    const hosts = await this.getHosts();
    if (index !== undefined) find(hosts, index);
    // As on the router's page: one IPv4 and one IPv6 address per name.
    const family = (ip: string) => (ip.includes(':') ? 'IPv6' : 'IPv4');
    if (
      hosts.some(
        (h) => h.name === input.name && family(h.ip) === family(input.ip) && h.index !== index
      )
    ) {
      throw refuse(`${input.name} already has an ${family(input.ip)} entry`);
    }
    return hosts;
  }
}

function find(hosts: DnsHost[], index: number): DnsHost {
  const host = hosts.find((h) => h.index === index);
  if (!host) throw new AppError(ErrorCode.ROUTER_RULE_NOT_FOUND, 404);
  return host;
}

function parse(page: string): DnsHost[] {
  const hosts = parseDnsHosts(page);
  if (!hosts) throw new AppError(ErrorCode.ROUTER_UNAVAILABLE, 502, 'Static DNS data not found');
  return hosts;
}
