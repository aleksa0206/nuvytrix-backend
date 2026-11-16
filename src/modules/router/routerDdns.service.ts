import { AppError } from '../../common/errors/AppError';
import { ErrorCode } from '../../common/errors/errorCodes';
import type { RequestContext } from '../auth/auth.types';
import { parseDdns, parseInternetWan, type DdnsEntry } from './huaweiParser';
import type { DdnsCreateInput, DdnsUpdateInput } from './routerDdns.schema';
import type { RouterWriter } from './routerWriter';

/** The router page allows four DDNS entries per WAN connection. */
const MAX_PER_WAN = 4;

const refuse = (message: string) => new AppError(ErrorCode.ROUTER_WRITE_REFUSED, 422, message);

/** Audit details never carry the DDNS password: only whether one was set. */
const redact = <T extends { password?: string }>(input: T) => ({
  ...input,
  password: input.password ? '[changed]' : undefined,
});

/**
 * Dynamic DNS entries on the internet WAN connection, through the router's own form, verified by
 * reading back. The DDNS password is written only; the router never shows it.
 * Request formats: docs/huawei/dns-management.md.
 */
export class RouterDdnsService {
  constructor(private writer: RouterWriter) {}

  get writesEnabled(): boolean {
    return this.writer.writesEnabled;
  }

  async getState() {
    const pages = await this.writer.read(['ddns', 'wanList'] as const);
    return { internetWan: parseInternetWan(pages.wanList), entries: parse(pages.ddns) };
  }

  async addEntry(input: DdnsCreateInput, adminId: number, context: RequestContext) {
    const { wan, before } = await this.prepare(input);
    if (before.filter((e) => e.domain.startsWith(`${wan}.`)).length >= MAX_PER_WAN) {
      throw refuse(`The router holds at most ${MAX_PER_WAN} DDNS entries per connection`);
    }
    return this.writer.write({
      action: 'router.ddns_created',
      entityType: 'router_ddns',
      form: {
        page: 'ddns',
        action: 'add',
        object: `${wan}.X_HW_DDNSConfiguration`,
        fields: fields(input),
      },
      parse,
      verify: (after) => {
        const added = after.find(
          (e) => !before.some((o) => o.domain === e.domain) && same(e, input)
        );
        return added ? { entry: added } : null;
      },
      adminId,
      context,
      details: { requested: redact(input) },
    });
  }

  async updateEntry(
    index: number,
    input: DdnsUpdateInput,
    adminId: number,
    context: RequestContext
  ) {
    const { wan, before } = await this.prepare(input, index);
    const current = find(before, wan, index);
    return this.writer.write({
      action: 'router.ddns_updated',
      entityType: 'router_ddns',
      form: { page: 'ddns', action: 'set', object: current.domain, fields: fields(input) },
      parse,
      verify: (after) => {
        const updated = after.find((e) => e.domain === current.domain);
        return updated && same(updated, input) ? { entry: updated } : null;
      },
      adminId,
      context,
      details: { before: current, requested: redact(input) },
    });
  }

  async deleteEntry(index: number, adminId: number, context: RequestContext) {
    this.writer.requireWritable();
    const { internetWan, entries } = await this.getState();
    const current = find(entries, internetWan, index);
    return this.writer.write({
      action: 'router.ddns_deleted',
      entityType: 'router_ddns',
      form: { page: 'ddns', action: 'del', fields: { [current.domain]: '' } },
      parse,
      verify: (after) => (after.some((e) => e.domain === current.domain) ? null : {}),
      adminId,
      context,
      details: { before: current },
    });
  }

  private async prepare(input: DdnsUpdateInput, index?: number) {
    this.writer.requireWritable();
    const { internetWan, entries } = await this.getState();
    if (!internetWan) throw refuse('The router has no routed internet WAN connection');
    if (index !== undefined) find(entries, internetWan, index);
    if (entries.some((e) => e.domainName === input.domainName && e.index !== index)) {
      throw refuse(`${input.domainName} already has a DDNS entry`);
    }
    return { wan: internetWan, before: entries };
  }
}

function find(entries: DdnsEntry[], wan: string | null, index: number): DdnsEntry {
  const entry = entries.find((e) => e.domain === `${wan}.X_HW_DDNSConfiguration.${index}`);
  if (!entry) throw new AppError(ErrorCode.ROUTER_RULE_NOT_FOUND, 404);
  return entry;
}

function fields(input: DdnsUpdateInput): Record<string, string> {
  return {
    'x.DDNSCfgEnabled': input.enabled ? '1' : '0',
    'x.DDNSProvider': input.provider,
    'x.DDNSUsername': input.username,
    ...(input.password ? { 'x.DDNSPassword': input.password } : {}),
    'x.ServicePort': String(input.port),
    'x.DDNSDomainName': input.domainName,
    'x.DDNSHostName': input.serverHost,
  };
}

function same(e: DdnsEntry, input: DdnsUpdateInput): boolean {
  return (
    e.enabled === input.enabled &&
    e.provider === input.provider &&
    e.username === input.username &&
    e.port === input.port &&
    e.domainName === input.domainName &&
    e.serverHost === input.serverHost
  );
}

function parse(page: string): DdnsEntry[] {
  const entries = parseDdns(page);
  if (!entries) throw new AppError(ErrorCode.ROUTER_UNAVAILABLE, 502, 'DDNS page not found');
  return entries;
}
