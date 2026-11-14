import { describe, expect, it } from 'vitest';
import { isTargetAllowed, parseCidr } from '../src/common/utils/ipv4';

describe('scan target restriction', () => {
  const allowed = ['192.168.100.0/24'];

  it.each([
    ['192.168.100.0/24', true],
    ['192.168.100.17', true],
    ['192.168.100.128/25', true],
    ['192.168.0.0/16', false],
    ['192.168.101.5', false],
    ['10.0.0.1', false],
    ['8.8.8.8', false],
    ['192.168.100.5; rm -rf /', false],
    ['-oN /tmp/x', false],
    ['scanme.nmap.org', false],
    ['192.168.100.0/33', false],
    ['', false],
  ])('%s -> %s', (target, expected) => {
    expect(isTargetAllowed(target, allowed)).toBe(expected);
  });

  it('normalizes host bits away when parsing a CIDR', () => {
    expect(parseCidr('192.168.100.77/24')).toEqual({
      network: parseCidr('192.168.100.0/24')!.network,
      prefix: 24,
    });
  });
});
