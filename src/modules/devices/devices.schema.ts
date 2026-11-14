import { z } from 'zod';
import { paginationSchema } from '../../common/utils/pagination';
import { DEVICE_TYPES } from './devices.types';

export const idParamSchema = z.object({ id: z.coerce.number().int().positive() });

export const deviceListQuerySchema = paginationSchema.extend({
  search: z.string().trim().max(100).optional(),
  status: z.enum(['online', 'offline', 'new']).optional(),
  sort: z.enum(['last_seen_at', 'first_seen_at', 'ip_address', 'name']).default('ip_address'),
  order: z.enum(['asc', 'desc']).default('asc'),
});

export const updateDeviceSchema = z
  .object({
    customName: z.string().trim().max(100).nullable(),
    deviceType: z.enum(DEVICE_TYPES).nullable(),
    notes: z.string().max(5000).nullable(),
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, 'At least one field is required');

export const startScanSchema = z.object({
  target: z.string().trim().max(18).optional(),
});

export const scanListQuerySchema = paginationSchema;
