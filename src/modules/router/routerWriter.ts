import { AppError } from '../../common/errors/AppError';
import { ErrorCode } from '../../common/errors/errorCodes';
import { logger } from '../../config/logger';
import type { RequestContext } from '../auth/auth.types';
import type { AuditService } from '../audit/audit.service';
import type { AuditAction } from '../audit/audit.types';
import {
  RouterAuthError,
  RouterUnavailableError,
  type FormSubmission,
  type HuaweiWebClient,
  type RouterPage,
} from './huaweiWebClient';

export interface RouterWrite<S, T extends object> {
  action: AuditAction;
  entityType: string;
  form: FormSubmission;
  /** Parses the page the router shows after the write. */
  parse: (page: string) => S;
  /** Returns the result when the change is visible, or null when the router did not apply it. */
  verify: (after: S) => T | null;
  adminId: number;
  context: RequestContext;
  /** Audit details: `before` and `requested`, so every change can be undone by hand. */
  details: Record<string, unknown>;
}

/**
 * The shared part of every router configuration change: the ROUTER_WRITES_ENABLED switch, reading
 * pages live, submitting the router's own form, verifying by reading back, and auditing every
 * attempt with its outcome (applied / not_applied / failed).
 */
export class RouterWriter {
  constructor(
    private web: HuaweiWebClient,
    private auditService: AuditService,
    private settings: { writesEnabled: boolean }
  ) {}

  get writesEnabled(): boolean {
    return this.settings.writesEnabled;
  }

  /** Reads pages now (not from the last poll), so edits start from the router's real state. */
  read<T extends RouterPage>(pages: readonly T[]): Promise<Record<T, string>> {
    if (!this.web.isConfigured) throw new AppError(ErrorCode.ROUTER_NOT_CONFIGURED, 503);
    return this.call(() => this.web.fetchPages(pages));
  }

  requireWritable() {
    if (!this.settings.writesEnabled) throw new AppError(ErrorCode.ROUTER_WRITES_DISABLED, 403);
  }

  async write<S, T extends object>(write: RouterWrite<S, T>): Promise<T & { state: S }> {
    const { form } = write;
    const audit = (outcome: string, extra: Record<string, unknown> = {}) =>
      this.auditService.record({
        adminId: write.adminId,
        action: write.action,
        entityType: write.entityType,
        // A delete names the removed object in its body; add and set name it in the URL.
        entityId: form.action === 'del' ? Object.keys(form.fields)[0] : form.object,
        details: { ...write.details, outcome, ...extra },
        ipAddress: write.context.ipAddress,
      });

    let after: S;
    try {
      after = write.parse(await this.call(() => this.web.submitForm(form)));
    } catch (err) {
      // A timeout can still have changed the router; the next read shows the real state.
      await audit('failed', { error: (err as Error).message });
      throw err;
    }
    const verified = write.verify(after);
    if (!verified) {
      await audit('not_applied', { after });
      logger.warn({ action: write.action }, 'Router did not show the requested change');
      throw new AppError(ErrorCode.ROUTER_WRITE_NOT_APPLIED, 502);
    }
    await audit('applied', { after: Object.keys(verified).length ? verified : after });
    return { ...verified, state: after };
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
