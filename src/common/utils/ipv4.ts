import { isIPv4 } from 'node:net';

export interface Cidr {
  network: number;
  prefix: number;
}

export function ipv4ToNumber(ip: string): number | null {
  if (!isIPv4(ip)) return null;
  return ip.split('.').reduce((acc, octet) => acc * 256 + Number(octet), 0);
}

function maskFor(prefix: number): number {
  return prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
}

export function parseCidr(cidr: string): Cidr | null {
  const [ip, prefixText] = cidr.split('/');
  if (ip === undefined || prefixText === undefined || !/^\d{1,2}$/.test(prefixText)) return null;
  const prefix = Number(prefixText);
  const address = ipv4ToNumber(ip);
  if (address === null || prefix > 32) return null;
  return { network: (address & maskFor(prefix)) >>> 0, prefix };
}

export function isIpInCidr(ip: string, cidr: Cidr): boolean {
  const address = ipv4ToNumber(ip);
  if (address === null) return false;
  return (address & maskFor(cidr.prefix)) >>> 0 === cidr.network;
}

/** True when `target` (an IP or CIDR) lies completely inside one of the allowed CIDRs. */
export function isTargetAllowed(target: string, allowedCidrs: string[]): boolean {
  const targetCidr = parseCidr(target.includes('/') ? target : `${target}/32`);
  if (!targetCidr) return false;
  return allowedCidrs.some((allowed) => {
    const allowedCidr = parseCidr(allowed);
    return (
      allowedCidr !== null &&
      targetCidr.prefix >= allowedCidr.prefix &&
      (targetCidr.network & maskFor(allowedCidr.prefix)) >>> 0 === allowedCidr.network
    );
  });
}
