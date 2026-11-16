import { ServiceUnavailableError } from '../../common/errors/AppError';
import { ErrorCode } from '../../common/errors/errorCodes';
import { logger } from '../../config/logger';
import { z } from 'zod';
import { AppError } from '../../common/errors/AppError';
import type { RequestContext } from '../auth/auth.types';
import type { AuditService } from '../audit/audit.service';
import type { AdGuardClient, TopList } from './adguardClient';

/** A domain for an allow or block rule: hostname labels only, so it cannot inject rule syntax. */
export const dnsRuleSchema = z.object({
  domain: z
    .string()
    .trim()
    .toLowerCase()
    .max(253)
    .regex(
      /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/,
      'Use a domain name like example.com'
    ),
  action: z.enum(['allow', 'block']),
});
export type DnsRule = z.infer<typeof dnsRuleSchema>;

const ruleText = (r: DnsRule) => (r.action === 'allow' ? `@@||${r.domain}^` : `||${r.domain}^`);
const RULE = /^(@@)?\|\|([a-z0-9.-]+)\^$/;

function flattenTopList(list: TopList | undefined) {
  return (list ?? []).flatMap((entry) =>
    Object.entries(entry).map(([name, count]) => ({ name, count }))
  );
}

export class DnsService {
  constructor(
    private adguard: AdGuardClient,
    private auditService?: AuditService,
    /** IP → device name, to show clients by name. */
    private names: (ips: string[]) => Promise<Map<string, string>> = async () => new Map()
  ) {}

  private requireConfigured() {
    if (!this.adguard.isConfigured) throw new ServiceUnavailableError(ErrorCode.DNS_NOT_CONFIGURED);
  }

  private async call<T>(work: () => Promise<T>): Promise<T> {
    this.requireConfigured();
    try {
      return await work();
    } catch (err) {
      if (err instanceof AppError) throw err;
      logger.warn({ err: (err as Error).message }, 'AdGuard Home request failed');
      throw new ServiceUnavailableError(ErrorCode.DNS_PROVIDER_UNAVAILABLE);
    }
  }

  /** Latest queries, newest first; optionally only blocked ones or matching a search. */
  async queryLog(params: { limit: number; search?: string; blockedOnly?: boolean }) {
    const log = await this.call(() => this.adguard.getQueryLog(params));
    const names = await this.names([...new Set(log.data.map((e) => e.client))]);
    return log.data.map((e) => ({
      at: e.time,
      client: e.client,
      clientName: names.get(e.client) ?? null,
      domain: e.question?.name ?? null,
      type: e.question?.type ?? null,
      blocked: (e.reason ?? '').startsWith('Filtered') && e.reason !== 'FilteredSafeSearch',
      reason: e.reason ?? null,
      elapsedMs: e.elapsedMs ? Math.round(Number(e.elapsedMs) * 100) / 100 : null,
      upstream: e.upstream || null,
    }));
  }

  /** Allow and block rules Nuvytrix manages, plus any other user rules (shown read-only). */
  async rules() {
    const all = await this.call(() => this.adguard.getUserRules());
    const managed: DnsRule[] = [];
    const other: string[] = [];
    for (const line of all.map((r) => r.trim()).filter((r) => r && !r.startsWith('!'))) {
      const m = RULE.exec(line);
      if (m) managed.push({ domain: m[2]!, action: m[1] ? 'allow' : 'block' });
      else other.push(line);
    }
    return { rules: managed, otherRules: other };
  }

  async addRule(rule: DnsRule, adminId: number, context: RequestContext) {
    const rules = await this.call(() => this.adguard.getUserRules());
    const text = ruleText(rule);
    if (!rules.includes(text)) await this.call(() => this.adguard.setUserRules([...rules, text]));
    await this.audit('dns.rule_added', rule, adminId, context);
    return this.rules();
  }

  async removeRule(rule: DnsRule, adminId: number, context: RequestContext) {
    const rules = await this.call(() => this.adguard.getUserRules());
    const text = ruleText(rule);
    await this.call(() => this.adguard.setUserRules(rules.filter((r) => r.trim() !== text)));
    await this.audit('dns.rule_removed', rule, adminId, context);
    return this.rules();
  }

  private audit(
    action: 'dns.rule_added' | 'dns.rule_removed',
    rule: DnsRule,
    adminId: number,
    context: RequestContext
  ) {
    return (
      this.auditService?.record({
        adminId,
        action,
        entityType: 'dns_rule',
        entityId: ruleText(rule),
        details: { ...rule },
        ipAddress: context.ipAddress,
      }) ?? Promise.resolve()
    );
  }

  async getStatus() {
    if (!this.adguard.isConfigured) {
      return { provider: 'adguard_home' as const, configured: false as const };
    }
    try {
      const status = await this.adguard.getStatus();
      return {
        provider: 'adguard_home' as const,
        configured: true as const,
        reachable: true as const,
        running: status.running,
        protectionEnabled: status.protection_enabled,
        version: status.version,
        dnsAddresses: status.dns_addresses,
      };
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'AdGuard Home status check failed');
      return {
        provider: 'adguard_home' as const,
        configured: true as const,
        reachable: false as const,
        error: 'AdGuard Home could not be reached with the configured address and credentials',
      };
    }
  }

  private async withNames(clients: { name: string; count: number }[]) {
    const names = await this.names(clients.map((c) => c.name));
    return clients.map((c) => ({ ...c, deviceName: names.get(c.name) ?? null }));
  }

  async getStats() {
    if (!this.adguard.isConfigured) throw new ServiceUnavailableError(ErrorCode.DNS_NOT_CONFIGURED);
    let stats;
    try {
      stats = await this.adguard.getStats();
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'AdGuard Home stats request failed');
      throw new ServiceUnavailableError(ErrorCode.DNS_PROVIDER_UNAVAILABLE);
    }
    const queries = stats.num_dns_queries;
    return {
      period: stats.time_units,
      totalQueries: queries,
      blockedByFilters: stats.num_blocked_filtering,
      blockedPercent:
        queries > 0 ? Math.round((stats.num_blocked_filtering / queries) * 10000) / 100 : null,
      safeBrowsingReplaced: stats.num_replaced_safebrowsing,
      parentalReplaced: stats.num_replaced_parental,
      // AdGuard reports seconds.
      avgProcessingMs: Math.round(stats.avg_processing_time * 100000) / 100,
      topQueriedDomains: flattenTopList(stats.top_queried_domains),
      topBlockedDomains: flattenTopList(stats.top_blocked_domains),
      topClients: await this.withNames(flattenTopList(stats.top_clients)),
      upstreams: flattenTopList(stats.top_upstreams_responses).map((u) => ({
        upstream: u.name,
        responses: u.count,
        avgMs:
          flattenTopList(stats.top_upstreams_avg_time).find((t) => t.name === u.name)?.count !==
          undefined
            ? Math.round(
                flattenTopList(stats.top_upstreams_avg_time).find((t) => t.name === u.name)!.count *
                  100000
              ) / 100
            : null,
      })),
    };
  }
}
