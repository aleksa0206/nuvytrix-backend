import { AppError } from '../../common/errors/AppError';
import { ErrorCode } from '../../common/errors/errorCodes';
import type { RequestContext } from '../auth/auth.types';
import { logger } from '../../config/logger';
import type { AuditService } from '../audit/audit.service';
import type { AuditAction } from '../audit/audit.types';
import { parseIpFilter, type IpFilterRule, type IpFilterState } from './huaweiParser';
import {
  RouterAuthError,
  RouterUnavailableError,
  type FormSubmission,
  type HuaweiWebClient,
} from './huaweiWebClient';
import type { RouterService } from './router.service';
import {
  ipToInt,
  type IpFilterRuleInput,
  type IpFilterSettingsInput,
} from './routerFirewall.schema';

const FILTER_OBJECT = 'InternetGatewayDevice.X_HW_Security';
const RULE_OBJECT = `${FILTER_OBJECT}.IpFilterIn`;

export interface RouterFirewallSettings {
  writesEnabled: boolean;
  /** LAN addresses no blacklist rule may cover: the router itself, the server, the admin's PC. */
  protectedAddresses: string[];
}

/**
 * Changes the router's IPv4 filter through the router's own form, then reads the page back and
 * only reports success when the router shows the change. Every attempt is audited.
 * Request formats: docs/huawei/firewall-management.md.
 */
export class RouterFirewallService {
  constructor(
    private web: HuaweiWebClient,
    private routerService: RouterService,
    private auditService: AuditService,
    private settings: RouterFirewallSettings
  ) {}

  get writesEnabled(): boolean {
    return this.settings.writesEnabled;
  }

  /** Reads the filter now (not from the last poll), so edits start from the router's real state. */
  async getState(): Promise<IpFilterState> {
    this.requireConfigured();
    const pages = await this.call(() => this.web.fetchPages(['ipFilter'] as const));
    return this.parse(pages.ipFilter);
  }

  async addRule(input: IpFilterRuleInput, adminId: number, context: RequestContext) {
    const before = await this.prepareWrite();
    this.checkRule(input, before);
    return this.write(
      'router.firewall_rule_created',
      { page: 'ipFilter', action: 'add', object: RULE_OBJECT, fields: formFields(input) },
      (after) => {
        const added = after.rules.find(
          (rule) => !before.rules.some((old) => old.domain === rule.domain) && sameRule(rule, input)
        );
        return added ? { rule: added } : null;
      },
      adminId,
      context,
      { requested: input }
    );
  }

  async updateRule(
    index: number,
    input: IpFilterRuleInput,
    adminId: number,
    context: RequestContext
  ) {
    const before = await this.prepareWrite();
    const domain = `${RULE_OBJECT}.${index}`;
    const current = before.rules.find((rule) => rule.domain === domain);
    if (!current) throw new AppError(ErrorCode.ROUTER_RULE_NOT_FOUND, 404);
    this.checkRule(input, { ...before, rules: before.rules.filter((r) => r !== current) });
    return this.write(
      'router.firewall_rule_updated',
      { page: 'ipFilter', action: 'set', object: domain, fields: formFields(input) },
      (after) => {
        const updated = after.rules.find((rule) => rule.domain === domain);
        return updated && sameRule(updated, input) ? { rule: updated } : null;
      },
      adminId,
      context,
      { before: current, requested: input }
    );
  }

  async deleteRule(index: number, adminId: number, context: RequestContext) {
    const before = await this.prepareWrite();
    const domain = `${RULE_OBJECT}.${index}`;
    const current = before.rules.find((rule) => rule.domain === domain);
    if (!current) throw new AppError(ErrorCode.ROUTER_RULE_NOT_FOUND, 404);
    return this.write(
      'router.firewall_rule_deleted',
      { page: 'ipFilter', action: 'del', fields: { [domain]: '' } },
      (after) => (after.rules.some((rule) => rule.domain === domain) ? null : {}),
      adminId,
      context,
      // The deleted rule is kept in the audit log so it can be recreated.
      { before: current }
    );
  }

  async changeSettings(input: IpFilterSettingsInput, adminId: number, context: RequestContext) {
    const before = await this.prepareWrite();
    const fields: Record<string, string> = {};
    if (input.enabled !== undefined) fields['x.IpFilterInRight'] = input.enabled ? '1' : '0';
    if (input.mode !== undefined) fields['x.IpFilterInPolicy'] = '0';
    return this.write(
      'router.firewall_settings_changed',
      { page: 'ipFilter', action: 'set', object: FILTER_OBJECT, fields },
      (after) =>
        (input.enabled === undefined || after.enabled === input.enabled) &&
        (input.mode === undefined || after.mode === input.mode)
          ? {}
          : null,
      adminId,
      context,
      { before: { enabled: before.enabled, mode: before.mode }, requested: input }
    );
  }

