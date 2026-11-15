import { isIP } from 'node:net';
import { z } from 'zod';

export const idParamSchema = z.object({ id: z.coerce.number().int().positive() });

// RFC 1123 hostname labels; a leading "-" is impossible, so the value can never act as a ping option.
const HOSTNAME =
  /^(?=.{1,253}$)([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;

const hostSchema = z
  .string()
  .trim()
  .max(253)
  .refine(
    (value) => isIP(value) !== 0 || HOSTNAME.test(value),
    'Must be an IP address or hostname'
  );

const targetShape = {
  name: z.string().trim().min(1).max(100),
  kind: z.enum(['icmp', 'dns']),
  host: hostSchema,
  dnsQueryName: z.string().trim().regex(HOSTNAME, 'Must be a domain name').nullable().optional(),
  enabled: z.boolean().optional(),
};

export const createTargetSchema = z
  .object(targetShape)
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

export const seriesQuerySchema = z.object({
  hours: z.coerce
    .number()
    .int()
    .min(1)
    .max(24 * 90)
    .default(24),
});
