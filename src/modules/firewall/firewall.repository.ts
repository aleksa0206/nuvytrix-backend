import type { Knex } from 'knex';
import { offsetOf, type Pagination } from '../../common/utils/pagination';
import type { ParsedLog } from './huaweiLogParser';
import type {
  FirewallEventQuery,
  FirewallEventRow,
  FirewallImportRow,
  TimeRange,
} from './firewall.types';

const INSERT_CHUNK_SIZE = 1000;
// Storing every line of a garbage upload would bloat the database; the count stays exact.
export const MAX_STORED_REJECTED_LINES = 1000;
// Start of the range operating systems pick client-side ports from (IANA / Linux defaults overlap here).
export const EPHEMERAL_PORT_START = 32768;
const INBOUND_DIRECTIONS = ['internet_to_lan', 'internet_to_router'];

export interface ImportFile {
  fileName: string;
  sizeBytes: number;
  sha256: string;
}

export class FirewallRepository {
  constructor(private db: Knex) {}

  /** Stores one upload atomically: either all of its events and its import record, or nothing. */
  async saveImport(
    file: ImportFile,
    parsed: ParsedLog,
    importedBy: number
  ): Promise<FirewallImportRow> {
    return this.db.transaction(async (trx) => {
      let first: number | null = null;
      let last: number | null = null;
      for (const event of parsed.events) {
        const time = event.occurredAt.getTime();
        if (first === null || time < first) first = time;
        if (last === null || time > last) last = time;
      }
      const [created] = await trx('firewall_log_imports')
        .insert({
          file_name: file.fileName,
          file_size_bytes: file.sizeBytes,
          file_sha256: file.sha256,
          total_lines: parsed.totalLines,
          parsed_events: parsed.events.length,
          inserted_events: 0,
          duplicate_events: 0,
          rejected_lines: parsed.rejected.length,
          blank_lines: parsed.blankLines,
          first_event_at: first === null ? null : new Date(first),
          last_event_at: last === null ? null : new Date(last),
          imported_by: importedBy,
        })
        .returning('*');
      const importRow = created as FirewallImportRow;

      let inserted = 0;
      for (let start = 0; start < parsed.events.length; start += INSERT_CHUNK_SIZE) {
        const rows = parsed.events.slice(start, start + INSERT_CHUNK_SIZE).map((event) => ({
          import_id: importRow.id,
          occurred_at: event.occurredAt,
          severity: event.severity,
          in_interface: event.inInterface,
          out_interface: event.outInterface,
          direction_raw: event.directionRaw,
          direction: event.direction,
          action_raw: event.actionRaw,
          action: event.action,
          source_ip: event.sourceIp,
          destination_ip: event.destinationIp,
          ip_version: event.ipVersion,
          protocol: event.protocol,
          source_port: event.sourcePort,
          destination_port: event.destinationPort,
          raw_line: event.rawLine,
          dedupe_hash: event.dedupeHash,
          occurrence: event.occurrence,
        }));
        const insertedRows = await trx('firewall_events')
          .insert(rows)
          .onConflict(['dedupe_hash', 'occurrence'])
          .ignore()
          .returning('id');
        inserted += insertedRows.length;
      }

      const rejectedToStore = parsed.rejected.slice(0, MAX_STORED_REJECTED_LINES);
      for (let start = 0; start < rejectedToStore.length; start += INSERT_CHUNK_SIZE) {
        await trx('firewall_rejected_lines').insert(
          rejectedToStore.slice(start, start + INSERT_CHUNK_SIZE).map((line) => ({
            import_id: importRow.id,
            line_number: line.lineNumber,
            reason: line.reason.slice(0, 200),
            raw_line: line.rawLine.slice(0, 2000),
          }))
        );
      }

      const [updated] = await trx('firewall_log_imports')
        .where({ id: importRow.id })
        .update({ inserted_events: inserted, duplicate_events: parsed.events.length - inserted })
        .returning('*');
      return updated as FirewallImportRow;
    });
  }

  async findImports(pagination: Pagination) {
    const [rows, countRow] = await Promise.all([
      this.db('firewall_log_imports as i')
        .leftJoin('admins as a', 'a.id', 'i.imported_by')
        .select('i.*', 'a.username as imported_by_username')
        .orderBy('i.id', 'desc')
        .limit(pagination.pageSize)
        .offset(offsetOf(pagination)),
      this.db('firewall_log_imports').count<{ count: number }[]>('* as count').first(),
    ]);
    return {
      rows: rows as (FirewallImportRow & { imported_by_username: string | null })[],
      total: countRow?.count ?? 0,
    };
  }

  findImport(importId: number): Promise<FirewallImportRow | undefined> {
    return this.db<FirewallImportRow>('firewall_log_imports').where({ id: importId }).first();
  }

  findRejectedLines(importId: number) {
    return this.db('firewall_rejected_lines')
      .where('import_id', importId)
      .orderBy('line_number')
      .select('line_number', 'reason', 'raw_line');
  }

  private filteredEvents(query: Omit<FirewallEventQuery, 'page' | 'pageSize' | 'sort' | 'order'>) {
    return this.db('firewall_events').modify((builder) => {
      if (query.action) builder.where('action', query.action);
      if (query.direction) builder.where('direction', query.direction);
      if (query.flow === 'inbound') builder.whereIn('direction', INBOUND_DIRECTIONS);
      if (query.flow === 'outbound') builder.where('direction', 'lan_to_internet');
      if (query.protocol) builder.where('protocol', query.protocol);
      if (query.ipVersion) builder.where('ip_version', query.ipVersion);
      if (query.ip) {
        builder.where((where) =>
          where.where('source_ip', query.ip!).orWhere('destination_ip', query.ip!)
        );
      }
      if (query.port !== undefined) {
        builder.where((where) =>
          where.where('source_port', query.port!).orWhere('destination_port', query.port!)
        );
      }
      if (query.from) builder.where('occurred_at', '>=', query.from);
      if (query.to) builder.where('occurred_at', '<=', query.to);
      if (query.importId) builder.where('import_id', query.importId);
    });
  }

