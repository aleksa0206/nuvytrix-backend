import { AppError, NotFoundError } from '../../common/errors/AppError';
import { ErrorCode } from '../../common/errors/errorCodes';
import type { RequestContext } from '../auth/auth.types';
import type { AuditService } from '../audit/audit.service';
import type { PoliciesRepository, PolicyFields, PolicyRow } from './policies.repository';
import type { CreatePolicyInput, PolicyStatus, UpdatePolicyInput } from './policies.schema';

const ALLOWED_TRANSITIONS: Record<PolicyStatus, PolicyStatus[]> = {
  draft: ['pending_manual', 'retired'],
  pending_manual: ['marked_applied', 'apply_failed', 'draft', 'retired'],
  apply_failed: ['pending_manual', 'draft', 'retired'],
  marked_applied: ['pending_manual', 'retired'],
  retired: ['draft'],
};

// Statuses that claim something about the router, or remove a rule from tracking.
const NEEDS_CONFIRMATION: PolicyStatus[] = ['marked_applied', 'retired'];

const DIRECTION_LABELS: Record<string, string> = {
  internet_to_lan: 'From Internet to LAN',
  internet_to_router: 'From Internet to local (router)',
  lan_to_internet: 'From LAN to Internet',
  lan_to_router: 'From LAN to local (router)',
};

export interface PolicySettings {
  routerHost: string;
}

export class PoliciesService {
  constructor(
    private policiesRepository: PoliciesRepository,
    private auditService: AuditService,
    private settings: PolicySettings
  ) {}

  async list() {
    return (await this.policiesRepository.findAll()).map((row) => this.toDto(row));
  }

  async get(policyId: number) {
    return this.toDto(await this.findOrThrow(policyId));
  }

  async create(input: CreatePolicyInput, adminId: number, context: RequestContext) {
    const row = await this.policiesRepository.create(toFields(input), adminId);
    await this.audit('firewall.policy_created', row, adminId, context, { name: row.name });
    return this.toDto(row);
  }

  async update(
    policyId: number,
    input: UpdatePolicyInput,
    adminId: number,
    context: RequestContext
  ) {
    const existing = await this.findOrThrow(policyId);
    const fields = toFields({ ...fromRow(existing), ...input });
    if (fields.destination_ports && fields.protocol !== 'tcp' && fields.protocol !== 'udp') {
      throw new AppError(ErrorCode.VALIDATION_ERROR, 400, 'Ports apply only to TCP or UDP');
    }

    // A rule the admin said is on the router no longer matches it once edited.
    const reopen = existing.status === 'marked_applied';
    const row = await this.policiesRepository.update(policyId, {
      ...fields,
      ...(reopen && {
        status: 'pending_manual' as const,
        status_note: 'Edited after being marked as applied; apply the change on the router.',
      }),
    });
    await this.audit('firewall.policy_updated', row!, adminId, context, {
      fields: Object.keys(input),
      reopened: reopen,
    });
    return this.toDto(row!);
  }

  async changeStatus(
    policyId: number,
    change: { status: PolicyStatus; note?: string; confirm?: boolean },
    adminId: number,
    context: RequestContext
  ) {
    const existing = await this.findOrThrow(policyId);
    if (!ALLOWED_TRANSITIONS[existing.status].includes(change.status)) {
      throw new AppError(ErrorCode.FIREWALL_POLICY_INVALID_TRANSITION, 409);
    }
    if (NEEDS_CONFIRMATION.includes(change.status) && change.confirm !== true) {
      throw new AppError(ErrorCode.CONFIRMATION_REQUIRED, 428);
    }
    const row = await this.policiesRepository.update(policyId, {
      status: change.status,
      status_note: change.note || null,
    });
    await this.audit('firewall.policy_status_changed', row!, adminId, context, {
      from: existing.status,
      to: change.status,
    });
    return this.toDto(row!);
  }

  async delete(
    policyId: number,
    confirm: boolean | undefined,
    adminId: number,
    context: RequestContext
  ) {
    const existing = await this.findOrThrow(policyId);
    if (confirm !== true) throw new AppError(ErrorCode.CONFIRMATION_REQUIRED, 428);
    await this.policiesRepository.delete(policyId);
    await this.audit('firewall.policy_deleted', existing, adminId, context, {
      name: existing.name,
      status: existing.status,
    });
  }

