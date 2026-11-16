import { z } from 'zod';

const ipv4 = z.ipv4({ message: 'Must be an IPv4 address' });
const optionalIpv4 = z.union([ipv4, z.literal('')]).default('');

/** Router port syntax: comma-separated ports or `start:end` ranges, 1-65535, no leading zeros. */
const PORT = '([1-9][0-9]{0,4})';
const PORT_LIST = new RegExp(`^${PORT}(:${PORT})?(,${PORT}(:${PORT})?)*$`);

const ports = z
  .string()
  .trim()
  .default('')
  .refine((value) => value === '' || PORT_LIST.test(value), 'Use ports like 80,443 or 8000:8080')
  .refine(
    (value) =>
      value === '' ||
      value.split(',').every((item) => {
        const [start, end] = item.split(':').map(Number) as [number, number | undefined];
        return start <= 65535 && (end === undefined || (end <= 65535 && start < end));
      }),
    'Ports must be 1-65535 and ranges must go from low to high'
  )
  .refine((value) => value === '' || value.split(',').length <= 15, 'At most 15 ports or ranges');

export const PROTOCOLS = ['ALL', 'TCP/UDP', 'TCP', 'UDP', 'ICMP'] as const;

const toInt = (ip: string) => ip.split('.').reduce((n, part) => n * 256 + Number(part), 0);

export const ipFilterRuleSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1)
      .max(31)
      .regex(/^[A-Za-z0-9 _.-]+$/, 'Letters, digits, spaces, dot, dash and underscore only'),
    protocol: z.enum(PROTOCOLS),
    lanIpStart: optionalIpv4,
    lanIpEnd: optionalIpv4,
    wanIpStart: optionalIpv4,
    wanIpEnd: optionalIpv4,
    lanTcpPorts: ports,
    lanUdpPorts: ports,
    wanTcpPorts: ports,
    wanUdpPorts: ports,
  })
  .superRefine((rule, ctx) => {
    const issue = (path: string, message: string) =>
      ctx.addIssue({ code: 'custom', path: [path], message });
    if (!rule.lanIpStart && !rule.wanIpStart) {
      issue('lanIpStart', 'Give a LAN-side or WAN-side address');
    }
    for (const side of ['lan', 'wan'] as const) {
      const start = rule[`${side}IpStart`];
      const end = rule[`${side}IpEnd`];
      if (end && !start) issue(`${side}IpEnd`, 'An end address needs a start address');
      if (start && end && toInt(end) < toInt(start)) {
        issue(`${side}IpEnd`, 'The end address must not be lower than the start address');
      }
    }
    const tcp = rule.protocol === 'TCP' || rule.protocol === 'TCP/UDP';
    const udp = rule.protocol === 'UDP' || rule.protocol === 'TCP/UDP';
    for (const field of ['lanTcpPorts', 'wanTcpPorts'] as const) {
      if (!tcp && rule[field]) issue(field, `${rule.protocol} rules have no TCP ports`);
    }
    for (const field of ['lanUdpPorts', 'wanUdpPorts'] as const) {
      if (!udp && rule[field]) issue(field, `${rule.protocol} rules have no UDP ports`);
    }
  });

export const ipFilterSettingsSchema = z
  .object({ enabled: z.boolean().optional(), mode: z.enum(['blacklist']).optional() })
  .refine((body) => body.enabled !== undefined || body.mode !== undefined, 'Nothing to change');

export const ruleIndexSchema = z.object({ index: z.coerce.number().int().min(1).max(9999) });

export type IpFilterRuleInput = z.infer<typeof ipFilterRuleSchema>;
export type IpFilterSettingsInput = z.infer<typeof ipFilterSettingsSchema>;

export function ipToInt(ip: string): number {
  return toInt(ip);
}
