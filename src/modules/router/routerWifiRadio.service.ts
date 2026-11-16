import { z } from 'zod';
import { AppError } from '../../common/errors/AppError';
import { ErrorCode } from '../../common/errors/errorCodes';
import type { RequestContext } from '../auth/auth.types';
import { parseWifiRadios, parseWpsStates, type WifiRadio } from './huaweiParser';
import type { RouterWriter } from './routerWriter';

/** Power levels the router's page offers, in percent. */
export const POWER_LEVELS = [100, 80, 60, 40, 20] as const;
/** Manual channels offered: 2.4 GHz 1–13 (Serbia); 5 GHz only the non-DFS 36–48. */
export const CHANNELS = {
  '2.4 GHz': [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13],
  '5 GHz': [36, 40, 44, 48],
} as const;

/** Channel widths and their `X_HW_HT20` codes, as the router's advanced page offers them in 11n/ac/ax. */
const WIDTH_CODES = { 'auto-40': '0', '20': '1', '40': '2', 'auto-80': '3', '160': '4' } as const;
export type ChannelWidth = keyof typeof WIDTH_CODES;
/** Offered per band: 80 MHz and up only on 5 GHz; 160 MHz only in 11ax. */
export const WIDTHS: Record<'2.4 GHz' | '5 GHz', ChannelWidth[]> = {
  '2.4 GHz': ['auto-40', '20', '40'],
  '5 GHz': ['auto-80', 'auto-40', '20', '40', '160'],
};
/** Legacy standards run at 20 MHz only. */
const LEGACY = ['11a', '11b', '11g', '11bg'];

export const wifiRadioSchema = z.object({
  band: z.enum(['2.4 GHz', '5 GHz']),
  /** 'auto' or a channel number valid for the band. */
  channel: z.union([z.literal('auto'), z.number().int()]),
  power: z.union(
    POWER_LEVELS.map((p) => z.literal(p)) as [z.ZodLiteral<100>, ...z.ZodLiteral<number>[]]
  ),
  width: z.enum(Object.keys(WIDTH_CODES) as [ChannelWidth, ...ChannelWidth[]]),
});

export const wpsSchema = z.object({ band: z.enum(['2.4 GHz', '5 GHz']), enabled: z.boolean() });

/** A radio as Nuvytrix shows it: width by name, and WPS of the band's first network. */
export interface RadioState extends WifiRadio {
  width: ChannelWidth | null;
  /** Null when the router shows no WPS for the network. */
  wpsEnabled: boolean | null;
}

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

  async getRadios(): Promise<RadioState[]> {
    const { wifi } = await this.writer.read(['wifi'] as const);
    return parse(wifi);
  }

  async setRadio(input: WifiRadioInput, adminId: number, context: RequestContext) {
    this.writer.requireWritable();
    if (
      input.channel !== 'auto' &&
      !(CHANNELS[input.band] as readonly number[]).includes(input.channel)
    ) {
      throw refuse(`Channel ${input.channel} is not offered for ${input.band}`);
    }
    if (!WIDTHS[input.band].includes(input.width)) {
      throw refuse(`${input.width} MHz is not offered for ${input.band}`);
    }
    const before = (await this.getRadios()).find((r) => r.band === input.band);
    if (!before) throw new AppError(ErrorCode.ROUTER_RULE_NOT_FOUND, 404);
    if (LEGACY.includes(before.standard) && input.width !== '20') {
      throw refuse(`${before.standard} runs at 20 MHz only`);
    }
    if (input.width === '160' && before.standard !== '11ax') {
      throw refuse('160 MHz needs Wi-Fi 6 (11ax) mode');
    }
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
          'y.X_HW_HT20': WIDTH_CODES[input.width],
        },
      },
      parse,
      verify: (after) => {
        const radio = after.find((r) => r.domain === before.domain);
        return radio &&
          radio.power === input.power &&
          radio.width === input.width &&
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

  /** WPS (push button) on the band's first network: `set.cgi?z=<network>.WPS` with `z.Enable`. */
  async setWps(input: z.infer<typeof wpsSchema>, adminId: number, context: RequestContext) {
    this.writer.requireWritable();
    const before = (await this.getRadios()).find((r) => r.band === input.band);
    if (!before || before.wpsEnabled === null) {
      throw new AppError(ErrorCode.ROUTER_RULE_NOT_FOUND, 404);
    }
    return this.writer.write({
      action: 'router.wifi_wps_changed',
      entityType: 'router_wifi_wps',
      form: {
        page: 'wifi',
        action: 'set',
        objectKey: 'z',
        object: `${before.domain}.WPS`,
        fields: { 'z.Enable': input.enabled ? '1' : '0' },
      },
      parse,
      verify: (after) => {
        const radio = after.find((r) => r.domain === before.domain);
        return radio && radio.wpsEnabled === input.enabled ? { radio } : null;
      },
      adminId,
      context,
      details: { before: { wpsEnabled: before.wpsEnabled }, requested: input },
    });
  }
}

const refuse = (message: string) => new AppError(ErrorCode.ROUTER_WRITE_REFUSED, 422, message);

function parse(page: string): RadioState[] {
  const radios = parseWifiRadios(page);
  if (!radios) throw new AppError(ErrorCode.ROUTER_UNAVAILABLE, 502, 'Wi-Fi radio data not found');
  const wps = parseWpsStates(page);
  const names = Object.keys(WIDTH_CODES) as ChannelWidth[];
  return radios.map((r) => ({
    ...r,
    width: names.find((n) => WIDTH_CODES[n] === r.channelWidth) ?? null,
    wpsEnabled: wps.get(r.domain) ?? null,
  }));
}