  private requireConfigured() {
    if (!this.routerService.isConfigured) {
      throw new AppError(ErrorCode.ROUTER_NOT_CONFIGURED, 503);
    }
  }

  private async prepareWrite(): Promise<IpFilterState> {
    if (!this.settings.writesEnabled) throw new AppError(ErrorCode.ROUTER_WRITES_DISABLED, 403);
    const state = await this.getState();
    // Rules in whitelist and hybrid mode have other fields and effects; not verified yet.
    if (state.mode !== 'blacklist') {
      throw new AppError(
        ErrorCode.ROUTER_WRITE_REFUSED,
        422,
        `The router filter is in ${state.mode} mode; Nuvytrix only edits blacklist mode`
      );
    }
    return state;
  }

  private checkRule(input: IpFilterRuleInput, state: IpFilterState) {
    if (input.lanIpStart) {
      const start = ipToInt(input.lanIpStart);
      const end = ipToInt(input.lanIpEnd || input.lanIpStart);
      const hit = this.settings.protectedAddresses.find((ip) => {
        const value = ipToInt(ip);
        return value >= start && value <= end;
      });
      if (hit) {
        throw new AppError(
          ErrorCode.ROUTER_WRITE_REFUSED,
          422,
          `The LAN range includes ${hit}, which must stay reachable (router, server or admin PC)`
        );
      }
    }
    if (state.rules.some((rule) => sameRule(rule, input))) {
      throw new AppError(ErrorCode.ROUTER_WRITE_REFUSED, 422, 'The router already has this rule');
    }
    if (state.rules.some((rule) => rule.name === input.name)) {
      throw new AppError(ErrorCode.ROUTER_WRITE_REFUSED, 422, 'A rule with this name exists');
    }
  }

  private async write<T extends object>(
    action: AuditAction,
    form: FormSubmission,
    verify: (after: IpFilterState) => T | null,
    adminId: number,
    context: RequestContext,
    details: Record<string, unknown>
  ): Promise<T & { state: IpFilterState }> {
    const audit = (outcome: string, extra: Record<string, unknown> = {}) =>
      this.auditService.record({
        adminId,
        action,
        entityType: 'router_ip_filter',
        entityId: form.object ?? Object.keys(form.fields)[0],
        details: { ...details, outcome, ...extra },
        ipAddress: context.ipAddress,
      });

    let after: IpFilterState;
    try {
      after = this.parse(await this.call(() => this.web.submitForm(form)));
    } catch (err) {
      // A timeout can still have changed the router; the next read shows the real state.
      await audit('failed', { error: (err as Error).message });
      throw err;
    }
    this.routerService.updateIpFilter(after);
    const verified = verify(after);
    if (!verified) {
      await audit('not_applied', { after });
      logger.warn({ action }, 'Router did not show the requested firewall change');
      throw new AppError(ErrorCode.ROUTER_WRITE_NOT_APPLIED, 502);
    }
    await audit('applied', { after: 'rule' in verified ? verified.rule : after });
    return { ...verified, state: after };
  }

  private parse(page: string): IpFilterState {
    const state = parseIpFilter(page);
    if (!state) throw new AppError(ErrorCode.ROUTER_UNAVAILABLE, 502, 'IPv4 filter not found');
    return state;
  }

  private async call<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (err) {
      if (err instanceof RouterAuthError || err instanceof RouterUnavailableError) {
        throw new AppError(ErrorCode.ROUTER_UNAVAILABLE, 503, err.message);
      }
      throw err;
    }
  }
}

/** The fields the router's page posts. Direction is fixed: this firmware offers only Bidirectional. */
function formFields(rule: IpFilterRuleInput): Record<string, string> {
  return {
    'x.Protocol': rule.protocol,
    'x.Direction': 'Bidirectional',
    'x.Name': rule.name,
    'x.SourceIPStart': rule.lanIpStart,
    'x.SourceIPEnd': rule.lanIpEnd,
    'x.DestIPStart': rule.wanIpStart,
    'x.DestIPEnd': rule.wanIpEnd,
    'x.LanSideTcpPort': rule.lanTcpPorts,
    'x.LanSideUdpPort': rule.lanUdpPorts,
    'x.WanSideTcpPort': rule.wanTcpPorts,
    'x.WanSideUdpPort': rule.wanUdpPorts,
  };
}

function sameRule(rule: IpFilterRule, input: IpFilterRuleInput): boolean {
  return (
    rule.name === input.name &&
    rule.protocol === input.protocol &&
    rule.sourceIpStart === input.lanIpStart &&
    rule.sourceIpEnd === input.lanIpEnd &&
    rule.destIpStart === input.wanIpStart &&
    rule.destIpEnd === input.wanIpEnd &&
    rule.lanTcpPorts === input.lanTcpPorts &&
    rule.lanUdpPorts === input.lanUdpPorts &&
    rule.wanTcpPorts === input.wanTcpPorts &&
    rule.wanUdpPorts === input.wanUdpPorts
  );
}
