import { AppError } from '../../common/errors/AppError';
import { ErrorCode } from '../../common/errors/errorCodes';
import { logger } from '../../config/logger';
import type { RequestContext } from '../auth/auth.types';
import { parseWifiNetworks, wifiKeyMatches, type WifiNetwork } from './huaweiParser';
import type { WifiCreateInput, WifiUpdateInput } from './routerWifi.schema';
import type { RouterWriter } from './routerWriter';

const LAN = 'InternetGatewayDevice.LANDevice.1';
const RADIOS = { '2.4 GHz': `${LAN}.WiFi.Radio.1`, '5 GHz': `${LAN}.WiFi.Radio.2` } as const;
const MODES = {
  wpa2: {
    beacon: '11i',
    auth: 'y.IEEE11iAuthenticationMode',
    enc: 'y.IEEE11iEncryptionModes',
    cipher: 'AESEncryption',
  },
  'wpa-wpa2': {
    beacon: 'WPAand11i',
    auth: 'y.X_HW_WPAand11iAuthenticationMode',
    enc: 'y.X_HW_WPAand11iEncryptionModes',
    cipher: 'TKIPandAESEncryption',
  },
} as const;

const refuse = (message: string) => new AppError(ErrorCode.ROUTER_WRITE_REFUSED, 422, message);

/** Audit details never carry a Wi-Fi key: only whether one was set. */
const redact = <T extends { password?: string }>(input: T) => ({
  ...input,
  password: input.password ? '[changed]' : undefined,
});

/**
 * Wi-Fi networks (SSIDs) on both bands: name, on/off, visibility, WPA2 or WPA/WPA2 with a key;
 * adding and removing extra networks. Through the router's own WlanBasic.asp forms, verified by
 * reading back. The page holds the Wi-Fi keys: they are compared, never returned or logged.
 * Request formats: docs/huawei/wifi-management.md.
 */
export class RouterWifiService {
  constructor(private writer: RouterWriter) {}

  get writesEnabled(): boolean {
    return this.writer.writesEnabled;
  }

  async getNetworks(): Promise<WifiNetwork[]> {
    const { wifi } = await this.writer.read(['wifi'] as const);
    return parse(wifi);
  }

  async updateNetwork(
    index: number,
    input: WifiUpdateInput,
    adminId: number,
    context: RequestContext
  ) {
    this.writer.requireWritable();
    const before = await this.getNetworks();
    const current = before.find((n) => n.instance === index);
    if (!current) throw new AppError(ErrorCode.ROUTER_RULE_NOT_FOUND, 404);
    const keyed = current.security === 'wpa2' || current.security === 'wpa-wpa2';
    if (!input.password && (!keyed || current.security !== input.security)) {
      throw refuse('Set a password when changing the security of this network');
    }
    checkName(input.ssid, current.band, before, current.domain);
    return this.write(current, input, before, adminId, context, 'router.wifi_network_updated');
  }

  /**
   * Adds a network the way the router page does: created switched off (the router makes new
   * networks open), then given its name, security and key in a second request. If the second step
   * fails, the new network is removed again so no open network is left behind.
   */
  async addNetwork(input: WifiCreateInput, adminId: number, context: RequestContext) {
    this.writer.requireWritable();
    const before = await this.getNetworks();
    checkName(input.ssid, input.band, before);
    const created = await this.writer.write({
      action: 'router.wifi_network_created',
      entityType: 'router_wifi',
      form: {
        page: 'wifi',
        action: 'add',
        objectKey: 'y',
        object: `${LAN}.WLANConfiguration`,
        fields: {
          'y.Enable': '0',
          'y.SSIDAdvertisementEnabled': input.visible ? '1' : '0',
          'y.WMMEnable': '1',
          'y.SSID': input.ssid,
          'y.X_HW_AssociateNum': '32',
          'y.LowerLayers': RADIOS[input.band],
        },
      },
      parse: (page) => parse(page),
      verify: (after) => {
        const added = after.find(
          (n) => !before.some((old) => old.domain === n.domain) && n.ssid === input.ssid
        );
        return added ? { network: added } : null;
      },
      adminId,
      context,
      details: { requested: redact(input), step: 'create switched off' },
    });
    try {
      return await this.write(
        created.network,
        input,
        created.state,
        adminId,
        context,
        'router.wifi_network_updated'
      );
    } catch (err) {
      logger.warn({ ssid: input.ssid }, 'Securing a new Wi-Fi network failed; removing it');
      await this.deleteNetwork(created.network.instance, adminId, context, true);
      throw err;
    }
  }

