import { z } from 'zod';

/** A host name such as `nas.lan` or `printer`: letters, digits and dashes per label, 255 at most. */
const hostName = z
  .string()
  .trim()
  .toLowerCase()
  .max(255)
  .regex(
    /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/,
    'Use a name like nas.lan'
  );

export const dnsHostSchema = z.object({
  name: hostName,
  /** IPv4 or IPv6; the router keeps one entry per name and address family. */
  ip: z.union([z.ipv4(), z.ipv6()], { message: 'Must be an IPv4 or IPv6 address' }),
});

export const dnsHostIndexSchema = z.object({ index: z.coerce.number().int().min(1).max(9999) });

export type DnsHostInput = z.infer<typeof dnsHostSchema>;
