import { isIP } from 'node:net';
import { z } from 'zod';

export const idParamSchema = z.object({ id: z.coerce.number().int().positive() });

// RFC 1123 hostname labels; a leading "-" is impossible, so the value can never act as a ping option.
const HOSTNAME =
  /^(?=.{1,253}$)([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;

export const hostSchema = z
  .string()
  .trim()
  .max(253)
  .refine(
    (value) => isIP(value) !== 0 || HOSTNAME.test(value),
    'Must be an IP address or hostname'
  );

/** An http(s) URL without credentials; for HTTP targets. */
export function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
  } catch {
    return false;
  }
}

const targetShape = {
  name: z.string().trim().min(1).max(100),
  kind: z.enum(['icmp', 'dns', 'http']),
  // Checked per kind below: an IP or hostname for ping and DNS, a URL for HTTP.
  host: z.string().trim().min(1).max(255),
  dnsQueryName: z.string().trim().regex(HOSTNAME, 'Must be a domain name').nullable().optional(),
  enabled: z.boolean().optional(),
};

const hostMatchesKind = (target: { kind?: string; host?: string }) =>
  target.host === undefined ||
  (target.kind === 'http' ? isHttpUrl(target.host) : hostSchema.safeParse(target.host).success);

export const createTargetSchema = z
  .object(targetShape)
  .refine(hostMatchesKind, {
    message: 'Ping and DNS targets need an IP address or hostname; HTTP targets an http(s) URL',
    path: ['host'],
  })
  .refine((target) => target.kind !== 'dns' || isIP(target.host) !== 0, {
    message: 'A DNS target must be the IP address of a resolver',
    path: ['host'],
  })
  .refine((target) => target.kind !== 'dns' || Boolean(target.dnsQueryName), {
    message: 'DNS targets need a query name',
    path: ['dnsQueryName'],
  });

export const updateTargetSchema = z
  .object(targetShape)
  .partial()
  .refine((value) => Object.keys(value).length > 0, 'At least one field is required');

export const outageQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(90).default(7),
});

export const seriesQuerySchema = z.object({
  hours: z.coerce
    .number()
    .int()
    .min(1)
    .max(24 * 90)
    .default(24),
});
