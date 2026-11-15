import { createHash } from 'node:crypto';
import { isIP } from 'node:net';

export type FirewallAction = 'accept' | 'deny';
export type FirewallDirection =
  'internet_to_lan' | 'internet_to_router' | 'lan_to_internet' | 'lan_to_router';

export interface ParsedFirewallEvent {
  occurredAt: Date;
  severity: string | null;
  inInterface: string | null;
  outInterface: string | null;
  directionRaw: string | null;
  direction: FirewallDirection | null;
  actionRaw: string;
  action: FirewallAction;
  sourceIp: string;
  destinationIp: string;
  ipVersion: 4 | 6;
  protocol: string;
  sourcePort: number | null;
  destinationPort: number | null;
  rawLine: string;
  dedupeHash: string;
}

export type LineResult =
  | { kind: 'event'; event: ParsedFirewallEvent }
  | { kind: 'rejected'; reason: string }
  | { kind: 'blank' };

// "2026-11-14 21:31:28 [Notice] KEY=value KEY=value ..."; the severity tag is optional.
const LINE_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})\s+(?:\[([A-Za-z]+)\]\s+)?(.*)$/;
const FIELD_PATTERN = /^([A-Za-z]+)=(.*)$/;
const PROTOCOL_PATTERN = /^[A-Za-z0-9-]{1,16}$/;
const INTERFACE_PATTERN = /^[\w.:-]{1,64}$/;

const ACTIONS: Record<string, FirewallAction> = {
  accept: 'accept',
  allow: 'accept',
  permit: 'accept',
  deny: 'deny',
  drop: 'deny',
  reject: 'deny',
  discard: 'deny',
};

const DIRECTIONS: Record<string, FirewallDirection> = {
  'public->private': 'internet_to_lan',
  'public->local': 'internet_to_router',
  'private->public': 'lan_to_internet',
  'private->local': 'lan_to_router',
};

export function normalizeLine(line: string): string {
  return line.trim().replace(/\s+/g, ' ');
}

export function hashLine(normalizedLine: string): string {
  return createHash('sha256').update(normalizedLine).digest('hex');
}

const formatters = new Map<string, Intl.DateTimeFormat>();

// Building a formatter is far more expensive than using one; large logs need thousands of lookups.
function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

/**
 * The router writes local wall-clock time without an offset. This finds the UTC instant that
 * shows that wall-clock time in `timeZone`, re-checking the offset once so DST changes resolve.
 */
export function zonedTimeToUtc(parts: number[], timeZone: string): Date | null {
  const [year, month, day, hour, minute, second] = parts as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const wallClockAsUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  const check = new Date(wallClockAsUtc);
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    return null;
  }

  const formatter = formatterFor(timeZone);
  const offsetAt = (instant: number) => {
    const formatted = formatter.formatToParts(new Date(instant));
    const value = (type: string) => Number(formatted.find((part) => part.type === type)?.value);
    const shown = Date.UTC(
      value('year'),
      value('month') - 1,
      value('day'),
      value('hour'),
      value('minute'),
      value('second')
    );
    return shown - instant;
  };

  let instant = wallClockAsUtc - offsetAt(wallClockAsUtc);
  instant = wallClockAsUtc - offsetAt(instant);
  return new Date(instant);
}

function parsePort(value: string | undefined): number | null | 'invalid' {
  if (value === undefined) return null;
  if (!/^\d{1,5}$/.test(value)) return 'invalid';
  const port = Number(value);
  return port <= 65535 ? port : 'invalid';
}

