import { networkInterfaces } from 'node:os';

/**
 * IPv4 addresses of this machine. The API runs on the host network, so these are the server's own
 * LAN addresses: the only host nmap reports without a MAC.
 */
export function ownIpv4Addresses(): string[] {
  return Object.values(networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => i!.address);
}
