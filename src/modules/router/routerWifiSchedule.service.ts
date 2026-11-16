import { z } from 'zod';
import { AppError } from '../../common/errors/AppError';
import { ErrorCode } from '../../common/errors/errorCodes';
import type { RequestContext } from '../auth/auth.types';
import { parseWifiSchedule, type WifiSchedule } from './huaweiParser';
import type { RouterWriter } from './routerWriter';

const CTRL = 'InternetGatewayDevice.LANDevice.1.X_HW_WLANShutDownCtrl';
const KEYS = ['x', 'y', 'z', 'w'] as const;
const EVERY_DAY = '1,2,3,4,5,6,7';

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM, 00:00–23:59');

/** The router keeps four periods; Wi-Fi is switched off during each while the schedule is on. */
export const wifiScheduleSchema = z.object({
  enabled: z.boolean(),
  periods: z
    .array(
      z
        .object({
          start: time,
          end: time,
          /** 1 = Monday … 7 = Sunday. */
          days: z.array(z.number().int().min(1).max(7)).min(1).max(7),
        })
        .refine((p) => p.start < p.end, {
          path: ['end'],
          message: 'The end must be after the start',
        })
        .refine((p) => new Set(p.days).size === p.days.length, {
          path: ['days'],
          message: 'A day is listed twice',
        })
    )
    .max(4, 'The router keeps at most four periods'),
});

export type WifiScheduleInput = z.infer<typeof wifiScheduleSchema>;

/**
 * Automatic Wi-Fi shutdown (WLAN → Automatic Wi-Fi Shutdown): up to four periods during which the
 * router turns Wi-Fi off, and the switch that activates them. Periods and switch are written in one
 * session, as the router's page does in two steps, then read back.
 * Request formats: docs/huawei/wifi-management.md.
 */
export class RouterWifiScheduleService {
  constructor(private writer: RouterWriter) {}

  get writesEnabled(): boolean {
    return this.writer.writesEnabled;
  }

  async getSchedule(): Promise<WifiSchedule> {
    const { wifiSchedule } = await this.writer.read(['wifiSchedule'] as const);
    return parse(wifiSchedule);
  }

  async setSchedule(input: WifiScheduleInput, adminId: number, context: RequestContext) {
    this.writer.requireWritable();
    const before = await this.getSchedule();
    const periods = input.periods.map((p) => ({
      ...p,
      days: [...p.days].sort((a, b) => a - b),
    }));
    const fields: Record<string, string> = {};
    const query: Record<string, string> = {};
    KEYS.forEach((key, i) => {
      const p = periods[i];
      query[key] = `${CTRL}.Duration.${i + 1}`;
      fields[`${key}.StartTime`] = p?.start ?? '';
      fields[`${key}.EndTime`] = p?.end ?? '';
      fields[`${key}.RepeatDay`] = p ? p.days.join(',') : EVERY_DAY;
    });
    const { x, ...extraQuery } = query;
    return this.writer.write({
      action: 'router.wifi_schedule_changed',
      entityType: 'router_wifi_schedule',
      // First the periods (Duration.1–4), then the switch, in the same session.
      form: {
        page: 'wifiSchedule',
        action: 'set',
        object: CTRL,
        fields: { 'x.Enable': input.enabled ? '1' : '0' },
        before: { action: 'set', object: x!, extraQuery, fields },
      },
      parse,
      verify: (after) =>
        after.enabled === input.enabled &&
        after.periods.length === periods.length &&
        periods.every(
          (p, i) =>
            after.periods[i]?.start === p.start &&
            after.periods[i]?.end === p.end &&
            after.periods[i]?.days.join(',') === p.days.join(',')
        )
          ? {}
          : null,
      adminId,
      context,
      details: { before, requested: { enabled: input.enabled, periods } },
    });
  }
}

function parse(page: string): WifiSchedule {
  const schedule = parseWifiSchedule(page);
  if (!schedule) {
    throw new AppError(ErrorCode.ROUTER_UNAVAILABLE, 502, 'Wi-Fi schedule page not found');
  }
  return schedule;
}
