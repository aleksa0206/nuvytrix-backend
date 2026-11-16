import { z } from 'zod';
import { AppError } from '../../common/errors/AppError';
import { ErrorCode } from '../../common/errors/errorCodes';
import type { RequestContext } from '../auth/auth.types';
import { parseConstructorCalls, parseRouterDevices } from './huaweiParser';
import type { RouterWriter } from './routerWriter';

const OBJECT = 'InternetGatewayDevice.X_HW_Security.AclServices';
const refuse = (message: string) => new AppError(ErrorCode.ROUTER_WRITE_REFUSED, 422, message);

export const deviceAccessSchema = z.object({ httpFromWifi: z.boolean() });

export interface DeviceAccess {
  /** Whether devices on Wi-Fi may open the router's web interface. */
  httpFromWifi: boolean;
}

export interface RouterAccessSettings {
  /** Server and admin PC: they must be wired before web access from Wi-Fi is switched off. */
  protectedAddresses: string[];
}

/**
 * Security → Device Access Control (aclsmart.asp). For this account the router shows and accepts only
 * `HTTPWifiEnable`; Telnet and HTTP from the LAN are hidden, so a change here cannot lock wired
 * devices out. Request format: docs/huawei/device-access-control.md.
 */
export class RouterAccessService {
  constructor(
    private writer: RouterWriter,
    private settings: RouterAccessSettings
  ) {}

  get writesEnabled(): boolean {
    return this.writer.writesEnabled;
  }

  async getState(): Promise<DeviceAccess> {
    const { deviceAccess } = await this.writer.read(['deviceAccess'] as const);
    return parse(deviceAccess);
  }

  async change(input: DeviceAccess, adminId: number, context: RequestContext) {
    this.writer.requireWritable();
    const before = await this.getState();
    if (!input.httpFromWifi) {
      // Fail closed: switching Wi-Fi access off is only allowed when every protected address is
      // seen by the router on a cable, so Nuvytrix and the admin PC keep reaching the router.
      const { devices } = await this.writer.read(['devices'] as const);
      const list = parseRouterDevices(devices);
      const notWired = this.settings.protectedAddresses.find(
        (ip) => !list.some((d) => d.ipAddress === ip && d.connection === 'ethernet')
      );
      if (notWired) {
        throw refuse(
          `${notWired} (server or admin PC) is not seen on a cable; it could lose access to the router`
        );
      }
    }
    return this.writer.write({
      action: 'router.device_access_changed',
      entityType: 'router_device_access',
      form: {
        page: 'deviceAccess',
        action: 'set',
        object: OBJECT,
        fields: { 'x.HTTPWifiEnable': input.httpFromWifi ? '1' : '0' },
      },
      parse,
      verify: (after) => (after.httpFromWifi === input.httpFromWifi ? {} : null),
      adminId,
      context,
      details: { before, requested: input },
    });
  }
}

/** `stAclInfo(domain, TelnetLanEnable, HTTPWifiEnable, TELNETWifiEnable)` */
function parse(page: string): DeviceAccess {
  const info = parseConstructorCalls(page, 'stAclInfo').find((a) => a[0] === OBJECT);
  if (!info || !['0', '1'].includes(info[2] ?? '')) {
    throw new AppError(ErrorCode.ROUTER_UNAVAILABLE, 502, 'Device access settings not found');
  }
  return { httpFromWifi: info[2] === '1' };
}
