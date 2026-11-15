import type { Knex } from 'knex';
import type { PolicyStatus } from './policies.schema';

export interface PolicyRow {
  id: number;
  name: string;
  description: string | null;
  action: 'accept' | 'deny';
  direction: string;
  protocol: 'any' | 'tcp' | 'udp' | 'icmp';
  source: string;
  destination: string;
  destination_ports: string | null;
  status: PolicyStatus;
  status_note: string | null;
  status_changed_at: Date;
  created_by: number | null;
  created_at: Date;
  updated_at: Date;
}

export type PolicyFields = Pick<
  PolicyRow,
  | 'name'
  | 'description'
  | 'action'
  | 'direction'
  | 'protocol'
  | 'source'
  | 'destination'
  | 'destination_ports'
>;

export class PoliciesRepository {
  constructor(private db: Knex) {}

  findAll(): Promise<PolicyRow[]> {
    return this.db<PolicyRow>('firewall_policies').orderBy([
      { column: 'status', order: 'asc' },
      { column: 'id', order: 'asc' },
    ]);
  }

  findById(policyId: number): Promise<PolicyRow | undefined> {
    return this.db<PolicyRow>('firewall_policies').where({ id: policyId }).first();
  }

  async create(fields: PolicyFields, createdBy: number): Promise<PolicyRow> {
    const [row] = await this.db('firewall_policies')
      .insert({ ...fields, status: 'draft', created_by: createdBy })
      .returning('*');
    return row;
  }

  async update(
    policyId: number,
    changes: Partial<PolicyFields> & { status?: PolicyStatus; status_note?: string | null }
  ): Promise<PolicyRow | undefined> {
    const [row] = await this.db('firewall_policies')
      .where({ id: policyId })
      .update({
        ...changes,
        ...(changes.status && { status_changed_at: this.db.fn.now() }),
        updated_at: this.db.fn.now(),
      })
      .returning('*');
    return row;
  }

  async delete(policyId: number): Promise<boolean> {
    return (await this.db('firewall_policies').where({ id: policyId }).delete()) > 0;
  }

  async countByStatus(): Promise<Record<string, number>> {
    const rows = await this.db('firewall_policies')
      .select('status')
      .count<{ status: string; count: number }[]>('* as count')
      .groupBy('status');
    return Object.fromEntries(rows.map((row) => [row.status, row.count]));
  }
}