  async deleteNetwork(index: number, adminId: number, context: RequestContext, rollback = false) {
    this.writer.requireWritable();
    const before = await this.getNetworks();
    const current = before.find((n) => n.instance === index);
    if (!current) throw new AppError(ErrorCode.ROUTER_RULE_NOT_FOUND, 404);
    const first = Math.min(...before.filter((n) => n.band === current.band).map((n) => n.instance));
    if (current.instance === first) {
      throw refuse(`“${current.ssid}” is the main ${current.band} network and cannot be removed`);
    }
    return this.writer.write({
      action: 'router.wifi_network_deleted',
      entityType: 'router_wifi',
      // The page first tells the Wi-Fi driver which instance goes, then deletes the object.
      form: {
        page: 'wifi',
        action: 'del',
        fields: { [current.domain]: '' },
        before: {
          action: 'set',
          objectKey: 'y',
          object: 'InternetGatewayDevice.X_HW_DEBUG.AMP.ParallelDelSsid',
          fields: { 'y.DeleteInstArray': String(current.instance) },
        },
      },
      parse: (page) => parse(page),
      verify: (after) => (after.some((n) => n.domain === current.domain) ? null : {}),
      adminId,
      context,
      details: { before: current, ...(rollback ? { reason: 'rollback of a failed add' } : {}) },
    });
  }

  private write(
    current: WifiNetwork,
    input: WifiUpdateInput,
    before: WifiNetwork[],
    adminId: number,
    context: RequestContext,
    action: 'router.wifi_network_updated'
  ) {
    const mode = MODES[input.security];
    let keyOk = true;
    return this.writer.write({
      action,
      entityType: 'router_wifi',
      form: {
        page: 'wifi',
        action: 'set',
        objectKey: 'y',
        object: current.domain,
        ...(input.password ? { extraQuery: { k: `${current.domain}.PreSharedKey.1` } } : {}),
        fields: {
          'y.Enable': input.enabled ? '1' : '0',
          'y.SSIDAdvertisementEnabled': input.visible ? '1' : '0',
          'y.SSID': input.ssid,
          'y.BeaconType': mode.beacon,
          [mode.auth]: 'PSKAuthentication',
          [mode.enc]: mode.cipher,
          'y.X_HW_GroupRekey': '3600',
          ...(input.password ? { 'k.PreSharedKey': input.password } : {}),
        },
      },
      parse: (page) => {
        if (input.password) keyOk = wifiKeyMatches(page, current.domain, input.password);
        return parse(page);
      },
      verify: (after) => {
        const updated = after.find((n) => n.domain === current.domain);
        return updated &&
          keyOk &&
          updated.ssid === input.ssid &&
          updated.enabled === input.enabled &&
          updated.visible === input.visible &&
          updated.security === input.security
          ? { network: updated }
          : null;
      },
      adminId,
      context,
      details: {
        before: before.find((n) => n.domain === current.domain),
        requested: redact(input),
      },
    });
  }
}

/** The router refuses two networks with the same name on one band. */
function checkName(ssid: string, band: string, networks: WifiNetwork[], except?: string) {
  if (networks.some((n) => n.band === band && n.ssid === ssid && n.domain !== except)) {
    throw refuse(`A ${band} network named “${ssid}” exists`);
  }
}

function parse(page: string): WifiNetwork[] {
  const networks = parseWifiNetworks(page);
  if (!networks) throw new AppError(ErrorCode.ROUTER_UNAVAILABLE, 502, 'Wi-Fi page not found');
  return networks;
}
