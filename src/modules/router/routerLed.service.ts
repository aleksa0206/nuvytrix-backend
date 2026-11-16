import { z } from 'zod';
import { AppError } from '../../common/errors/AppError';
import { ErrorCode } from '../../common/errors/errorCodes';
import type { RequestContext } from '../auth/auth.types';
import { parseStringVar } from './huaweiParser';
import type { RouterWriter } from './routerWriter';

/**
 * The router's LED modes: on, or off. The page also knows `2` (off after a short delay); this model
 * does not accept it (verified 2026-11-16), so it is not offered.
 */
const MODES = { on: '0', off: '1' } as const;
export type LedMode = keyof typeof MODES;

export const ledSchema = z.object({ mode: z.enum(['on', 'off']) });

/**
 * The router's indicator lights (Maintenance → Indicator Status): `X_HW_LedSwitch` on
 * `X_HW_SSMPPDT.Deviceinfo`. Read back from `var EnableLedSwitch` on ledcfg.asp.
 */
export class RouterLedService {
  constructor(private writer: RouterWriter) {}

  get writesEnabled(): boolean {
    return this.writer.writesEnabled;
  }

  async getState(): Promise<{ mode: LedMode }> {
    const { led } = await this.writer.read(['led'] as const);
    return parse(led);
  }

  async setMode(mode: LedMode, adminId: number, context: RequestContext) {
    this.writer.requireWritable();
    const before = await this.getState();
    return this.writer.write({
      action: 'router.led_changed',
      entityType: 'router_led',
      form: {
        page: 'led',
        action: 'set',
        object: 'InternetGatewayDevice.X_HW_SSMPPDT.Deviceinfo',
        fields: { 'x.X_HW_LedSwitch': MODES[mode] },
      },
      parse,
      verify: (after) => (after.mode === mode ? {} : null),
      adminId,
      context,
      details: { before, requested: { mode } },
    });
  }
}

function parse(page: string): { mode: LedMode } {
  const value = page.includes('function stLedOffTimeInfo')
    ? parseStringVar(page, 'EnableLedSwitch')
    : null;
  const mode = (Object.keys(MODES) as LedMode[]).find((m) => MODES[m] === value);
  if (!mode) throw new AppError(ErrorCode.ROUTER_UNAVAILABLE, 502, 'LED settings not found');
  return { mode };
}
