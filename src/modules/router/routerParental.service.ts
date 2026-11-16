import { AppError } from '../../common/errors/AppError';
import { ErrorCode } from '../../common/errors/errorCodes';
import type { RequestContext } from '../auth/auth.types';
import type { AuditAction } from '../audit/audit.types';
import {
  parseParental,
  parseRouterDevices,
  type ParentalState,
  type ParentalTemplate,
} from './huaweiParser';
import type { FormSubmission } from './huaweiWebClient';
import type {
  ParentalDeviceInput,
  ParentalPeriodInput,
  ParentalTemplateUpdate,
} from './routerParental.schema';
import type { RouterWriter } from './routerWriter';

const PC = 'InternetGatewayDevice.X_HW_Security.ParentalCtrl';
const POLICY = { block: '0', allow: '1' } as const;

const refuse = (message: string) => new AppError(ErrorCode.ROUTER_WRITE_REFUSED, 422, message);
const notFound = () => new AppError(ErrorCode.ROUTER_RULE_NOT_FOUND, 404);

export interface RouterParentalSettings {
  /** LAN addresses whose devices must never be restricted: the server and the admin's PC. */
  protectedAddresses: string[];
}

type Form = Omit<FormSubmission, 'page' | 'readBack'>;

/**
 * Parental control: templates (time periods and URL lists, each blocking or allowing) and the
 * devices bound to them, through the router's own requests, verified by reading back.
 * Request formats: docs/huawei/parental-control-management.md.
 */
export class RouterParentalService {
  constructor(
    private writer: RouterWriter,
    private settings: RouterParentalSettings
  ) {}

  get writesEnabled(): boolean {
    return this.writer.writesEnabled;
  }

  async getState(): Promise<ParentalState> {
    const { parentalInfo } = await this.writer.read(['parentalInfo'] as const);
    return parse(parentalInfo);
  }

  async addTemplate(name: string, adminId: number, context: RequestContext) {
    const before = await this.prepare();
    if (before.templates.some((t) => t.name === name))
      throw refuse('A template with this name exists');
    return this.write(
      'router.parental_template_created',
      {
        action: 'add',
        objectKey: 'x_SAVE_A',
        object: `${PC}.Templates`,
        fields: { 'x_SAVE_A.Name': name, 'x_SAVE_A.StartDate': '', 'x_SAVE_A.EndDate': '' },
      },
      (after) => {
        const added = after.templates.find(
          (t) => t.name === name && !before.templates.some((old) => old.index === t.index)
        );
        return added ? { template: added } : null;
      },
      adminId,
      context,
      { requested: { name } }
    );
  }

  async updateTemplate(
    index: number,
    input: ParentalTemplateUpdate,
    adminId: number,
    context: RequestContext
  ) {
    const before = await this.prepare();
    const current = template(before, index);
    if (input.name && before.templates.some((t) => t.name === input.name && t.index !== index)) {
      throw refuse('A template with this name exists');
    }
    const fields: Record<string, string> = {};
    if (input.name !== undefined)
      Object.assign(fields, { 'x.Name': input.name, 'x.StartDate': '', 'x.EndDate': '' });
    if (input.timeEnabled !== undefined) fields['x.DurationRight'] = input.timeEnabled ? '1' : '0';
    if (input.timeMode !== undefined) fields['x.DurationPolicy'] = POLICY[input.timeMode];
    if (input.urlEnabled !== undefined) fields['x.UrlFilterRight'] = input.urlEnabled ? '1' : '0';
    if (input.urlMode !== undefined) fields['x.UrlFilterPolicy'] = POLICY[input.urlMode];
    return this.write(
      'router.parental_template_updated',
      { action: 'set', object: `${PC}.Templates.${index}`, fields },
      (after) => {
        const t = after.templates.find((x) => x.index === index);
        const matches =
          t &&
          (input.name === undefined || t.name === input.name) &&
          (input.timeEnabled === undefined || t.timeEnabled === input.timeEnabled) &&
          (input.timeMode === undefined || t.timeMode === input.timeMode) &&
          (input.urlEnabled === undefined || t.urlEnabled === input.urlEnabled) &&
          (input.urlMode === undefined || t.urlMode === input.urlMode);
        return matches ? { template: t } : null;
      },
      adminId,
      context,
      { before: summary(current), requested: input }
    );
  }

