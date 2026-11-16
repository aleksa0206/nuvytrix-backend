import { AppError } from '../../common/errors/AppError';
import { ErrorCode } from '../../common/errors/errorCodes';
import type { RequestContext } from '../auth/auth.types';
import {
  parseMacFilter,
  parseRouterDevices,
  parseWlan,
  type MacFilterEntry,
  type MacFilterState,
} from './huaweiParser';
import type { RouterPage } from './huaweiWebClient';
import type { MacFilterEntryInput, MacFilterList } from './routerMacFilter.schema';
import type { RouterWriter } from './routerWriter';

const SECURITY = 'InternetGatewayDevice.X_HW_Security';

/** Per list: the router page, its TR-098 collection and the names of its fields. */
const LISTS = {
  lan: {
    page: 'macFilter',
    collection: `${SECURITY}.MacFilter`,
    right: 'x.MacFilterRight',
    policy: 'x.MacFilterPolicy',
  },
  wifi: {
    page: 'wifiMacFilter',
    collection: `${SECURITY}.WLANMacFilter`,
    right: 'x.WlanMacFilterRight',
    policy: 'x.WlanMacFilterPolicy',
  },
} as const satisfies Record<MacFilterList, { page: RouterPage } & Record<string, string>>;

export interface RouterMacFilterSettings {
  /** LAN addresses whose devices must never be blocked: the server and the admin's PC. */
  protectedAddresses: string[];
}

export interface WifiNetwork {
  /** The router's name for the network in the MAC filter (`SSID-1`). */
  id: string;
  ssid: string;
  band: string;
}

const refuse = (message: string) => new AppError(ErrorCode.ROUTER_WRITE_REFUSED, 422, message);

/**
 * The router's LAN and Wi-Fi MAC filters (blacklist mode only), changed through the router's own
 * forms and verified by reading back. Request formats: docs/huawei/mac-filter-management.md.
 */
export class RouterMacFilterService {
  constructor(
    private writer: RouterWriter,
    private settings: RouterMacFilterSettings
  ) {}

  get writesEnabled(): boolean {
    return this.writer.writesEnabled;
  }

  async getState() {
    const pages = await this.writer.read(['macFilter', 'wifiMacFilter', 'wlan'] as const);
    return {
      lan: parse(pages.macFilter, 'lan'),
      wifi: parse(pages.wifiMacFilter, 'wifi'),
      wifiNetworks: networks(pages.wlan),
    };
  }

  async setEnabled(
    list: MacFilterList,
    enabled: boolean,
    adminId: number,
    context: RequestContext
  ) {
    const { before, blocked } = await this.prepare(list);
    if (enabled) {
      const hit = before.entries.find((entry) => blocked.has(entry.mac));
      if (hit) throw refuse(`The list blocks ${blocked.get(hit.mac)}; remove that entry first`);
    }
    const spec = LISTS[list];
    return this.writer.write({
      action: 'router.mac_filter_settings_changed',
      entityType: 'router_mac_filter',
      // The router's form always sends the policy with the switch; blacklist is the only one used.
      form: {
        page: spec.page,
        action: 'set',
        object: SECURITY,
        fields: { [spec.right]: enabled ? '1' : '0', [spec.policy]: '0' },
      },
      parse: (page) => parse(page, list),
      verify: (after) => (after.enabled === enabled && after.mode === 'blacklist' ? {} : null),
      adminId,
      context,
      details: { list, before: { enabled: before.enabled }, requested: { enabled } },
    });
  }

  async addEntry(
    list: MacFilterList,
    input: MacFilterEntryInput,
    adminId: number,
    context: RequestContext
  ) {
    const { before } = await this.prepareEntry(list, input);
    const spec = LISTS[list];
    return this.writer.write({
      action: 'router.mac_filter_entry_created',
      entityType: 'router_mac_filter',
      form: {
        page: spec.page,
        action: 'add',
        object: spec.collection,
        fields: fields(list, input),
      },
      parse: (page) => parse(page, list),
      verify: (after) => {
        const added = after.entries.find(
          (e) => !before.entries.some((old) => old.domain === e.domain) && same(e, input)
        );
        return added ? { entry: added } : null;
      },
      adminId,
      context,
      details: { list, requested: input },
    });
  }

