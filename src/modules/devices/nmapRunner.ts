import { execFile } from 'node:child_process';
import { parseNmapXml, type DiscoveredHost } from './nmapXmlParser';

export interface HostDiscoverer {
  discover(target: string): Promise<DiscoveredHost[]>;
}

/**
 * Fills in the host name a device gave the DHCP server (MAC → name) where nmap found none: with
 * AdGuard handing out addresses, the router no longer learns names for its reverse lookups.
 */
export function withDhcpNames(
  discoverer: HostDiscoverer,
  names: () => Promise<Map<string, string>>
): HostDiscoverer {
  return {
    async discover(target) {
      const [hosts, byMac] = await Promise.all([discoverer.discover(target), names()]);
      return hosts.map((h) =>
        h.hostname || !h.macAddress
          ? h
          : { ...h, hostname: byMac.get(h.macAddress.toLowerCase()) ?? null }
      );
    },
  };
}

export interface NmapOptions {
  nmapPath: string;
  timeoutSeconds: number;
  privileged: boolean;
}

export class NmapRunner implements HostDiscoverer {
  constructor(private options: NmapOptions) {}

  /**
   * Ping scan only (-sn): no port scanning. Arguments are a fixed list passed to execFile, never
   * a shell string, and the target has already been checked against the allowed networks.
   */
  discover(target: string): Promise<DiscoveredHost[]> {
    const args = ['-sn', '-T3', '--host-timeout', '30s', '-oX', '-'];
    // With CAP_NET_RAW granted to the binary, this lets nmap use ARP (and so learn MACs) as non-root.
    if (this.options.privileged) args.unshift('--privileged');
    args.push(target);

    return new Promise((resolve, reject) => {
      execFile(
        this.options.nmapPath,
        args,
        {
          timeout: this.options.timeoutSeconds * 1000,
          killSignal: 'SIGKILL',
          maxBuffer: 20 * 1024 * 1024,
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          if (error) {
            const reason = error.killed ? 'nmap timed out' : stderr.trim() || error.message;
            reject(new Error(reason.slice(0, 900)));
            return;
          }
          try {
            resolve(parseNmapXml(stdout));
          } catch (parseError) {
            reject(parseError);
          }
        }
      );
    });
  }
}
