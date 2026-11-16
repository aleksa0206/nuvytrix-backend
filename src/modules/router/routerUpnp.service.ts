import { AppError } from '../../common/errors/AppError';
import { ErrorCode } from '../../common/errors/errorCodes';
import type { RequestContext } from '../auth/auth.types';
import { parseUpnpEnabled } from './huaweiParser';
import type { RouterWriter } from './routerWriter';

/**
 * The router's UPnP switch (Application → UPnP). The page sets the main and the secondary UPnP
 * service together. Nuvytrix reads WAN status and live port mappings over UPnP, so those parts of
 * monitoring stop while it is off. Request format: docs/huawei/upnp-management.md.
 */
export class RouterUpnpService {
  constructor(private writer: RouterWriter) {}

  get writesEnabled(): boolean {
    return this.writer.writesEnabled;
  }

  async getState() {
    const { upnp } = await this.writer.read(['upnp'] as const);
    return parse(upnp);
  }

  async setEnabled(enabled: boolean, adminId: number, context: RequestContext) {
    this.writer.requireWritable();
    const before = await this.getState();
    const value = enabled ? '1' : '0';
    return this.writer.write({
      action: 'router.upnp_changed',
      entityType: 'router_upnp',
      form: {
        page: 'upnp',
        action: 'set',
        object: 'InternetGatewayDevice.X_HW_MainUPnP',
        extraQuery: { y: 'InternetGatewayDevice.X_HW_SlvUPnP' },
        fields: { 'x.Enable': value, 'y.Enable': value },
      },
      parse,
      verify: (after) => (after.enabled === enabled ? {} : null),
      adminId,
      context,
      details: { before, requested: { enabled } },
    });
  }
}

function parse(page: string) {
  const state = parseUpnpEnabled(page);
  if (!state) throw new AppError(ErrorCode.ROUTER_UNAVAILABLE, 502, 'UPnP page not found');
  return state;
}
