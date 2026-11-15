import { createHash } from 'node:crypto';
import { NotFoundError, ValidationError } from '../../common/errors/AppError';
import { ErrorCode } from '../../common/errors/errorCodes';
import { paginate, type Pagination } from '../../common/utils/pagination';
import { logger } from '../../config/logger';
import type { RequestContext } from '../auth/auth.types';
import type { AuditService } from '../audit/audit.service';
import {
  EPHEMERAL_PORT_START,
  MAX_STORED_REJECTED_LINES,
  type FirewallRepository,
} from './firewall.repository';
import type {
  FirewallEventQuery,
  FirewallEventRow,
  FirewallImportRow,
  TimeRange,
} from './firewall.types';
import { parseLog } from './huaweiLogParser';

export interface UploadedLogFile {
  originalName: string;
  buffer: Buffer;
}

const DEFAULT_ANALYSIS_DAYS = 7;
const REPEATED_DENIAL_THRESHOLD = 20;
const INSIGHT_LIMIT = 10;
// Source ports of services that answer LAN clients; denied packets *from* them to high ports
// are usually replies that arrived after the router dropped the connection state.
const COMMON_SERVICE_PORTS = new Set([53, 80, 123, 443, 853, 993, 5222, 5228]);

export class FirewallService {
  constructor(
    private firewallRepository: FirewallRepository,
    private auditService: AuditService,
    private routerTimeZone: string
  ) {}

  async importLog(file: UploadedLogFile, adminId: number, context: RequestContext) {
    // NUL bytes mean a binary file; the router exports plain text.
    if (file.buffer.includes(0)) throw new ValidationError(ErrorCode.FIREWALL_FILE_INVALID);
    const content = new TextDecoder('utf-8', { fatal: false }).decode(file.buffer);

    const parsed = parseLog(content, this.routerTimeZone);
    const saved = await this.firewallRepository.saveImport(
      {
        fileName: file.originalName.slice(0, 255),
        sizeBytes: file.buffer.length,
        sha256: createHash('sha256').update(file.buffer).digest('hex'),
      },
      parsed,
      adminId
    );

    await this.auditService.record({
      adminId,
      action: 'firewall.log_imported',
      entityType: 'firewall_log_import',
      entityId: saved.id,
      details: {
        fileName: saved.file_name,
        inserted: saved.inserted_events,
        duplicates: saved.duplicate_events,
        rejected: saved.rejected_lines,
      },
      ipAddress: context.ipAddress,
    });
    logger.info({ importId: saved.id, ...summaryCounts(saved) }, 'Firewall log imported');

    return {
      ...toImportDto(saved),
      rejectedSample: parsed.rejected.slice(0, 20),
      rejectedStoredLimit: MAX_STORED_REJECTED_LINES,
    };
  }

  async listImports(pagination: Pagination) {
    const { rows, total } = await this.firewallRepository.findImports(pagination);
    return paginate(
      rows.map((row) => ({ ...toImportDto(row), importedBy: row.imported_by_username })),
      total,
      pagination
    );
  }

  async getImport(importId: number) {
    const importRow = await this.firewallRepository.findImport(importId);
    if (!importRow) throw new NotFoundError(ErrorCode.FIREWALL_IMPORT_NOT_FOUND);
    const rejected = await this.firewallRepository.findRejectedLines(importId);
    return {
      ...toImportDto(importRow),
      rejected: rejected.map((line) => ({
        lineNumber: line.line_number,
        reason: line.reason,
        rawLine: line.raw_line,
      })),
      rejectedLinesTruncated: importRow.rejected_lines > rejected.length,
    };
  }

  async listEvents(query: FirewallEventQuery) {
    const { rows, total } = await this.firewallRepository.findEvents(query);
    return paginate(rows.map(toEventDto), total, query);
  }

  async getEvent(eventId: number) {
    const event = await this.firewallRepository.findEvent(eventId);
    if (!event) throw new NotFoundError(ErrorCode.FIREWALL_EVENT_NOT_FOUND);
    return { ...toEventDto(event), rawLine: event.raw_line, importId: event.import_id };
  }

  async getFacets() {
    const facets = await this.firewallRepository.findFacets();
    return { ...facets, ipVersions: facets.ipVersions.map(Number) };
  }

  /**
   * Defaults to the last seven days *of imported data*, not of wall-clock time: logs are uploaded
   * by hand, so the newest event may be days old and "now minus seven days" would show nothing.
   */
  private async resolveRange(from?: Date, to?: Date): Promise<TimeRange | null> {
    if (from && to) return { from, to };
    const bounds = await this.firewallRepository.findEventBounds();
    if (!bounds.last) return null;
    const end = to ?? bounds.last;
    return { from: from ?? new Date(end.getTime() - DEFAULT_ANALYSIS_DAYS * 86_400_000), to: end };
  }

