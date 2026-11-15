import { describe, expect, it } from 'vitest';
import { parseLine, parseLog, zonedTimeToUtc } from '../src/modules/firewall/huaweiLogParser';

const TZ = 'Europe/Belgrade';
// Shape of a real HN8546X6 export line; addresses replaced with documentation ranges.
const SAMPLE =
  '2026-11-14 21:31:28 [Notice] IN=Internet_DHCP OUT=LocalNetwork Direction=Public->Private Action=Deny SRC=203.0.113.7 DST=192.168.100.20 PROTO=TCP SPT=443 DPT=55090';

function expectEvent(line: string) {
  const result = parseLine(line, TZ);
  if (result.kind !== 'event') throw new Error(`Expected an event, got ${JSON.stringify(result)}`);
  return result.event;
}

function expectRejected(line: string) {
  const result = parseLine(line, TZ);
  if (result.kind !== 'rejected') throw new Error(`Expected rejection, got ${result.kind}`);
  return result.reason;
}

describe('parseLine', () => {
  it('parses every field of a Huawei firewall log line', () => {
    expect(expectEvent(SAMPLE)).toMatchObject({
      occurredAt: new Date('2026-11-14T20:31:28.000Z'),
      severity: 'Notice',
      inInterface: 'Internet_DHCP',
      outInterface: 'LocalNetwork',
      directionRaw: 'Public->Private',
      direction: 'internet_to_lan',
      action: 'deny',
      actionRaw: 'Deny',
      sourceIp: '203.0.113.7',
      destinationIp: '192.168.100.20',
      ipVersion: 4,
      protocol: 'TCP',
      sourcePort: 443,
      destinationPort: 55090,
    });
  });

  it('parses IPv6 UDP lines', () => {
    const event = expectEvent(
      '2026-11-14 21:40:02 [Notice] IN=Internet_DHCP OUT=LocalNetwork Direction=Public->Private Action=Deny SRC=2001:db8::1 DST=2001:db8:abcd::20 PROTO=UDP SPT=53 DPT=40000'
    );
    expect(event).toMatchObject({ ipVersion: 6, protocol: 'UDP', sourceIp: '2001:db8::1' });
  });

  it('does not depend on field order or key case', () => {
    const event = expectEvent(
      '2026-11-14 21:31:28 DPT=55090 proto=tcp SRC=203.0.113.7 action=Accept DST=192.168.100.20 Direction=Private->Public'
    );
    expect(event).toMatchObject({
      action: 'accept',
      protocol: 'TCP',
      direction: 'lan_to_internet',
      destinationPort: 55090,
      sourcePort: null,
      severity: null,
      inInterface: null,
    });
  });

  it('accepts ICMP lines without ports', () => {
    const event = expectEvent(
      '2026-11-14 21:31:28 [Notice] Direction=Public->Local Action=Deny SRC=198.51.100.9 DST=100.108.87.6 PROTO=ICMP'
    );
    expect(event).toMatchObject({
      protocol: 'ICMP',
      direction: 'internet_to_router',
      sourcePort: null,
      destinationPort: null,
    });
  });

  it('keeps an unknown direction as raw text instead of guessing', () => {
    const event = expectEvent(SAMPLE.replace('Public->Private', 'Wan->Something'));
    expect(event.direction).toBeNull();
    expect(event.directionRaw).toBe('Wan->Something');
  });

  it.each([
    ['', 'blank'],
    ['   \t ', 'blank'],
  ])('treats %j as a blank line', (line, kind) => {
    expect(parseLine(line, TZ).kind).toBe(kind);
  });

  it.each([
    ['Firewall log file', 'timestamp'],
    [SAMPLE.replace('2026-11-14', '2026-02-30'), 'valid date'],
    [SAMPLE.replace('21:31:28', '25:31:28'), 'valid date'],
    [SAMPLE.replace(' SRC=203.0.113.7', ''), 'Missing SRC'],
    [SAMPLE.replace(' Action=Deny', ''), 'Missing ACTION'],
    [SAMPLE.replace(' PROTO=TCP', ''), 'Missing PROTO'],
    [SAMPLE.replace('Action=Deny', 'Action=Maybe'), 'Unknown action'],
    [SAMPLE.replace('SRC=203.0.113.7', 'SRC=999.1.1.1'), 'SRC is not'],
    [SAMPLE.replace('DST=192.168.100.20', 'DST=<script>'), 'DST is not'],
    [SAMPLE.replace('DST=192.168.100.20', 'DST=2001:db8::1'), 'different IP versions'],
    [SAMPLE.replace('DPT=55090', 'DPT=70000'), 'DPT is not'],
    [SAMPLE.replace('SPT=443', 'SPT=-1'), 'SPT is not'],
    [SAMPLE.replace('PROTO=TCP', 'PROTO=TCP;DROP'), 'Invalid PROTO'],
    [`${SAMPLE} SRC=198.51.100.1`, 'more than once'],
  ])('rejects %j with a reason', (line, reason) => {
    expect(expectRejected(line)).toContain(reason);
  });
});

describe('zonedTimeToUtc', () => {
  it('applies summer and winter offsets of the router time zone', () => {
    expect(zonedTimeToUtc([2026, 7, 1, 12, 0, 0], TZ)).toEqual(new Date('2026-07-01T10:00:00Z'));
    expect(zonedTimeToUtc([2026, 1, 1, 12, 0, 0], TZ)).toEqual(new Date('2026-01-01T11:00:00Z'));
  });
});

describe('parseLog', () => {
  it('counts events, rejected and blank lines, keeping line numbers of rejected lines', () => {
    const content = [
      'Header line',
      SAMPLE,
      '',
      'garbage',
      SAMPLE.replace('DPT=55090', 'DPT=1'),
    ].join('\r\n');

    const result = parseLog(content, TZ);

    expect(result.totalLines).toBe(5);
    expect(result.blankLines).toBe(1);
    expect(result.events).toHaveLength(2);
    expect(result.rejected).toEqual([
      { lineNumber: 1, reason: 'Line does not start with a timestamp', rawLine: 'Header line' },
      { lineNumber: 4, reason: 'Line does not start with a timestamp', rawLine: 'garbage' },
    ]);
  });

  it('numbers identical lines so genuine repeats survive deduplication', () => {
    const result = parseLog([SAMPLE, SAMPLE, `${SAMPLE}  `].join('\n'), TZ);

    expect(result.events.map((event) => event.occurrence)).toEqual([1, 2, 3]);
    expect(new Set(result.events.map((event) => event.dedupeHash)).size).toBe(1);
  });

  it('handles an empty file and a UTF-8 BOM', () => {
    expect(parseLog('', TZ)).toEqual({ events: [], rejected: [], totalLines: 0, blankLines: 0 });
    const withByteOrderMark = String.fromCharCode(0xfeff) + SAMPLE;
    expect(parseLog(withByteOrderMark, TZ).events).toHaveLength(1);
  });

  it('parses a large file in reasonable time', () => {
    const lines = Array.from({ length: 100_000 }, (_, i) =>
      SAMPLE.replace('DPT=55090', `DPT=${i % 65535}`)
    );

    const startedAt = Date.now();
    const result = parseLog(lines.join('\n'), TZ);

    expect(result.events).toHaveLength(100_000);
    expect(Date.now() - startedAt).toBeLessThan(10_000);
  });
});
