import { z } from 'zod';
import { ipToInt } from './routerFirewall.schema';

const ipv4 = z.ipv4({ message: 'Must be an IPv4 address' });
const optionalIpv4 = z.union([ipv4, z.literal('')]).default('');
const port = z.number().int().min(1).max(65535);

export const PORT_PROTOCOLS = ['TCP', 'UDP', 'TCP/UDP'] as const;

export const portMappingSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1)
      .max(31)
      .regex(/^[A-Za-z0-9 _.-]+$/, 'Letters, digits, spaces, dot, dash and underscore only'),
    enabled: z.boolean(),
    protocol: z.enum(PORT_PROTOCOLS),
    internalHost: ipv4,
    /** Port on the device; with an external range, the first port of the range on the device. */
    internalPort: port,
    externalPortStart: port,
    externalPortEnd: port,
    /** Optional: only these internet hosts may use the mapping. */
    remoteHostStart: optionalIpv4,
    remoteHostEnd: optionalIpv4,
  })
  .superRefine((m, ctx) => {
    const issue = (path: string, message: string) =>
      ctx.addIssue({ code: 'custom', path: [path], message });
    if (m.externalPortEnd < m.externalPortStart) {
      issue('externalPortEnd', 'The last port must not be lower than the first');
    }
    if (m.remoteHostEnd && !m.remoteHostStart) {
      issue('remoteHostEnd', 'An end address needs a start address');
    }
    if (
      m.remoteHostStart &&
      m.remoteHostEnd &&
      ipToInt(m.remoteHostEnd) < ipToInt(m.remoteHostStart)
    ) {
      issue('remoteHostEnd', 'The end address must not be lower than the start address');
    }
  });

/** Mappings are addressed by their position on the router: `PortMapping.{index}` on the WAN. */
export const portMappingIndexSchema = z.object({
  index: z.coerce.number().int().min(1).max(9999),
});

export type PortMappingInput = z.infer<typeof portMappingSchema>;
