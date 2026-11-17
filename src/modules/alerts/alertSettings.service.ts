import type { Knex } from 'knex';
import { z } from 'zod';
import type { RequestContext } from '../auth/auth.types';
import type { AuditService } from '../audit/audit.service';

/** Alert thresholds the user can change; bounds keep them meaningful. */
export const thresholdsSchema = z.object({
  diskPercent: z.number().int().min(50).max(99),
  memoryPercent: z.number().int().min(50).max(99),
  temperatureC: z.number().int().min(50).max(105),
  /** Fiber receive power below this is "weak" (dBm); recovery is 2 dB better. */
  opticalWeakDbm: z.number().min(-30).max(-15),
  /** Ping latency, loss and jitter over the last few checks of a target. */
  latencyMs: z.number().int().min(5).max(5000),
  packetLossPercent: z.number().int().min(1).max(100),
  jitterMs: z.number().int().min(1).max(1000),
  /** Failed SSH logins from one address within 10 minutes. */
  sshFailures: z.number().int().min(2).max(100),
  /** Hours without a successful backup before the backup alert. */
  backupMaxAgeHours: z
    .number()
    .int()
    .min(6)
    .max(24 * 14),
});
export type Thresholds = z.infer<typeof thresholdsSchema>;

export const DEFAULT_THRESHOLDS: Thresholds = {
  diskPercent: 90,
  memoryPercent: 90,
  temperatureC: 90,
  opticalWeakDbm: -27,
  latencyMs: 200,
  packetLossPercent: 20,
  jitterMs: 50,
  sshFailures: 5,
  backupMaxAgeHours: 30,
};

const KEY = 'alert_thresholds';

/** Thresholds stored in app_settings, cached; services read them on every check. */
export class AlertSettingsService {
  private cache: Thresholds = DEFAULT_THRESHOLDS;

  constructor(
    private db: Knex,
    private auditService?: AuditService
  ) {}

  /** Current thresholds (defaults until the stored ones are loaded). */
  get current(): Thresholds {
    return this.cache;
  }

  async load(): Promise<Thresholds> {
    const row = await this.db('app_settings').where({ key: KEY }).first();
    const stored = thresholdsSchema.partial().safeParse(row?.value ?? {});
    this.cache = { ...DEFAULT_THRESHOLDS, ...(stored.success ? stored.data : {}) };
    return this.cache;
  }

  async update(changes: Partial<Thresholds>, adminId: number, context: RequestContext) {
    const next = { ...(await this.load()), ...changes };
    await this.db('app_settings')
      .insert({ key: KEY, value: JSON.stringify(next), updated_at: this.db.fn.now() })
      .onConflict('key')
      .merge();
    this.cache = next;
    await this.auditService?.record({
      adminId,
      action: 'alerts.thresholds_changed',
      entityType: 'alert_thresholds',
      entityId: KEY,
      details: { changes },
      ipAddress: context.ipAddress,
    });
    return next;
  }
}
