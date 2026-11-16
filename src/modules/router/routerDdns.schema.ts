import { z } from 'zod';

/** The providers this router's page offers (gnudip needs extra fields and is not offered here). */
export const DDNS_PROVIDERS = [
  'dyndns',
  'dyndns-static',
  'dyndns-custom',
  'no-ip',
  'easydns',
  'dtdns',
  'qdns',
  'qdns-static',
  'ORAY',
] as const;

const hostName = z
  .string()
  .trim()
  .toLowerCase()
  .max(255)
  .regex(
    /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/,
    'Use a name like home.example.com'
  );
const ascii = z.string().regex(/^[\x21-\x7e]+$/, 'Letters, digits and symbols, no spaces');

const entry = {
  enabled: z.boolean(),
  provider: z.enum(DDNS_PROVIDERS),
  username: ascii.min(1).max(256),
  /** The name kept up to date at the provider. */
  domainName: hostName,
  /** The provider's update server, e.g. members.dyndns.org. */
  serverHost: hostName,
  port: z.number().int().min(1).max(65535).default(80),
};

const password = ascii.min(1).max(256);

export const ddnsCreateSchema = z.object({ ...entry, password });
/** The router never shows the password: it stays unchanged when left out. */
export const ddnsUpdateSchema = z.object({ ...entry, password: password.optional() });
export const ddnsIndexSchema = z.object({ index: z.coerce.number().int().min(1).max(9999) });

export type DdnsCreateInput = z.infer<typeof ddnsCreateSchema>;
export type DdnsUpdateInput = z.infer<typeof ddnsUpdateSchema>;