  async getSummary(from?: Date, to?: Date) {
    const bounds = await this.firewallRepository.findEventBounds();
    const range = await this.resolveRange(from, to);
    if (!range) return { hasData: false as const, totalEvents: 0 };

    const [byAction, timeline] = await Promise.all([
      this.firewallRepository.countByAction(range),
      this.firewallRepository.hourlyCounts(range),
    ]);
    return {
      hasData: true as const,
      totalEvents: bounds.total,
      dataFrom: bounds.first,
      dataTo: bounds.last,
      range,
      denied: byAction.deny ?? 0,
      accepted: byAction.accept ?? 0,
      timeline,
    };
  }

  /**
   * Patterns in the data, worded as observations. A denied packet means the firewall did its job;
   * none of these is evidence that a source is malicious, and the response says so.
   */
  async getInsights(from?: Date, to?: Date) {
    const range = await this.resolveRange(from, to);
    if (!range) return { hasData: false as const, observations: [] };

    const [repeated, acceptedInbound, deniedPorts] = await Promise.all([
      this.firewallRepository.repeatedDeniedSources(
        range,
        REPEATED_DENIAL_THRESHOLD,
        INSIGHT_LIMIT
      ),
      this.firewallRepository.acceptedInbound(range, INSIGHT_LIMIT),
      this.firewallRepository.topDeniedInboundPorts(range, INSIGHT_LIMIT),
    ]);

    return {
      hasData: true as const,
      range,
      disclaimer:
        'These are patterns observed in the imported router log. A denied connection was blocked; ' +
        'none of these observations on its own shows that an address is malicious.',
      repeatedDeniedSources: repeated.map((row) => {
        const likelyLateReplies =
          COMMON_SERVICE_PORTS.has(row.common_source_port) &&
          row.to_ephemeral_ports >= row.events * 0.8;
        return {
          sourceIp: row.source_ip,
          events: row.events,
          distinctPorts: row.distinct_ports,
          distinctDestinations: row.distinct_destinations,
          commonSourcePort: row.common_source_port,
          directions: row.directions ?? [],
          firstSeen: row.first_seen,
          lastSeen: row.last_seen,
          interpretation: likelyLateReplies
            ? `Mostly from source port ${row.common_source_port} to high client ports: typical of late replies to connections opened from the LAN after the router expired their state.`
            : row.distinct_ports >= 10
              ? `Contacted ${row.distinct_ports} different destination ports; consistent with port probing, but not proof of it.`
              : 'Repeated denied attempts from the same source.',
        };
      }),
      acceptedInbound: acceptedInbound.map((row) => ({
        destinationIp: row.destination_ip,
        destinationPort: row.destination_port,
        protocol: row.protocol,
        events: row.events,
        distinctSources: row.distinct_sources,
        lastSeen: row.last_seen,
        interpretation:
          'Inbound traffic from the internet was accepted. Expected only if a forwarding rule or service is meant to be reachable.',
      })),
      topDeniedInboundPorts: deniedPorts.map((row) => ({
        destinationPort: row.destination_port,
        protocol: row.protocol,
        events: row.events,
        distinctSources: row.distinct_sources,
        ephemeral: row.destination_port >= EPHEMERAL_PORT_START,
      })),
    };
  }
}

function summaryCounts(row: FirewallImportRow) {
  return {
    totalLines: row.total_lines,
    parsedEvents: row.parsed_events,
    insertedEvents: row.inserted_events,
    duplicateEvents: row.duplicate_events,
    rejectedLines: row.rejected_lines,
    blankLines: row.blank_lines,
  };
}

function toImportDto(row: FirewallImportRow) {
  return {
    id: row.id,
    fileName: row.file_name,
    fileSizeBytes: row.file_size_bytes,
    fileSha256: row.file_sha256,
    ...summaryCounts(row),
    firstEventAt: row.first_event_at,
    lastEventAt: row.last_event_at,
    createdAt: row.created_at,
  };
}

function toEventDto(row: FirewallEventRow) {
  return {
    id: row.id,
    occurredAt: row.occurred_at,
    action: row.action,
    actionRaw: row.action_raw,
    direction: row.direction,
    directionRaw: row.direction_raw,
    inInterface: row.in_interface,
    outInterface: row.out_interface,
    sourceIp: row.source_ip,
    sourcePort: row.source_port,
    destinationIp: row.destination_ip,
    destinationPort: row.destination_port,
    protocol: row.protocol,
    ipVersion: row.ip_version,
    severity: row.severity,
  };
}