  async findEvents(query: FirewallEventQuery) {
    const filtered = this.filteredEvents(query);
    const [rows, countRow] = await Promise.all([
      filtered
        .clone()
        .select('*')
        .orderBy(query.sort, query.order)
        .orderBy('id', query.order)
        .limit(query.pageSize)
        .offset(offsetOf(query)),
      filtered.clone().count<{ count: number }[]>('* as count').first(),
    ]);
    return { rows: rows as FirewallEventRow[], total: countRow?.count ?? 0 };
  }

  findEvent(eventId: number): Promise<FirewallEventRow | undefined> {
    return this.db<FirewallEventRow>('firewall_events').where({ id: eventId }).first();
  }

  async findFacets() {
    const distinct = (column: string) =>
      this.db('firewall_events')
        .distinct(column)
        .whereNotNull(column)
        .orderBy(column)
        .pluck(column);
    const [actions, directions, protocols, ipVersions] = await Promise.all([
      distinct('action'),
      distinct('direction'),
      distinct('protocol'),
      distinct('ip_version'),
    ]);
    return { actions, directions, protocols, ipVersions };
  }

  async findEventBounds(): Promise<{ first: Date | null; last: Date | null; total: number }> {
    const row = await this.db('firewall_events')
      .select(
        this.db.raw('MIN(occurred_at) AS first'),
        this.db.raw('MAX(occurred_at) AS last'),
        this.db.raw('COUNT(*)::int AS total')
      )
      .first();
    return { first: row?.first ?? null, last: row?.last ?? null, total: row?.total ?? 0 };
  }

  async countByAction(range: TimeRange) {
    const rows = await this.db('firewall_events')
      .whereBetween('occurred_at', [range.from, range.to])
      .select('action')
      .count<{ action: string; count: number }[]>('* as count')
      .groupBy('action');
    return Object.fromEntries(rows.map((row) => [row.action, row.count])) as Record<string, number>;
  }

  /** Event counts per hour, for the timeline. */
  hourlyCounts(range: TimeRange) {
    return this.db('firewall_events')
      .whereBetween('occurred_at', [range.from, range.to])
      .select(
        this.db.raw(`date_trunc('hour', occurred_at) AS bucket`),
        this.db.raw(`COUNT(*) FILTER (WHERE action = 'deny')::int AS denied`),
        this.db.raw(`COUNT(*) FILTER (WHERE action = 'accept')::int AS accepted`)
      )
      .groupByRaw('1')
      .orderBy('bucket') as unknown as Promise<
      { bucket: Date; denied: number; accepted: number }[]
    >;
  }

  repeatedDeniedSources(range: TimeRange, minimumCount: number, limit: number) {
    return this.db('firewall_events')
      .where('action', 'deny')
      .whereBetween('occurred_at', [range.from, range.to])
      .select(
        'source_ip',
        this.db.raw('COUNT(*)::int AS events'),
        this.db.raw('COUNT(DISTINCT destination_port)::int AS distinct_ports'),
        this.db.raw('COUNT(DISTINCT destination_ip)::int AS distinct_destinations'),
        this.db.raw('mode() WITHIN GROUP (ORDER BY source_port) AS common_source_port'),
        this.db.raw('COUNT(*) FILTER (WHERE destination_port >= ?)::int AS to_ephemeral_ports', [
          EPHEMERAL_PORT_START,
        ]),
        this.db.raw('MIN(occurred_at) AS first_seen'),
        this.db.raw('MAX(occurred_at) AS last_seen'),
        this.db.raw(
          'array_agg(DISTINCT direction) FILTER (WHERE direction IS NOT NULL) AS directions'
        )
      )
      .groupBy('source_ip')
      .havingRaw('COUNT(*) >= ?', [minimumCount])
      .orderBy('events', 'desc')
      .limit(limit);
  }

  acceptedInbound(range: TimeRange, limit: number) {
    return this.db('firewall_events')
      .where('action', 'accept')
      .whereIn('direction', INBOUND_DIRECTIONS)
      .whereBetween('occurred_at', [range.from, range.to])
      .select(
        'destination_ip',
        'destination_port',
        'protocol',
        this.db.raw('COUNT(*)::int AS events'),
        this.db.raw('COUNT(DISTINCT source_ip)::int AS distinct_sources'),
        this.db.raw('MAX(occurred_at) AS last_seen')
      )
      .groupBy('destination_ip', 'destination_port', 'protocol')
      .orderBy('events', 'desc')
      .limit(limit);
  }

  topDeniedInboundPorts(range: TimeRange, limit: number) {
    return this.db('firewall_events')
      .where('action', 'deny')
      .whereIn('direction', INBOUND_DIRECTIONS)
      .whereNotNull('destination_port')
      .whereBetween('occurred_at', [range.from, range.to])
      .select(
        'destination_port',
        'protocol',
        this.db.raw('COUNT(*)::int AS events'),
        this.db.raw('COUNT(DISTINCT source_ip)::int AS distinct_sources')
      )
      .groupBy('destination_port', 'protocol')
      .orderBy('events', 'desc')
      .limit(limit);
  }
}
