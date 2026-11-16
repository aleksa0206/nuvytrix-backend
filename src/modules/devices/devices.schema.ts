import { z } from 'zod';
import { paginationSchema } from '../../common/utils/pagination';
import { DEVICE_TYPES } from './devices.types';

export const idParamSchema = z.object({ id: z.coerce.number().int().positive() });

export const deviceListQuerySchema = paginationSchema.extend({
  search: z.string().trim().max(100).optional(),
  status: z.enum(['online', 'offline', 'new']).optional(),
  trust: z.enum(['trusted', 'untrusted', 'unreviewed']).optional(),
  tag: z
    .string()
    .trim()
    .regex(/^[a-z0-9][a-z0-9-]{0,23}$/)
    .optional(),
  sort: z.enum(['last_seen_at', 'first_seen_at', 'ip_address', 'name']).default('ip_address'),
  order: z.enum(['asc', 'desc']).default('asc'),
});

export const updateDeviceSchema = z
  .object({
    customName: z.string().trim().max(100).nullable(),
    deviceType: z.enum(DEVICE_TYPES).nullable(),
    notes: z.string().max(5000).nullable(),
    tags: z
      .array(
        z
          .string()
          .trim()
          .toLowerCase()
          .regex(/^[a-z0-9][a-z0-9-]{0,23}$/, 'Tags: lowercase letters, digits and dashes')
      )
      .max(10)
      .transform((tags) => [...new Set(tags)]),
    trusted: z.boolean().nullable(),
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, 'At least one field is required');

export const presenceQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(30).default(7),
});

export const startScanSchema = z.object({
  target: z.string().trim().max(18).optional(),
});

export const scanListQuerySchema = paginationSchema;
