import { z } from 'zod';
import { macAddress } from './routerDhcp.schema';

export const macFilterListSchema = z.object({ list: z.enum(['lan', 'wifi']) });

export const macFilterEntryParamsSchema = macFilterListSchema.extend({
  index: z.coerce.number().int().min(1).max(9999),
});

export const macFilterEntrySchema = z.object({
  mac: macAddress,
  name: z
    .string()
    .trim()
    .max(32)
    .regex(/^[A-Za-z0-9 _.-]*$/, 'Letters, digits, spaces, dot, dash and underscore only')
    .default(''),
  /** Wi-Fi list only: the network, as the router names it (`SSID-1`, `SSID-5`). */
  ssid: z
    .string()
    .regex(/^SSID-\d$/, 'Pick a Wi-Fi network')
    .optional(),
});

export const macFilterSettingsSchema = z.object({ enabled: z.boolean() });

export type MacFilterList = z.infer<typeof macFilterListSchema>['list'];
export type MacFilterEntryInput = z.infer<typeof macFilterEntrySchema>;
