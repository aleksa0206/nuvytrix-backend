import { z } from 'zod';
import { macAddress } from './routerDhcp.schema';

const name = z
  .string()
  .trim()
  .min(1)
  .max(32)
  .regex(/^[A-Za-z0-9 _.-]+$/, 'Letters, digits, spaces, dot, dash and underscore only');
const mode = z.enum(['block', 'allow']);
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM, 00:00–23:59');

export const parentalTemplateSchema = z.object({ name });

export const parentalTemplateUpdateSchema = z
  .object({
    name: name.optional(),
    timeEnabled: z.boolean().optional(),
    timeMode: mode.optional(),
    urlEnabled: z.boolean().optional(),
    urlMode: mode.optional(),
  })
  .refine((body) => Object.values(body).some((v) => v !== undefined), 'Nothing to change');

export const parentalPeriodSchema = z
  .object({
    start: time,
    end: time,
    /** 1 = Monday … 7 = Sunday. */
    days: z.array(z.number().int().min(1).max(7)).min(1).max(7),
  })
  .refine((p) => p.start < p.end, { path: ['end'], message: 'The end must be after the start' })
  .refine((p) => new Set(p.days).size === p.days.length, {
    path: ['days'],
    message: 'A day is listed twice',
  });

/** A host name with an optional path, as the router's form takes it; a scheme is dropped. */
export const parentalUrlSchema = z.object({
  url: z
    .string()
    .trim()
    .transform((value) => value.replace(/^https?:\/\//i, ''))
    .pipe(
      z
        .string()
        .min(1)
        .max(64)
        .regex(
          /^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*(\/[\x21-\x7e]*)?$/,
          'Use a site like example.com or example.com/path'
        )
    ),
});

export const parentalDeviceSchema = z.object({
  mac: macAddress,
  description: z
    .string()
    .trim()
    .max(32)
    .regex(/^[A-Za-z0-9 _.-]*$/, 'Letters, digits, spaces, dot, dash and underscore only')
    .default(''),
  template: z.number().int().min(1).max(64),
});

export const parentalTemplateParams = z.object({
  template: z.coerce.number().int().min(1).max(64),
});
export const parentalItemParams = parentalTemplateParams.extend({
  item: z.coerce.number().int().min(1).max(9999),
});
export const parentalDeviceParams = z.object({ index: z.coerce.number().int().min(1).max(9999) });

export type ParentalTemplateUpdate = z.infer<typeof parentalTemplateUpdateSchema>;
export type ParentalPeriodInput = z.infer<typeof parentalPeriodSchema>;
export type ParentalDeviceInput = z.infer<typeof parentalDeviceSchema>;
