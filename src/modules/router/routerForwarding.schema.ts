import { z } from 'zod';

const port = z.number().int().min(1).max(65535);
const protocol = z.enum(['TCP', 'UDP', 'TCP/UDP']);
/** The router allows at most 256 trigger ports and 256 open ports in total. */
export const MAX_TRIGGER_PORTS = 256;

export const dmzSchema = z.object({
  enabled: z.boolean(),
  host: z.ipv4({ message: 'Must be an IPv4 address' }),
});

export const portTriggerSchema = z
  .object({
    enabled: z.boolean(),
    triggerProtocol: protocol,
    triggerPortStart: port,
    triggerPortEnd: port,
    openProtocol: protocol,
    openPortStart: port,
    openPortEnd: port,
  })
  .superRefine((t, ctx) => {
    const issue = (path: string, message: string) =>
      ctx.addIssue({ code: 'custom', path: [path], message });
    for (const side of ['trigger', 'open'] as const) {
      const start = t[`${side}PortStart`];
      const end = t[`${side}PortEnd`];
      if (end < start) issue(`${side}PortEnd`, 'The last port must not be lower than the first');
      else if (end - start + 1 > MAX_TRIGGER_PORTS) {
        issue(`${side}PortEnd`, `At most ${MAX_TRIGGER_PORTS} ports`);
      }
    }
    // The router's own form refuses these: FTP (21) and TFTP (69) use their own helpers.
    for (const reserved of [21, 69]) {
      if (t.triggerPortStart <= reserved && t.triggerPortEnd >= reserved) {
        issue('triggerPortStart', `The trigger range must not include port ${reserved}`);
      }
    }
  });

export const triggerIndexSchema = z.object({ index: z.coerce.number().int().min(1).max(9999) });

export type DmzInput = z.infer<typeof dmzSchema>;
export type PortTriggerInput = z.infer<typeof portTriggerSchema>;
