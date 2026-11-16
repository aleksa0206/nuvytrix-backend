import { AppError } from '../../common/errors/AppError';
import { ErrorCode } from '../../common/errors/errorCodes';
import { parseConstructorCalls } from './huaweiParser';
import type { RouterWriter } from './routerWriter';

export interface Ipv6LanState {
  /** The LAN prefix and where it comes from (`WANDelegated` from the provider, `Static`, …). */
  prefix: {
    prefix: string;
    mode: string;
    preferredSeconds: number | null;
    validSeconds: number | null;
  } | null;
  /** Router advertisements: on/off, and the flags telling devices how to get addresses and DNS. */
  routerAdvertisement: {
    enabled: boolean;
    /** M flag: addresses from DHCPv6 instead of SLAAC. */
    managed: boolean;
    /** O flag: other settings (DNS) from DHCPv6. */
    otherConfig: boolean;
    mtu: number | null;
  } | null;
  dhcpv6Server: { enabled: boolean } | null;
  /** `HGWProxy` (the router answers), `WANConnection` (provider's servers) or `Static`. */
  dns: { mode: string; servers: string[] } | null;
}

const num = (v: string | undefined) => (v && /^\d+$/.test(v) ? Number(v) : null);

/**
 * IPv6 on the LAN (LAN → LAN Host IPv6 / DHCPv6 Server), read-only. The router's page saves every IPv6
 * LAN object in one form; a mistake there cuts IPv6 for every device, and none of the settings needs
 * changing for normal use, so Nuvytrix only shows them. Format: docs/huawei/ipv6.md.
 */
export class RouterIpv6Service {
  constructor(private writer: RouterWriter) {}

  async getState(): Promise<Ipv6LanState> {
    const { ipv6Lan } = await this.writer.read(['ipv6Lan'] as const);
    return parseIpv6Lan(ipv6Lan);
  }
}

export function parseIpv6Lan(page: string): Ipv6LanState {
  const first = (name: string) => parseConstructorCalls(page, name)[0];
  const prefix = first('Br0IPv6PrefixClass');
  const ra = first('RaConfigInfoClass');
  const dhcp = first('DhcpV6Server');
  const dns = first('IPv6DNSConfigClass');
  if (!prefix && !ra && !dhcp && !dns) {
    throw new AppError(ErrorCode.ROUTER_UNAVAILABLE, 502, 'IPv6 LAN settings not found');
  }
  return {
    prefix: prefix
      ? {
          prefix: prefix[5] ?? '',
          mode: prefix[4] ?? '',
          preferredSeconds: num(prefix[6]),
          validSeconds: num(prefix[7]),
        }
      : null,
    routerAdvertisement: ra
      ? {
          enabled: ra[4] === '1',
          managed: ra[1] === '1',
          otherConfig: ra[2] === '1',
          mtu: num(ra[5]),
        }
      : null,
    dhcpv6Server: dhcp ? { enabled: dhcp[1] === '1' } : null,
    dns: dns
      ? {
          mode: dns[2] ?? '',
          servers: (dns[4] ?? '')
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
        }
      : null,
  };
}
