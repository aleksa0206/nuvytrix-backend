import { z } from 'zod';
import { AppError } from '../../common/errors/AppError';
import { ErrorCode } from '../../common/errors/errorCodes';
import type { RequestContext } from '../auth/auth.types';
import type { AuditService } from '../audit/audit.service';
import { RouterUnavailableError, type HuaweiWebClient } from './huaweiWebClient';
import type { RouterWriter } from './routerWriter';

/** The caller types the word, so a stray click or a replayed request without it does nothing. */
export const rebootSchema = z.object({ confirm: z.literal('reboot') });

/** A second reboot within this time is refused (the router needs ~2-3 minutes to come back). */
const COOLDOWN_MS = 10 * 60_000;

/**
 * Restarts the router on an admin's explicit request, never automatically: the router page's own
 * "save and reboot" request (Maintenance → Configuration File, cfgfileroot.asp): `set.cgi` with
 * `x=…X_HW_DEBUG.SSP.DBSave&y=…X_HW_DEBUG.SMP.DM.ResetBoard` and only the form token.
 * Internet, Wi-Fi, DHCP and the hosted sites are down while it restarts. Audited before sending.
 */
export class RouterRebootService {
  private lastRequestAt = 0;

  constructor(
    private writer: RouterWriter,
    private web: HuaweiWebClient,
    private auditService: AuditService
  ) {}

  get writesEnabled(): boolean {
    return this.writer.writesEnabled;
  }

  async reboot(adminId: number, context: RequestContext): Promise<{ answered: boolean }> {
    this.writer.requireWritable();
    if (!this.web.isConfigured) throw new AppError(ErrorCode.ROUTER_NOT_CONFIGURED, 503);
    if (Date.now() - this.lastRequestAt < COOLDOWN_MS) {
      throw new AppError(
        ErrorCode.ROUTER_WRITE_REFUSED,
        422,
        'The router was asked to restart less than 10 minutes ago'
      );
    }
    // The router answers right now; a connection lost during the request below then means the
    // router went down to restart, not that it was unreachable all along.
    await this.writer.read(['cfgFile'] as const);
    this.lastRequestAt = Date.now();
    const audit = (outcome: string, extra: Record<string, unknown> = {}) =>
      this.auditService.record({
        adminId,
        action: 'router.reboot_requested',
        entityType: 'router',
        entityId: 'InternetGatewayDevice.X_HW_DEBUG.SMP.DM.ResetBoard',
        details: { outcome, ...extra },
        ipAddress: context.ipAddress,
      });
    // Recorded first: if the router goes down mid-request, the reason is still in the log.
    await audit('requested');
    try {
      await this.web.submitForm({
        page: 'cfgFile',
        action: 'set',
        object: 'InternetGatewayDevice.X_HW_DEBUG.SSP.DBSave',
        extraQuery: { y: 'InternetGatewayDevice.X_HW_DEBUG.SMP.DM.ResetBoard' },
        fields: {},
        readBack: false,
      });
      await audit('sent');
      return { answered: true };
    } catch (err) {
      // A router that restarts may drop the connection before answering; that is not a failure.
      if (err instanceof RouterUnavailableError) {
        await audit('sent_no_answer', { error: err.message });
        return { answered: false };
      }
      this.lastRequestAt = 0;
      await audit('failed', { error: (err as Error).message });
      throw new AppError(ErrorCode.ROUTER_UNAVAILABLE, 503, (err as Error).message);
    }
  }
}