  async deleteTemplate(index: number, adminId: number, context: RequestContext) {
    const before = await this.prepare();
    const current = template(before, index);
    if (before.devices.some((d) => d.template === index)) {
      throw refuse('Devices use this template; move or remove them first');
    }
    return this.write(
      'router.parental_template_deleted',
      { action: 'del', fields: { [`${PC}.Templates.${index}`]: '' } },
      (after) => (after.templates.some((t) => t.index === index) ? null : {}),
      adminId,
      context,
      { before: current }
    );
  }

  async addPeriod(
    index: number,
    input: ParentalPeriodInput,
    adminId: number,
    context: RequestContext
  ) {
    const before = await this.prepare();
    const current = template(before, index);
    const days = [...input.days].sort((a, b) => a - b).join(',');
    if (
      current.periods.some(
        (p) => p.start === input.start && p.end === input.end && p.days.join(',') === days
      )
    ) {
      throw refuse('This period exists');
    }
    return this.write(
      'router.parental_period_created',
      {
        action: 'add',
        object: `${PC}.Templates.${index}.Duration`,
        fields: { 'x.StartTime': input.start, 'x.EndTime': input.end, 'x.RepeatDay': days },
      },
      (after) => {
        const added = template(after, index).periods.find(
          (p) =>
            !current.periods.some((old) => old.index === p.index) &&
            p.start === input.start &&
            p.end === input.end
        );
        return added ? { period: added } : null;
      },
      adminId,
      context,
      { template: index, requested: { ...input, days } }
    );
  }

  async deletePeriod(index: number, period: number, adminId: number, context: RequestContext) {
    const before = await this.prepare();
    const current = template(before, index).periods.find((p) => p.index === period);
    if (!current) throw notFound();
    const domain = `${PC}.Templates.${index}.Duration.${period}`;
    return this.write(
      'router.parental_period_deleted',
      { action: 'del', fields: { [domain]: '' } },
      (after) => (template(after, index).periods.some((p) => p.index === period) ? null : {}),
      adminId,
      context,
      { template: index, before: current }
    );
  }

  async addUrl(index: number, url: string, adminId: number, context: RequestContext) {
    const before = await this.prepare();
    const current = template(before, index);
    if (current.urls.some((u) => u.url.toLowerCase() === url.toLowerCase())) {
      throw refuse('This site is in the list');
    }
    return this.write(
      'router.parental_url_created',
      {
        action: 'add',
        object: `${PC}.Templates.${index}.UrlFilter`,
        fields: { 'x.UrlAddress': url },
      },
      (after) => {
        const added = template(after, index).urls.find(
          (u) => u.url === url && !current.urls.some((old) => old.index === u.index)
        );
        return added ? { url: added } : null;
      },
      adminId,
      context,
      { template: index, requested: { url } }
    );
  }

  async deleteUrl(index: number, item: number, adminId: number, context: RequestContext) {
    const before = await this.prepare();
    const current = template(before, index).urls.find((u) => u.index === item);
    if (!current) throw notFound();
    return this.write(
      'router.parental_url_deleted',
      { action: 'del', fields: { [`${PC}.Templates.${index}.UrlFilter.${item}`]: '' } },
      (after) => (template(after, index).urls.some((u) => u.index === item) ? null : {}),
      adminId,
      context,
      { template: index, before: current }
    );
  }

