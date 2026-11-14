import { XMLParser } from 'fast-xml-parser';

export interface DiscoveredHost {
  ipAddress: string;
  macAddress: string | null;
  vendor: string | null;
  hostname: string | null;
}

interface NmapAddress {
  addr?: string;
  addrtype?: string;
  vendor?: string;
}

interface NmapHost {
  status?: { state?: string };
  address?: NmapAddress[];
  hostnames?: { hostname?: { name?: string }[] } | string;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  isArray: (name) => ['host', 'address', 'hostname'].includes(name),
});

export class NmapOutputError extends Error {}

/** Parses `nmap -oX -` output into the hosts that were reported as up. */
export function parseNmapXml(xml: string): DiscoveredHost[] {
  let document: { nmaprun?: { host?: NmapHost[] } };
  try {
    document = parser.parse(xml);
  } catch (err) {
    throw new NmapOutputError(`Unreadable nmap XML: ${(err as Error).message}`);
  }
  if (!document.nmaprun) throw new NmapOutputError('nmap XML has no <nmaprun> root');

  return (document.nmaprun.host ?? []).flatMap((host) => {
    if (host.status?.state !== 'up') return [];
    const addresses = host.address ?? [];
    const ipv4 = addresses.find((address) => address.addrtype === 'ipv4');
    if (!ipv4?.addr) return [];
    const mac = addresses.find((address) => address.addrtype === 'mac');
    const hostnames = typeof host.hostnames === 'object' ? host.hostnames.hostname : undefined;
    return [
      {
        ipAddress: ipv4.addr,
        macAddress: mac?.addr?.toLowerCase() ?? null,
        vendor: mac?.vendor ?? null,
        hostname: hostnames?.[0]?.name ?? null,
      },
    ];
  });
}
