import { isIP } from 'node:net';
import { z } from 'zod';
import { parseCidr } from '../../common/utils/ipv4';
import { directionSchema } from './firewall.schema';

export const POLICY_STATUSES = [
  'draft',
  'pending_manual',
  'marked_applied',
  'apply_failed',
  'retired',
] as const;
export type PolicyStatus = (typeof POLICY_STATUSES)[number];

/** "any", a single IPv4/IPv6 address, or an IPv4 CIDR. */
const endpointSchema = z
  .string()
  .trim()
  .max(64)
  .refine(
    (value) => value === 'any' || isIP(value) !== 0 || parseCidr(value) !== null,
    'Must be "any", an IP address or an IPv4 CIDR'
  );

const portsSchema = z
  .string()
  .trim()
  .regex(/^\d{1,5}(-\d{1,5})?$/, 'Use a port (443) or a range (1000-2000)')
  .refine((value) => {
    const [start, end = start] = value.split('-').map(Number) as [number, number?];
    return start >= 1 && end <= 65535 && start <= end;
  }, 'Ports must be 1-65535 and the range must be ascending');

const policyShape = {
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(2000).nullable().optional(),
  action: z.enum(['accept', 'deny']),
  direction: directionSchema,
  protocol: z.enum(['any', 'tcp', 'udp', 'icmp']),
  source: endpointSchema,
  destination: endpointSchema,
  destinationPorts: portsSchema.nullable().optional(),
};

const portsNeedTcpOrUdp = (policy: { protocol?: string; destinationPorts?: string | null }) =>
  !policy.destinationPorts || policy.protocol === 'tcp' || policy.protocol === 'udp';
const portsRule = { message: 'Ports apply only to TCP or UDP', path: ['destinationPorts'] };

export const createPolicySchema = z.object(policyShape).refine(portsNeedTcpOrUdp, portsRule);

export const updatePolicySchema = z
  .object(policyShape)
  .partial()
  .refine((value) => Object.keys(value).length > 0, 'At least one field is required');

export const changeStatusSchema = z.object({
  status: z.enum(POLICY_STATUSES),
  note: z.string().trim().max(500).optional(),
  confirm: z.boolean().optional(),
});

export const confirmSchema = z.object({ confirm: z.boolean().optional() });

export type CreatePolicyInput = z.infer<typeof createPolicySchema>;
export type UpdatePolicyInput = z.infer<typeof updatePolicySchema>;