export function parseLine(line: string, timeZone: string): LineResult {
  const normalized = normalizeLine(line);
  if (normalized === '') return { kind: 'blank' };

  const match = LINE_PATTERN.exec(normalized);
  if (!match) return { kind: 'rejected', reason: 'Line does not start with a timestamp' };

  const occurredAt = zonedTimeToUtc(match.slice(1, 7).map(Number), timeZone);
  if (!occurredAt) return { kind: 'rejected', reason: 'Timestamp is not a valid date and time' };

  const fields = new Map<string, string>();
  for (const token of (match[8] ?? '').split(' ')) {
    const field = FIELD_PATTERN.exec(token);
    // Tokens without KEY= (free text some firmwares append) are kept in the raw line only.
    if (!field) continue;
    const key = field[1]!.toUpperCase();
    if (fields.has(key)) return { kind: 'rejected', reason: `Field ${key} appears more than once` };
    fields.set(key, field[2]!);
  }

  for (const required of ['ACTION', 'SRC', 'DST', 'PROTO']) {
    if (!fields.get(required)) return { kind: 'rejected', reason: `Missing ${required} field` };
  }

  const actionRaw = fields.get('ACTION')!;
  const action = ACTIONS[actionRaw.toLowerCase()];
  if (!action) return { kind: 'rejected', reason: `Unknown action "${actionRaw.slice(0, 32)}"` };

  const sourceIp = fields.get('SRC')!;
  const destinationIp = fields.get('DST')!;
  const sourceVersion = isIP(sourceIp);
  const destinationVersion = isIP(destinationIp);
  if (sourceVersion === 0) return { kind: 'rejected', reason: 'SRC is not an IP address' };
  if (destinationVersion === 0) return { kind: 'rejected', reason: 'DST is not an IP address' };
  if (sourceVersion !== destinationVersion) {
    return { kind: 'rejected', reason: 'SRC and DST use different IP versions' };
  }

  const protocol = fields.get('PROTO')!.toUpperCase();
  if (!PROTOCOL_PATTERN.test(protocol)) return { kind: 'rejected', reason: 'Invalid PROTO value' };

  const sourcePort = parsePort(fields.get('SPT'));
  const destinationPort = parsePort(fields.get('DPT'));
  if (sourcePort === 'invalid') return { kind: 'rejected', reason: 'SPT is not a valid port' };
  if (destinationPort === 'invalid') return { kind: 'rejected', reason: 'DPT is not a valid port' };

  const inInterface = fields.get('IN') || null;
  const outInterface = fields.get('OUT') || null;
  for (const name of [inInterface, outInterface]) {
    if (name !== null && !INTERFACE_PATTERN.test(name)) {
      return { kind: 'rejected', reason: 'Invalid interface name' };
    }
  }

  const directionRaw = fields.get('DIRECTION') || null;

  return {
    kind: 'event',
    event: {
      occurredAt,
      severity: match[7] ?? null,
      inInterface,
      outInterface,
      directionRaw: directionRaw?.slice(0, 32) ?? null,
      direction: directionRaw ? (DIRECTIONS[directionRaw.toLowerCase()] ?? null) : null,
      actionRaw: actionRaw.slice(0, 16),
      action,
      sourceIp,
      destinationIp,
      ipVersion: sourceVersion as 4 | 6,
      protocol,
      sourcePort,
      destinationPort,
      rawLine: normalized,
      dedupeHash: hashLine(normalized),
    },
  };
}

export interface ParsedLog {
  events: (ParsedFirewallEvent & { occurrence: number })[];
  rejected: { lineNumber: number; reason: string; rawLine: string }[];
  totalLines: number;
  blankLines: number;
}

/**
 * Two identical lines in one file are two real events (the log has one-second resolution), so each
 * repeat gets an occurrence index. Re-importing the same or an overlapping file then produces the
 * same (hash, occurrence) pairs and is deduplicated, while genuine repeats are kept.
 */
const BYTE_ORDER_MARK = 0xfeff;

export function parseLog(content: string, timeZone: string): ParsedLog {
  const lines = (content.charCodeAt(0) === BYTE_ORDER_MARK ? content.slice(1) : content).split(
    /\r?\n/
  );
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

  const occurrences = new Map<string, number>();
  const result: ParsedLog = { events: [], rejected: [], totalLines: lines.length, blankLines: 0 };

  lines.forEach((line, index) => {
    const parsed = parseLine(line, timeZone);
    if (parsed.kind === 'blank') {
      result.blankLines++;
    } else if (parsed.kind === 'rejected') {
      result.rejected.push({ lineNumber: index + 1, reason: parsed.reason, rawLine: line });
    } else {
      const occurrence = (occurrences.get(parsed.event.dedupeHash) ?? 0) + 1;
      occurrences.set(parsed.event.dedupeHash, occurrence);
      result.events.push({ ...parsed.event, occurrence });
    }
  });

  return result;
}
