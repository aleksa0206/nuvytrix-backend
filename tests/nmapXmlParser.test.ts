import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { NmapOutputError, parseNmapXml } from '../src/modules/devices/nmapXmlParser';

const fixture = readFileSync(path.join(__dirname, 'fixtures/nmap-ping-scan.xml'), 'utf8');

describe('parseNmapXml', () => {
  it('returns only hosts that are up, with MAC and vendor when nmap reported them', () => {
    expect(parseNmapXml(fixture)).toEqual([
      {
        ipAddress: '192.168.100.1',
        macAddress: 'aa:bb:cc:00:00:01',
        vendor: 'Huawei Technologies',
        hostname: null,
      },
      {
        ipAddress: '192.168.100.20',
        macAddress: 'aa:bb:cc:00:00:20',
        vendor: null,
        hostname: 'desktop-pc.home',
      },
      // The scanning host itself: nmap never reports its own MAC.
      { ipAddress: '192.168.100.10', macAddress: null, vendor: null, hostname: null },
    ]);
  });

  it('returns an empty list when no host answered', () => {
    expect(parseNmapXml('<?xml version="1.0"?><nmaprun><runstats/></nmaprun>')).toEqual([]);
  });

  it('rejects output that is not an nmap report', () => {
    expect(() => parseNmapXml('Starting Nmap... failed')).toThrow(NmapOutputError);
  });
});
