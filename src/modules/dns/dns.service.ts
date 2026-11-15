import { ServiceUnavailableError } from '../../common/errors/AppError';
import { ErrorCode } from '../../common/errors/errorCodes';
import { logger } from '../../config/logger';
import type { AdGuardClient, TopList } from './adguardClient';

function flattenTopList(list: TopList | undefined) {
  return (list ?? []).flatMap((entry) =>
    Object.entries(entry).map(([name, count]) => ({ name, count }))
  );
}

export class DnsService {
  constructor(private adguard: AdGuardClient) {}

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
      topClients: flattenTopList(stats.top_clients),
    };
  }
}