  async addDevice(input: ParentalDeviceInput, adminId: number, context: RequestContext) {
    const before = await this.prepareDevice(input);
    return this.write(
      'router.parental_device_created',
      { action: 'add', object: `${PC}.MAC`, fields: deviceFields(input) },
      (after) => {
        const added = after.devices.find(
          (d) => d.mac === input.mac && !before.devices.some((old) => old.index === d.index)
        );
        return added && added.template === input.template ? { device: added } : null;
      },
      adminId,
      context,
      { requested: input }
    );
  }

  async updateDevice(
    index: number,
    input: ParentalDeviceInput,
    adminId: number,
    context: RequestContext
  ) {
    const before = await this.prepareDevice(input, index);
    const current = before.devices.find((d) => d.index === index)!;
    return this.write(
      'router.parental_device_updated',
      { action: 'set', object: `${PC}.MAC.${index}`, fields: deviceFields(input) },
      (after) => {
        const d = after.devices.find((x) => x.index === index);
        return d &&
          d.mac === input.mac &&
          d.template === input.template &&
          d.description === input.description
          ? { device: d }
          : null;
      },
      adminId,
      context,
      { before: current, requested: input }
    );
  }

  async deleteDevice(index: number, adminId: number, context: RequestContext) {
    const before = await this.prepare();
    const current = before.devices.find((d) => d.index === index);
    if (!current) throw notFound();
    return this.write(
      'router.parental_device_deleted',
      { action: 'del', fields: { [`${PC}.MAC.${index}`]: '' } },
      (after) => (after.devices.some((d) => d.index === index) ? null : {}),
      adminId,
      context,
      { before: current }
    );
  }

  private async prepare(): Promise<ParentalState> {
    this.writer.requireWritable();
    return this.getState();
  }

  /** A device may be restricted only once, never if it is the server or the admin PC. */
  private async prepareDevice(input: ParentalDeviceInput, index?: number) {
    this.writer.requireWritable();
    const pages = await this.writer.read(['parentalInfo', 'devices'] as const);
    const state = parse(pages.parentalInfo);
    if (index !== undefined && !state.devices.some((d) => d.index === index)) throw notFound();
    template(state, input.template);
    const holder = parseRouterDevices(pages.devices).find(
      (d) =>
        d.macAddress === input.mac &&
        d.ipAddress &&
        this.settings.protectedAddresses.includes(d.ipAddress)
    );
    if (holder) {
      throw refuse(
        `${holder.hostName ?? input.mac} (${holder.ipAddress}) must stay unrestricted (server or admin PC)`
      );
    }
    if (state.devices.some((d) => d.mac === input.mac && d.index !== index)) {
      throw refuse('This device already has a template');
    }
    return state;
  }

  private write<T extends object>(
    action: AuditAction,
    form: Form,
    verify: (after: ParentalState) => T | null,
    adminId: number,
    context: RequestContext,
    details: Record<string, unknown>
  ) {
    return this.writer.write({
      action,
      entityType: 'router_parental',
      form: { ...form, page: 'parental', readBack: 'parentalInfo' },
      parse,
      verify,
      adminId,
      context,
      details,
    });
  }
}

function template(state: ParentalState, index: number): ParentalTemplate {
  const found = state.templates.find((t) => t.index === index);
  if (!found) throw notFound();
  return found;
}

function summary(t: ParentalTemplate) {
  return {
    name: t.name,
    timeEnabled: t.timeEnabled,
    timeMode: t.timeMode,
    urlEnabled: t.urlEnabled,
    urlMode: t.urlMode,
  };
}

function deviceFields(input: ParentalDeviceInput): Record<string, string> {
  return {
    'x.MACAddress': input.mac,
    'x.Description': input.description,
    'x.TemplateInst': String(input.template),
  };
}

function parse(page: string): ParentalState {
  const state = parseParental(page);
  if (!state)
    throw new AppError(ErrorCode.ROUTER_UNAVAILABLE, 502, 'Parental control data not found');
  return state;
}
