import { isIP } from 'node:net';
import { z } from 'zod';
import { paginationSchema } from '../../common/utils/pagination';

export const idParamSchema = z.object({ id: z.coerce.number().int().positive() });

const directionSchema = z.enum([
  'internet_to_lan',
  'internet_to_router',
  'lan_to_internet',
  'lan_to_router',
]);

const rangeShape = {
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
};

export const rangeQuerySchema = z
  .object(rangeShape)
  .refine((range) => !range.from || !range.to || range.from <= range.to, {
    message: '"from" must not be after "to"',
    path: ['from'],
  });

export const eventListQuerySchema = paginationSchema
  .extend({
    ...rangeShape,
    action: z.enum(['accept', 'deny']).optional(),
    direction: directionSchema.optional(),
    flow: z.enum(['inbound', 'outbound']).optional(),
    protocol: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9-]{1,16}$/)
      .transform((value) => value.toUpperCase())
      .optional(),
    ipVersion: z.coerce
      .number()
      .pipe(z.union([z.literal(4), z.literal(6)]))
      .optional(),
    ip: z
      .string()
      .trim()
      .refine((value) => isIP(value) !== 0, 'Must be an IP address')
      .optional(),
    port: z.coerce.number().int().min(0).max(65535).optional(),
    importId: z.coerce.number().int().positive().optional(),
    sort: z
      .enum(['occurred_at', 'source_ip', 'destination_ip', 'destination_port'])
      .default('occurred_at'),
    order: z.enum(['asc', 'desc']).default('desc'),
  })
  .refine((range) => !range.from || !range.to || range.from <= range.to, {
    message: '"from" must not be after "to"',
    path: ['from'],
  });

export const importListQuerySchema = paginationSchema;
export { directionSchema };
