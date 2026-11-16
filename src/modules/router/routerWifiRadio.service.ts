import { z } from 'zod';
import { AppError } from '../../common/errors/AppError';
import { ErrorCode } from '../../common/errors/errorCodes';
import type { RequestContext } from '../auth/auth.types';
import { parseWifiRadios, type WifiRadio } from './huaweiParser';
import type { RouterWriter } from './routerWriter';

/** Power levels the router's page offers, in percent. */
export const POWER_LEVELS = [100, 80, 60, 40, 20] as const;
/** Manual channels offered: 2.4 GHz 1–13 (Serbia); 5 GHz only the non-DFS 36–48. */
export const CHANNELS = {
  '2.4 GHz': [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13],
  '5 GHz': [36, 40, 44, 48],
} as const;

export const wifiRadioSchema = z.object({
  band: z.enum(['2.4 GHz', '5 GHz']),
  /** 'auto' or a channel number valid for the band. */
  channel: z.union([z.literal('auto'), z.number().int()]),
  power: z.union(
    POWER_LEVELS.map((p) => z.literal(p)) as [z.ZodLiteral<100>, ...z.ZodLiteral<number>[]]
  ),
});

export type WifiRadioInput = z.infer<typeof wifiRadioSchema>;

/**
 * Radio settings per band (WLAN → Advanced): automatic or manual channel and transmit power, sent to
 * the band's first network as the router's advanced page does, and read back from WlanBasic.asp.
 * Changing them restarts that radio, so its Wi-Fi devices drop for a moment.
 * Request format: docs/huawei/wifi-management.md.
 */
export class RouterWifiRadioService {
  constructor(private writer: RouterWriter) {}

  get writesEnabled(): boolean {
    return this.writer.writesEnabled;
  }

  async getRadios(): Promise<WifiRadio[]> {
    const { wifi } = await this.writer.read(['wifi'] as const);
    return parse(wifi);
  }

  async setRadio(input: WifiRadioInput, adminId: number, context: RequestContext) {
    this.writer.requireWritable();
    if (
      input.channel !== 'auto' &&
      !(CHANNELS[input.band] as readonly number[]).includes(input.channel)
    ) {
      throw new AppError(
        ErrorCode.ROUTER_WRITE_REFUSED,
        422,
        `Channel ${input.channel} is not offered for ${input.band}`
      );
    }
    const before = (await this.getRadios()).find((r) => r.band === input.band);
    if (!before) throw new AppError(ErrorCode.ROUTER_RULE_NOT_FOUND, 404);
    const auto = input.channel === 'auto';
    return this.writer.write({
      action: 'router.wifi_radio_changed',
      entityType: 'router_wifi_radio',
      form: {
        page: 'wifiAdvanced',
        readBack: 'wifi',
        action: 'set',
        objectKey: 'y',
        object: before.domain,
        fields: {
          'y.Channel': auto ? '0' : String(input.channel),
          'y.AutoChannelEnable': auto ? '1' : '0',
          'y.TransmitPower': String(input.power),
        },
      },
      parse,
      verify: (after) => {
        const radio = after.find((r) => r.domain === before.domain);
        return radio &&
          radio.power === input.power &&
          radio.autoChannel === auto &&
          (auto || radio.channel === input.channel)
          ? { radio }
          : null;
      },
      adminId,
      context,
      details: { before, requested: input },
    });
  }
}

function parse(page: string): WifiRadio[] {
  const radios = parseWifiRadios(page);
  if (!radios) throw new AppError(ErrorCode.ROUTER_UNAVAILABLE, 502, 'Wi-Fi radio data not found');
  return radios;
}
