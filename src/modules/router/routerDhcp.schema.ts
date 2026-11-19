import { z } from 'zod';
import { ipToInt } from './routerFirewall.schema';

const ipv4 = z.ipv4({ message: 'Must be an IPv4 address' });

/** Accepts aa:bb:cc:dd:ee:ff or aa-bb-cc-dd-ee-ff in any case; stored lowercase with colons. */
export const macAddress = z
  .string()
  .trim()
  .regex(/^[0-9A-Fa-f]{2}([:-][0-9A-Fa-f]{2}){5}$/, 'Use a MAC address like aa:bb:cc:dd:ee:ff')
  .transform((value) => value.toLowerCase().replaceAll('-', ':'))
  .refine((value) => value !== '00:00:00:00:00:00', 'Not a device MAC address')
  .refine(
    (value) => (parseInt(value.slice(0, 2), 16) & 1) === 0,
    'Multicast MAC addresses are not allowed'
  );

export const dhcpReservationSchema = z.object({ mac: macAddress, ip: ipv4 });

/** The router accepts 1 s to 10 weeks; its form works in whole minutes. */
const MAX_LEASE = 604800 * 10;

export const dhcpServerSchema = z
  .object({
    startIp: ipv4,
    endIp: ipv4,
    leaseSeconds: z
      .number()
      .int()
      .min(60)
      .max(MAX_LEASE)
      .refine((value) => value % 60 === 0, 'Use whole minutes'),
  })
  .refine((pool) => ipToInt(pool.endIp) >= ipToInt(pool.startIp), {
    path: ['endIp'],
    message: 'The end address must not be lower than the start address',
  });

export type DhcpReservationInput = z.infer<typeof dhcpReservationSchema>;
export type DhcpServerInput = z.infer<typeof dhcpServerSchema>;