  async updateEntry(
    list: MacFilterList,
    index: number,
    input: MacFilterEntryInput,
    adminId: number,
    context: RequestContext
  ) {
    const domain = `${LISTS[list].collection}.${index}`;
    const { before } = await this.prepareEntry(list, input, domain);
    const current = before.entries.find((e) => e.domain === domain)!;
    return this.writer.write({
      action: 'router.mac_filter_entry_updated',
      entityType: 'router_mac_filter',
      form: { page: LISTS[list].page, action: 'set', object: domain, fields: fields(list, input) },
      parse: (page) => parse(page, list),
      verify: (after) => {
        const updated = after.entries.find((e) => e.domain === domain);
        return updated && same(updated, input) ? { entry: updated } : null;
      },
      adminId,
      context,
      details: { list, before: current, requested: input },
    });
  }

  async deleteEntry(list: MacFilterList, index: number, adminId: number, context: RequestContext) {
    const { before } = await this.prepare(list);
    const spec = LISTS[list];
    const domain = `${spec.collection}.${index}`;
    const current = before.entries.find((e) => e.domain === domain);
    if (!current) throw new AppError(ErrorCode.ROUTER_RULE_NOT_FOUND, 404);
    return this.writer.write({
      action: 'router.mac_filter_entry_deleted',
      entityType: 'router_mac_filter',
      form: { page: spec.page, action: 'del', object: spec.collection, fields: { [domain]: '' } },
      parse: (page) => parse(page, list),
      verify: (after) => (after.entries.some((e) => e.domain === domain) ? null : {}),
      adminId,
      context,
      details: { list, before: current },
    });
  }

  /**
   * Reads the list live and refuses anything outside blacklist mode: a whitelist without the
   * right entries cuts every other device off. Also returns the MACs that must never be blocked.
   */
  private async prepare(list: MacFilterList, extra: readonly RouterPage[] = []) {
    this.writer.requireWritable();
    const page = LISTS[list].page;
    const pages: Partial<Record<RouterPage, string>> = await this.writer.read([
      page,
      'devices',
      ...extra,
    ]);
    const before = parse(pages[page]!, list);
    if (before.mode !== 'blacklist') {
      throw refuse(
        `The ${list} MAC filter is in ${before.mode} mode; Nuvytrix only edits blacklists`
      );
    }
    // MAC of every device that holds a protected address, keyed to a readable label.
    const blocked = new Map<string, string>();
    for (const device of parseRouterDevices(pages.devices!)) {
      if (device.ipAddress && this.settings.protectedAddresses.includes(device.ipAddress)) {
        blocked.set(
          device.macAddress,
          `${device.hostName ?? device.macAddress} (${device.ipAddress})`
        );
      }
    }
    return { before, blocked, pages };
  }

  private async prepareEntry(list: MacFilterList, input: MacFilterEntryInput, domain?: string) {
    const { before, blocked, pages } = await this.prepare(list, list === 'wifi' ? ['wlan'] : []);
    if (domain && !before.entries.some((e) => e.domain === domain)) {
      throw new AppError(ErrorCode.ROUTER_RULE_NOT_FOUND, 404);
    }
    const label = blocked.get(input.mac);
    if (label) throw refuse(`${label} must stay reachable (server or admin PC)`);
    if (list === 'wifi') {
      if (!input.ssid) throw refuse('Pick the Wi-Fi network the entry applies to');
      if (!networks(pages.wlan!).some((n) => n.id === input.ssid)) {
        throw refuse(`${input.ssid} is not an active Wi-Fi network on the router`);
      }
    }
    const others = before.entries.filter((e) => e.domain !== domain);
    if (others.some((e) => e.mac === input.mac && (list === 'lan' || e.ssid === input.ssid))) {
      throw refuse('This MAC address is already in the list');
    }
    return { before };
  }
}

/** The fields the router's own form posts for an entry. */
function fields(list: MacFilterList, input: MacFilterEntryInput): Record<string, string> {
  return list === 'lan'
    ? { 'x.SourceMACAddress': input.mac, 'x.DeviceAlias': input.name }
    : {
        'x.SourceMACAddress': input.mac,
        'x.SSIDName': input.ssid ?? '',
        'x.DeviceName': input.name,
        'x.Enable': '1',
      };
}

function same(entry: MacFilterEntry, input: MacFilterEntryInput): boolean {
  return (
    entry.mac === input.mac &&
    entry.name === input.name &&
    (entry.ssid === undefined || entry.ssid === input.ssid)
  );
}

function parse(page: string, list: MacFilterList): MacFilterState {
  const state = parseMacFilter(page, list);
  if (!state) throw new AppError(ErrorCode.ROUTER_UNAVAILABLE, 502, 'MAC filter page not found');
  return state;
}

/** Active Wi-Fi networks; the router names them `SSID-<instance>` in the MAC filter. */
function networks(page: string): WifiNetwork[] {
  return (parseWlan(page) ?? []).map((w) => ({
    id: `SSID-${w.instance}`,
    ssid: w.ssid,
    band: w.band,
  }));
}
