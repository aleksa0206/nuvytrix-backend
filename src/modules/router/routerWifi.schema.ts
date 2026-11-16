import { z } from 'zod';

/** Printable ASCII, as the router's form requires (`isValidAscii`). */
const ascii = /^[\x20-\x7e]*$/;

export const WIFI_SECURITY = ['wpa2', 'wpa-wpa2'] as const;

const network = {
  ssid: z
    .string()
    .min(1)
    .max(32)
    .regex(ascii, 'Letters, digits and common symbols only')
    .refine((value) => value.trim() === value, 'No spaces at the start or end'),
  enabled: z.boolean(),
  visible: z.boolean(),
  /** Only WPA2 and WPA/WPA2 with a key; open and WEP networks are not created here. */
  security: z.enum(WIFI_SECURITY),
};

const password = z
  .string()
  .min(8, 'At least 8 characters')
  .max(63, 'At most 63 characters')
  .regex(ascii, 'Letters, digits and common symbols only')
  .refine((value) => value.trim() === value, 'No spaces at the start or end');

/** Changing a network: the password is optional and stays unchanged when left out. */
export const wifiUpdateSchema = z.object({ ...network, password: password.optional() });

export const wifiCreateSchema = z.object({
  ...network,
  band: z.enum(['2.4 GHz', '5 GHz']),
  password,
});

export const wifiIndexSchema = z.object({ index: z.coerce.number().int().min(1).max(16) });

export type WifiUpdateInput = z.infer<typeof wifiUpdateSchema>;
export type WifiCreateInput = z.infer<typeof wifiCreateSchema>;
