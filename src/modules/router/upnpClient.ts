/**
 * UPnP IGD client for the router's standard, unauthenticated Get* actions. These are read-only by
 * definition in the IGD:1 specification. See docs/huawei/network-protocols.md.
 */

const WAN_COMMON = 'urn:schemas-upnp-org:service:WANCommonInterfaceConfig:1';
const WAN_IP = 'urn:schemas-upnp-org:service:WANIPConnection:1';
const MAX_MAPPINGS = 64;

export interface UpnpEndpoints {
  baseUrl: string;
  wanCommonControl: string;
  wanIpControl: string;
}

export interface WanStatus {
  connected: boolean;
  connectionStatus: string;
  uptimeSeconds: number | null;
  externalIp: string | null;
  natEnabled: boolean | null;
  bytesSent: number | null;
  bytesReceived: number | null;
  packetsSent: number | null;
  packetsReceived: number | null;
}

export interface PortMapping {
  externalPort: number;
  internalPort: number;
  internalClient: string;
  protocol: string;
  description: string;
  enabled: boolean;
  remoteHost: string;
  leaseSeconds: number;
}

export const HUAWEI_UPNP_DEFAULTS = {
  port: 49652,
  wanCommonControl: '/upnp/control/WANCommonIFC1',
  wanIpControl: '/upnp/control/WANIPConn1',
};

/** Values of <NewXxx> elements in a SOAP response; plain text, no XML library needed for this shape. */
export function parseSoapValues(xml: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const match of xml.matchAll(/<(New\w+)>([^<]*)<\/\1>/g)) {
    values[match[1]!] = match[2]!
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&');
  }
  return values;
}

export class UpnpClient {
  constructor(
    private endpoints: UpnpEndpoints,
    private timeoutMs = 5000
  ) {}

  async getWanStatus(): Promise<WanStatus> {
    const [status, ip, nat, sent, received, packetsSent, packetsReceived] = await Promise.all([
      this.call(WAN_IP, this.endpoints.wanIpControl, 'GetStatusInfo'),
      this.call(WAN_IP, this.endpoints.wanIpControl, 'GetExternalIPAddress').catch(() => ({})),
      this.call(WAN_IP, this.endpoints.wanIpControl, 'GetNATRSIPStatus').catch(() => ({})),
      this.call(WAN_COMMON, this.endpoints.wanCommonControl, 'GetTotalBytesSent').catch(() => ({})),
      this.call(WAN_COMMON, this.endpoints.wanCommonControl, 'GetTotalBytesReceived').catch(
        () => ({})
      ),
      this.call(WAN_COMMON, this.endpoints.wanCommonControl, 'GetTotalPacketsSent').catch(
        () => ({})
      ),
      this.call(WAN_COMMON, this.endpoints.wanCommonControl, 'GetTotalPacketsReceived').catch(
        () => ({})
      ),
    ]);
    const num = (value: string | undefined) =>
      value === undefined || value === '' || Number.isNaN(Number(value)) ? null : Number(value);
    const values = (record: Record<string, string>, key: string) => record[key];
    return {
      connected: status.NewConnectionStatus === 'Connected',
      connectionStatus: status.NewConnectionStatus ?? 'Unknown',
      uptimeSeconds: num(status.NewUptime),
      externalIp: values(ip as Record<string, string>, 'NewExternalIPAddress') || null,
      natEnabled:
        values(nat as Record<string, string>, 'NewNATEnabled') === undefined
          ? null
          : values(nat as Record<string, string>, 'NewNATEnabled') === '1',
      bytesSent: num(values(sent as Record<string, string>, 'NewTotalBytesSent')),
      bytesReceived: num(values(received as Record<string, string>, 'NewTotalBytesReceived')),
      packetsSent: num(values(packetsSent as Record<string, string>, 'NewTotalPacketsSent')),
      packetsReceived: num(
        values(packetsReceived as Record<string, string>, 'NewTotalPacketsReceived')
      ),
    };
  }

  /** Walks GetGenericPortMappingEntry until the router answers with a fault (end of list). */
  async getPortMappings(): Promise<PortMapping[]> {
    const mappings: PortMapping[] = [];
    for (let index = 0; index < MAX_MAPPINGS; index++) {
      let entry: Record<string, string>;
      try {
        entry = await this.call(
          WAN_IP,
          this.endpoints.wanIpControl,
          'GetGenericPortMappingEntry',
          `<NewPortMappingIndex>${index}</NewPortMappingIndex>`
        );
      } catch (err) {
        if (err instanceof SoapFaultError) break;
        throw err;
      }
      mappings.push({
        externalPort: Number(entry.NewExternalPort),
        internalPort: Number(entry.NewInternalPort),
        internalClient: entry.NewInternalClient ?? '',
        protocol: entry.NewProtocol ?? '',
        description: entry.NewPortMappingDescription ?? '',
        enabled: entry.NewEnabled === '1',
        remoteHost: entry.NewRemoteHost ?? '',
        leaseSeconds: Number(entry.NewLeaseDuration ?? 0),
      });
    }
    return mappings;
  }

  private async call(
    service: string,
    control: string,
    action: string,
    args = ''
  ): Promise<Record<string, string>> {
    const body =
      '<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" ' +
      's:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body>' +
      `<u:${action} xmlns:u="${service}">${args}</u:${action}></s:Body></s:Envelope>`;
    const response = await fetch(new URL(control, this.endpoints.baseUrl), {
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset="utf-8"',
        SOAPAction: `"${service}#${action}"`,
      },
      body,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await response.text();
    if (response.status === 500 && text.includes('Fault')) throw new SoapFaultError(action);
    if (!response.ok) throw new Error(`UPnP ${action} answered HTTP ${response.status}`);
    return parseSoapValues(text);
  }
}

export class SoapFaultError extends Error {}