  countByStatus() {
    return this.policiesRepository.countByStatus();
  }

  /** Step-by-step text for applying the rule by hand, since the router has no supported API. */
  async instructions(policyId: number) {
    const policy = await this.findOrThrow(policyId);
    const router = this.settings.routerHost || 'the router';
    const steps = [
      `Open http://${router} from a device on the LAN and sign in as the router administrator.`,
      'Open the security settings and find the IPv4 filtering page (the exact menu names depend on the firmware).',
      'Add a new filter rule with these values:',
      `  Direction: ${DIRECTION_LABELS[policy.direction] ?? policy.direction}`,
      `  Protocol: ${policy.protocol.toUpperCase()}`,
      `  Source: ${policy.source === 'any' ? 'any address' : policy.source}`,
      `  Destination: ${policy.destination === 'any' ? 'any address' : policy.destination}`,
      ...(policy.destination_ports ? [`  Destination port(s): ${policy.destination_ports}`] : []),
      `  Action: ${policy.action === 'deny' ? 'Deny / Reject' : 'Accept / Permit'}`,
      'Save, then check that the router admin page and internet access still work from this device.',
      'Come back here and mark the rule as applied, or as failed with a note about what went wrong.',
    ];
    return {
      policyId: policy.id,
      steps,
      warnings: this.warningsFor(policy),
      note:
        'Nuvytrix cannot read or change the router configuration. Field names on the router may differ ' +
        'from the ones above; IPv6 filtering, if offered, is configured separately.',
    };
  }

  private warningsFor(policy: PolicyRow): string[] {
    const warnings: string[] = [];
    const hitsAllTraffic = policy.protocol === 'any' && !policy.destination_ports;
    const targetsRouter =
      policy.destination === 'any' || policy.destination === this.settings.routerHost;

    if (policy.action === 'deny' && policy.direction === 'lan_to_router' && targetsRouter) {
      warnings.push(
        'This rule may block access to the router admin page from the LAN, which would lock you out. ' +
          'Keep at least one device excluded before applying it.'
      );
    }
    if (
      policy.action === 'deny' &&
      policy.direction === 'lan_to_internet' &&
      policy.source === 'any' &&
      policy.destination === 'any' &&
      hitsAllTraffic
    ) {
      warnings.push('This rule blocks all internet access for every device on the LAN.');
    }
    if (
      policy.action === 'accept' &&
      policy.direction.startsWith('internet_') &&
      policy.source === 'any'
    ) {
      warnings.push('This rule allows traffic from any internet address into the network.');
    }
    return warnings;
  }

  private async findOrThrow(policyId: number): Promise<PolicyRow> {
    const row = await this.policiesRepository.findById(policyId);
    if (!row) throw new NotFoundError(ErrorCode.FIREWALL_POLICY_NOT_FOUND);
    return row;
  }

  private audit(
    action:
      | 'firewall.policy_created'
      | 'firewall.policy_updated'
      | 'firewall.policy_status_changed'
      | 'firewall.policy_deleted',
    row: PolicyRow,
    adminId: number,
    context: RequestContext,
    details: Record<string, unknown>
  ) {
    return this.auditService.record({
      adminId,
      action,
      entityType: 'firewall_policy',
      entityId: row.id,
      details,
      ipAddress: context.ipAddress,
    });
  }

  private toDto(row: PolicyRow) {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      action: row.action,
      direction: row.direction,
      protocol: row.protocol,
      source: row.source,
      destination: row.destination,
      destinationPorts: row.destination_ports,
      status: row.status,
      statusNote: row.status_note,
      statusChangedAt: row.status_changed_at,
      routerState: 'unverified' as const,
      allowedTransitions: ALLOWED_TRANSITIONS[row.status],
      warnings: this.warningsFor(row),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}

function fromRow(row: PolicyRow): CreatePolicyInput {
  return {
    name: row.name,
    description: row.description,
    action: row.action,
    direction: row.direction as CreatePolicyInput['direction'],
    protocol: row.protocol,
    source: row.source,
    destination: row.destination,
    destinationPorts: row.destination_ports,
  };
}

function toFields(input: CreatePolicyInput): PolicyFields {
  return {
    name: input.name,
    description: input.description || null,
    action: input.action,
    direction: input.direction,
    protocol: input.protocol,
    source: input.source,
    destination: input.destination,
    destination_ports: input.destinationPorts || null,
  };
}
