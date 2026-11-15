import 'dotenv/config';
import { z } from 'zod';
import { parseCidr } from '../common/utils/ipv4';

const MIN_SCAN_PREFIX = 22;

const scanCidrs = z
  .string()
  .min(1)
  .transform((value, ctx) => {
    const cidrs = value.split(',').map((part) => part.trim());
    for (const cidr of cidrs) {
      const parsed = parseCidr(cidr);
      if (!parsed || parsed.prefix < MIN_SCAN_PREFIX) {
        ctx.addIssue({ code: 'custom', message: `${cidr} is not an IPv4 CIDR of /22 or smaller` });
        return z.NEVER;
      }
    }
    return cidrs;
  });

function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

const booleanString = z.enum(['true', 'false']).transform((value) => value === 'true');

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  HOST: z.string().min(1).default('127.0.0.1'),

  DB_HOST: z.string().min(1),
  DB_PORT: z.coerce.number().int().positive().default(5432),
  DB_USER: z.string().min(1),
  DB_PASSWORD: z.string().min(1),
  DB_NAME: z.string().min(1),

  FRONTEND_URL: z.string().url().default('http://localhost:4200'),
  // With 0, X-Forwarded-For is ignored, so clients cannot spoof the IP rate limits are keyed on.
  // Either a hop count or a comma-separated list of trusted proxy addresses/subnets (Express syntax).
  TRUST_PROXY: z
    .string()
    .default('0')
    .transform((value) => (/^\d+$/.test(value) ? Number(value) : value)),
  COOKIE_SECURE: booleanString.default(false),
  SESSION_IDLE_MINUTES: z.coerce.number().int().positive().default(30),
  SESSION_MAX_AGE_HOURS: z.coerce.number().int().positive().default(12),

  ALLOWED_SCAN_CIDRS: scanCidrs,
  NMAP_PATH: z.string().min(1).default('nmap'),
  // true when nmap runs as non-root with CAP_NET_RAW (the Docker image); needed for ARP and MACs.
  NMAP_PRIVILEGED: booleanString.default(false),
  SCAN_TIMEOUT_SECONDS: z.coerce.number().int().positive().max(1800).default(180),
  DISCOVERY_INTERVAL_MINUTES: z.coerce.number().int().min(0).default(0),
  DEVICE_ONLINE_WINDOW_MINUTES: z.coerce.number().int().positive().default(30),

  ROUTER_TIMEZONE: z
    .string()
    .min(1)
    .default('Europe/Belgrade')
    .refine(isValidTimeZone, 'must be an IANA time zone such as Europe/Belgrade'),
  ROUTER_HOST: z.string().default(''),
  FIREWALL_UPLOAD_MAX_MB: z.coerce.number().positive().max(200).default(20),

  PING_PATH: z.string().min(1).default('ping'),
  MONITORING_INTERVAL_SECONDS: z.coerce.number().int().min(10).default(60),
  MONITORING_RETENTION_DAYS: z.coerce.number().int().positive().default(90),

  ADGUARD_URL: z.union([z.literal(''), z.string().url()]).default(''),
  ADGUARD_USERNAME: z.string().default(''),
  ADGUARD_PASSWORD: z.string().default(''),
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  // Messages name the variable and the rule only, never the value.
  throw new Error(`Invalid environment configuration:\n${z.prettifyError(parsed.error)}`);
}

export const env = parsed.data;
export type Env = typeof env;
