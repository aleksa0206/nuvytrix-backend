/**
 * Parsing of the Huawei HN8546X6 web pages. The router renders data as JavaScript constructor calls
 * such as `new stOpticInfo("InternetGatewayDevice...","ok"," 3.59",...)` with `\xNN` escapes.
 * Everything here reads those calls as text: nothing is evaluated.
 * Format reference: docs/huawei/api-endpoint-inventory.md
 */

/** Decodes the escapes Huawei uses inside JavaScript string literals. */
export function unescapeJs(text: string): string {
  return text.replace(/\\(x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|.)/g, (_match, code: string) => {
    if (code[0] === 'x' || code[0] === 'u') return String.fromCharCode(parseInt(code.slice(1), 16));
    if (code === 'n') return '\n';
    if (code === 'r') return '\r';
    if (code === 't') return '\t';
    return code;
  });
}

/**
 * Returns the string arguments of every `new <name>(...)` call. Non-string arguments are skipped;
 * the router only passes strings to its data constructors.
 */
export function parseConstructorCalls(text: string, name: string): string[][] {
  const calls: string[][] = [];
  const marker = new RegExp(`new\\s+${name}\\s*\\(`, 'g');
  let match: RegExpExecArray | null;
  while ((match = marker.exec(text)) !== null) {
    const args: string[] = [];
    let i = match.index + match[0].length;
    let depth = 1;
    while (i < text.length && depth > 0) {
      const char = text[i]!;
      if (char === '"' || char === "'") {
        let j = i + 1;
        let raw = '';
        while (j < text.length && text[j] !== char) {
          if (text[j] === '\\' && j + 1 < text.length) {
            raw += text[j]! + text[j + 1]!;
            j += 2;
          } else {
            raw += text[j]!;
            j++;
          }
        }
        args.push(unescapeJs(raw));
        i = j + 1;
        continue;
      }
      if (char === '(') depth++;
      if (char === ')') depth--;
      i++;
    }
    calls.push(args);
    marker.lastIndex = i;
  }
  return calls;
}

/** Value of `var <name> = '<value>';`, or null. */
export function parseStringVar(text: string, name: string): string | null {
  const match = new RegExp(`var\\s+${name}\\s*=\\s*(['"])((?:\\\\.|(?!\\1).)*)\\1`).exec(text);
  return match ? unescapeJs(match[2]!) : null;
}

/** The firewall log the page writes into its textarea. */
export function parseFirewallLogText(text: string): string | null {
  const match = /getElementById\(\s*["']logarea["']\s*\)\.value\s*=\s*'((?:\\.|[^'\\])*)'/.exec(
    text
  );
  return match ? unescapeJs(match[1]!) : null;
}

/** Drops the device header (manufacturer, serial, WAN IP...) that precedes the log lines. */
export function stripFirewallLogHeader(log: string): string {
  const lines = log.split(/\r?\n/);
  const first = lines.findIndex((line) =>
    /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}/.test(line.trim())
  );
  return first === -1 ? '' : lines.slice(first).join('\n');
}

/** True when the router answered with its login redirect instead of the requested page. */
export function isLoginPage(text: string): boolean {
  return text.length < 4000 && /login\.asp/i.test(text) && !/new\s+st\w+\(/.test(text);
}

export function parseOnttoken(text: string): string | null {
  const match = /id=["']h?w?onttoken["'][^>]*value=["']([0-9a-fA-F]+)["']/.exec(text);
  return match ? match[1]! : null;
}

const toNumber = (value: string | undefined): number | null => {
  if (value === undefined) return null;
  const parsed = Number(value.trim());
  return value.trim() === '' || value.trim() === '--' || Number.isNaN(parsed) ? null : parsed;
};

/** Combines the low and high 32-bit words the router splits 64-bit counters into. */
const counter64 = (low: string | undefined, high: string | undefined): number =>
  (toNumber(high) ?? 0) * 2 ** 32 + (toNumber(low) ?? 0);

// ---------------------------------------------------------------------------- sections

export interface RouterSystemInfo {
  model: string;
  hardwareVersion: string;
  softwareVersion: string;
  description: string;
  uptimeSeconds: number | null;
  cpuPercent: number | null;
  memoryPercent: number | null;
  ontRegistrationState: string | null;
}

/** deviceinfo.asp. The serial number, MAC and manufacture info are deliberately not read. */
export function parseSystemInfo(page: string): RouterSystemInfo | null {
  const info = parseConstructorCalls(page, 'stDeviceInfo')[0];
  if (!info) return null;
  const ont = parseConstructorCalls(page, 'ONTInfo')[0];
  const percent = (value: string | null) =>
    value === null ? null : toNumber(value.replace('%', ''));
  return {
    model: info[4] ?? '',
    hardwareVersion: info[2] ?? '',
    softwareVersion: info[3] ?? '',
    description: info[8] ?? '',
    uptimeSeconds: toNumber(parseStringVar(page, 'dev_uptime') ?? undefined),
    cpuPercent: percent(parseStringVar(page, 'cpuUsed')),
    memoryPercent: percent(parseStringVar(page, 'memUsed')),
    ontRegistrationState: ont?.[2] ?? null,
  };
}

export interface OpticalInfo {
  linkStatus: string;
  txPowerDbm: number | null;
  rxPowerDbm: number | null;
  voltageMv: number | null;
  temperatureC: number | null;
  biasMa: number | null;
  vendor: string;
  txWavelengthNm: number | null;
  rxWavelengthNm: number | null;
  lossOfSignal: boolean;
  /** GPON interface byte counters (64-bit): all traffic to and from the internet. */
  ponBytesSent: number | null;
  ponBytesReceived: number | null;
}

/**
 * opticinfo.asp: `stOpticInfo` and the GPON interface `stStats(domain, ErrorsSent, ErrorsReceived,
 * DiscardPacketsReceived, BytesSent, BytesReceived, PacketsSent, PacketsReceived)`.
 * The module serial number (VendorSN) is not read.
 */
export function parseOptical(page: string): OpticalInfo | null {
  const o = parseConstructorCalls(page, 'stOpticInfo')[0];
  if (!o) return null;
  const stats = parseConstructorCalls(page, 'stStats').find((s) =>
    (s[0] ?? '').endsWith('.X_GponInterafceConfig.Stats')
  );
  return {
    linkStatus: (o[1] ?? '').trim(),
    txPowerDbm: toNumber(o[2]),
    rxPowerDbm: toNumber(o[3]),
    voltageMv: toNumber(o[4]),
    temperatureC: toNumber(o[5]),
    biasMa: toNumber(o[6]),
    vendor: (o[9] ?? '').trim(),
    txWavelengthNm: toNumber(o[12]),
    rxWavelengthNm: toNumber(o[13]),
    lossOfSignal: (o[15] ?? '0').trim() === '1',
    ponBytesSent: toNumber(stats?.[4]),
    ponBytesReceived: toNumber(stats?.[5]),
  };
}

export interface LanPort {
  port: number;
  linkUp: boolean;
  speedMbps: number | null;
  fullDuplex: boolean | null;
  bytesSent: number;
  bytesReceived: number;
  packetsSent: number;
  packetsReceived: number;
}

const SPEEDS: Record<string, number> = { '0': 10, '1': 100, '2': 1000, '3': 2500, '4': 10000 };

/**
 * ethinfo.asp: GEInfo (link) and LANStats (counters). The same page carries GPON registration
 * fields (stDevInfo); they are never read.
 */
export function parseLanPorts(page: string): LanPort[] | null {
  const links = parseConstructorCalls(page, 'GEInfo');
  if (links.length === 0) return null;
  const stats = new Map(
    parseConstructorCalls(page, 'LANStats').map((s) => [/LANPort\.(\d+)/.exec(s[0] ?? '')?.[1], s])
  );
  return links.map((link) => {
    const port = Number(/LANPort\.(\d+)/.exec(link[0] ?? '')?.[1] ?? 0);
    const s = stats.get(String(port));
    const up = link[3] === '1';
    return {
      port,
      linkUp: up,
      speedMbps: up ? (SPEEDS[link[2] ?? ''] ?? null) : null,
      fullDuplex: up ? link[1] === '1' : null,
      packetsSent: s ? counter64(s[1], s[2]) : 0,
      bytesSent: s ? counter64(s[3], s[4]) : 0,
      packetsReceived: s ? counter64(s[7], s[8]) : 0,
      bytesReceived: s ? counter64(s[9], s[10]) : 0,
    };
  });
}

export interface WlanInterface {
  instance: number;
  band: '2.4 GHz' | '5 GHz';
  enabled: boolean;
  ssid: string;
  channel: number | null;
  standard: string;
  transmitPowerPercent: number | null;
  bytesSent: number | null;
  bytesReceived: number | null;
  packetsSent: number | null;
  packetsReceived: number | null;
  errorsSent: number | null;
  errorsReceived: number | null;
}

const bandOf = (instance: number) => (instance <= 4 ? ('2.4 GHz' as const) : ('5 GHz' as const));

/** wlaninfo.asp. This page has no keys (those live in WlanBasic.asp, which is never requested). */
export function parseWlan(page: string): WlanInterface[] | null {
  const wlans = parseConstructorCalls(page, 'stWlan');
  if (wlans.length === 0) return null;
  const instanceOf = (domain: string | undefined) =>
    Number(/WLANConfiguration\.(\d+)/.exec(domain ?? '')?.[1] ?? 0);
  const packets = new Map(
    parseConstructorCalls(page, 'stPacketInfo').map((p) => [instanceOf(p[0]), p])
  );
  const errors = new Map(parseConstructorCalls(page, 'stStats').map((e) => [instanceOf(e[0]), e]));
  return wlans
    .filter((w) => w[1] === '1')
    .map((w) => {
      const instance = instanceOf(w[0]);
      const p = packets.get(instance);
      const e = errors.get(instance);
      return {
        instance,
        band: bandOf(instance),
        enabled: w[1] === '1',
        ssid: w[3] ?? '',
        channel: toNumber(w[13]),
        standard: w[15] ?? '',
        transmitPowerPercent: toNumber(w[18]),
        bytesSent: toNumber(p?.[1]),
        packetsSent: toNumber(p?.[2]),
        bytesReceived: toNumber(p?.[3]),
        packetsReceived: toNumber(p?.[4]),
        errorsSent: toNumber(e?.[1]),
        errorsReceived: toNumber(e?.[2]),
      };
    });
}

export interface WifiClient {
  macAddress: string;
  ipAddress: string | null;
  name: string | null;
  band: '2.4 GHz' | '5 GHz';
  connectedSeconds: number | null;
  rxRateMbps: number | null;
  txRateMbps: number | null;
  rssiDbm: number | null;
  noiseDbm: number | null;
  snrDb: number | null;
  signalQuality: number | null;
  standard: string;
  streams: string | null;
}

/** getassociateddeviceinfo.asp */
export function parseWifiClients(page: string): WifiClient[] {
  return parseConstructorCalls(page, 'stAssociatedDevice')
    .filter((c) => /^([0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}$/.test(c[1] ?? ''))
    .map((c) => ({
      macAddress: c[1]!.toLowerCase(),
      ipAddress: c[13] || null,
      name: c[14] || null,
      band: bandOf(Number(/WLANConfiguration\.(\d+)/.exec(c[0] ?? '')?.[1] ?? 1)),
      connectedSeconds: toNumber(c[2]),
      rxRateMbps: toNumber(c[3]),
      txRateMbps: toNumber(c[4]),
      rssiDbm: toNumber(c[5]),
      noiseDbm: toNumber(c[6]),
      snrDb: toNumber(c[7]),
      signalQuality: toNumber(c[8]),
      standard: c[9] ?? '',
      streams: c[15] || null,
    }));
}

export interface RouterDevice {
  macAddress: string;
  ipAddress: string | null;
  hostName: string | null;
  online: boolean;
  connection: 'ethernet' | 'wifi' | 'unknown';
  /** "LAN1".."LAN4", or "SSID1" (2.4 GHz) / "SSID5" (5 GHz). */
  port: string | null;
  addressSource: string | null;
  dhcpVendorClass: string | null;
  onlineDuration: string | null;
  leaseRemainingSeconds: number | null;
}

/** GetLanUserDevInfo.asp */
export function parseRouterDevices(page: string): RouterDevice[] {
  // The device page embeds the same list more than once; keep one entry per MAC.
  const seen = new Set<string>();
  return parseConstructorCalls(page, 'USERDevice')
    .filter((d) => /^([0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}$/.test(d[2] ?? ''))
    .filter((d) => {
      const mac = d[2]!.toLowerCase();
      if (seen.has(mac)) return false;
      seen.add(mac);
      return true;
    })
    .map((d) => ({
      macAddress: d[2]!.toLowerCase(),
      ipAddress: d[1] || null,
      port: d[3] || null,
      addressSource: d[4] || null,
      dhcpVendorClass: d[5] || null,
      online: (d[6] ?? '').toLowerCase() === 'online',
      connection: d[7] === 'ETH' ? 'ethernet' : d[7] === 'WIFI' ? 'wifi' : 'unknown',
      onlineDuration: d[8] || null,
      hostName: d[9] || null,
      leaseRemainingSeconds: toNumber(d[15]),
    }));
}

export interface IpFilterRule {
  /** TR-098 path of the rule, which identifies it on the router. */
  domain: string;
  name: string;
  priority: number | null;
  protocol: string;
  direction: string;
  sourceIpStart: string;
  sourceIpEnd: string;
  destIpStart: string;
  destIpEnd: string;
  action: string;
  lanTcpPorts: string;
  lanUdpPorts: string;
  wanTcpPorts: string;
  wanUdpPorts: string;
}

export interface IpFilterState {
  enabled: boolean;
  mode: 'blacklist' | 'whitelist' | 'hybrid' | 'unknown';
  firewallLevel: string | null;
  rules: IpFilterRule[];
}

const MODES = { '0': 'blacklist', '1': 'whitelist', '2': 'hybrid' } as const;

/** ipincoming.asp (IPv4 Filtering). Read only. */
export function parseIpFilter(page: string): IpFilterState | null {
  const state = parseConstructorCalls(page, 'stPortFilter')[0];
  if (!state) return null;
  return {
    enabled: state[1] === '1',
    mode: MODES[(state[2] ?? '') as keyof typeof MODES] ?? 'unknown',
    firewallLevel: state[3] || null,
    rules: parseConstructorCalls(page, 'stFilterIn')
      .filter((r) => /IpFilterIn\.\d+/.test(r[0] ?? ''))
      .map((r) => ({
        domain: r[0]!,
        priority: toNumber(r[1]),
        protocol: r[2] ?? '',
        direction: r[3] ?? '',
        sourceIpStart: r[4] ?? '',
        sourceIpEnd: r[5] ?? '',
        destIpStart: r[6] ?? '',
        destIpEnd: r[7] ?? '',
        action: r[8] ?? '',
        lanTcpPorts: r[9] ?? '',
        lanUdpPorts: r[10] ?? '',
        wanTcpPorts: r[11] ?? '',
        wanUdpPorts: r[12] ?? '',
        name: r[13] ?? '',
      })),
  };
}

export interface DhcpServerState {
  enabled: boolean;
  /** The router's LAN address and mask; the pool must stay inside this subnet. */
  lanIp: string;
  subnetMask: string;
  startIp: string;
  endIp: string;
  leaseSeconds: number;
  /** DNS servers handed out by DHCP; empty means the router itself. */
  dnsServers: string[];
}

/** dhcp2.asp (LAN > DHCP Server): the main pool. */
export function parseDhcpServer(page: string): DhcpServerState | null {
  const main = parseConstructorCalls(page, 'dhcpmainst').find((c) => c.length >= 19);
  const lan = parseConstructorCalls(page, 'stipaddr').find((c) =>
    /IPInterface\.1$/.test(c[0] ?? '')
  );
  if (!main || !lan) return null;
  const dns = main[16] || main[18] || '';
  return {
    enabled: main[1] === '1',
    lanIp: lan[2] ?? '',
    subnetMask: lan[3] ?? '',
    startIp: main[2] ?? '',
    endIp: main[3] ?? '',
    leaseSeconds: Number(main[4]),
    dnsServers: dns.split(',').filter(Boolean),
  };
}

export interface DhcpReservation {
  /** TR-098 path, which identifies the reservation on the router. */
  domain: string;
  enabled: boolean;
  ip: string;
  mac: string;
}

/** dhcpstatic.asp (LAN > DHCP Static IP). Null when the page is not the reservation page. */
export function parseDhcpReservations(page: string): DhcpReservation[] | null {
  if (!page.includes('function stDhcp')) return null;
  return parseConstructorCalls(page, 'stDhcp')
    .filter((r) => /DHCPStaticAddress\.\d+$/.test(r[0] ?? ''))
    .map((r) => ({
      domain: r[0]!,
      enabled: r[1] === '1',
      ip: r[2] ?? '',
      mac: (r[3] ?? '').toLowerCase(),
    }));
}

export interface MacFilterEntry {
  /** TR-098 path, which identifies the entry on the router. */
  domain: string;
  mac: string;
  name: string;
  /** Wi-Fi list only: the network the entry applies to, as the router names it (`SSID-1`). */
  ssid?: string;
}

export interface MacFilterState {
  enabled: boolean;
  mode: 'blacklist' | 'whitelist' | 'unknown';
  entries: MacFilterEntry[];
}

const MAC_MODES = { '0': 'blacklist', '1': 'whitelist' } as const;

/**
 * macfilter.asp (`stMacFilter(domain, MACAddress, DeviceAlias)`) and wlanmacfilter.asp
 * (`stMacFilter(domain, SSIDName, DeviceName, MACAddress)`). Null when the page is not one of them.
 */
export function parseMacFilter(page: string, kind: 'lan' | 'wifi'): MacFilterState | null {
  const enabled = parseStringVar(page, 'enableFilter');
  const mode = parseStringVar(page, 'Mode');
  if (enabled === null || mode === null || !page.includes('function stMacFilter')) return null;
  return {
    enabled: enabled === '1',
    mode: MAC_MODES[mode as keyof typeof MAC_MODES] ?? 'unknown',
    entries: parseConstructorCalls(page, 'stMacFilter')
      .filter((r) => /MacFilter\.\d+$/i.test(r[0] ?? ''))
      .map((r) =>
        kind === 'lan'
          ? { domain: r[0]!, mac: (r[1] ?? '').toLowerCase(), name: r[2] ?? '' }
          : { domain: r[0]!, ssid: r[1] ?? '', name: r[2] ?? '', mac: (r[3] ?? '').toLowerCase() }
      ),
  };
}

export interface PortMappingRange {
  /** TR-098 path of the port range (`…PortMapping.N.X_HW_Portlist.M`). */
  domain: string;
  protocol: string;
  /** `start` or `start:end`. */
  internalPort: string;
  externalPort: string;
  /** Source ports on the internet side; empty means any. */
  externalSourcePort: string;
}

export interface PortMappingRule {
  /** TR-098 path, which identifies the mapping on the router. */
  domain: string;
  enabled: boolean;
  name: string;
  internalHost: string;
  /** Internet hosts allowed to use the mapping; empty means any. */
  remoteHostStart: string;
  remoteHostEnd: string;
  ranges: PortMappingRange[];
}

/** portmappingnew.asp: `stPortMap` mappings and their `stPortMappingPortList` port ranges. */
export function parsePortMappings(page: string): PortMappingRule[] | null {
  if (!page.includes('function stPortMap(')) return null;
  const ranges = parseConstructorCalls(page, 'stPortMappingPortList').filter((r) =>
    /\.X_HW_Portlist\.\d+$/.test(r[0] ?? '')
  );
  return parseConstructorCalls(page, 'stPortMap')
    .filter((m) => /\.PortMapping\.\d+$/.test(m[0] ?? ''))
    .map((m) => ({
      domain: m[0]!,
      enabled: m[1] === '1',
      remoteHostStart: m[2] ?? '',
      remoteHostEnd: m[3] ?? '',
      internalHost: m[5] ?? '',
      name: m[6] ?? '',
      ranges: ranges
        .filter((r) => r[0]!.startsWith(`${m[0]}.X_HW_Portlist.`))
        .map((r) => ({
          domain: r[0]!,
          protocol: r[1] ?? '',
          internalPort: r[2] ?? '',
          externalPort: r[3] ?? '',
          externalSourcePort: r[4] ?? '',
        })),
    }));
}

/**
 * wan_list.asp: the routed IPv4 WAN connection that carries internet service, which is where the
 * router's own page creates port mappings. Reads only path, mode and services: the same page holds
 * WAN account fields that must never be copied.
 */
export function parseInternetWan(page: string): string | null {
  const wan = parseConstructorCalls(page, 'WanIP').find(
    (w) =>
      w[12] === 'IP_Routed' &&
      w[29] === '1' &&
      (w[25] ?? '').toUpperCase().includes('INTERNET') &&
      /^InternetGatewayDevice\.WANDevice\.\d+\.WANConnectionDevice\.\d+\.WANIPConnection\.\d+$/.test(
        w[0] ?? ''
      )
  );
  return wan?.[0] ?? null;
}

export interface DmzState {
  /** TR-098 path (`<WAN>.X_HW_DMZ`). */
  domain: string;
  enabled: boolean;
  host: string;
}

/** dmz.asp: `stDMZInfo(domain, DMZEnable, DMZHostIPAddress)`, one per WAN that has a DMZ host. */
export function parseDmz(page: string): DmzState[] | null {
  if (!page.includes('function stDMZInfo')) return null;
  return parseConstructorCalls(page, 'stDMZInfo')
    .filter((d) => /\.X_HW_DMZ$/.test(d[0] ?? ''))
    .map((d) => ({ domain: d[0]!, enabled: d[1] === '1', host: d[2] ?? '' }));
}

export interface PortTriggerRule {
  /** TR-098 path (`<WAN>.X_HW_PortTrigger.N`). */
  domain: string;
  enabled: boolean;
  triggerPortStart: number;
  triggerPortEnd: number;
  triggerProtocol: string;
  openPortStart: number;
  openPortEnd: number;
  openProtocol: string;
}

/** porttrigger.asp: `stPortTrigger(domain, Enable, TPort, TPortEnd, TProto, OPort, OPortEnd, OProto)`. */
export function parsePortTriggers(page: string): PortTriggerRule[] | null {
  if (!page.includes('function stPortTrigger')) return null;
  return parseConstructorCalls(page, 'stPortTrigger')
    .filter((t) => /\.X_HW_PortTrigger\.\d+$/.test(t[0] ?? ''))
    .map((t) => ({
      domain: t[0]!,
      enabled: t[1] === '1',
      triggerPortStart: Number(t[2]),
      triggerPortEnd: Number(t[3]),
      triggerProtocol: t[4] ?? '',
      openPortStart: Number(t[5]),
      openPortEnd: Number(t[6]),
      openProtocol: t[7] ?? '',
    }));
}

export type WifiSecurity = 'open' | 'wep' | 'wpa' | 'wpa2' | 'wpa-wpa2' | 'wpa3' | 'other';

export interface WifiNetwork {
  /** TR-098 path (`…WLANConfiguration.N`). */
  domain: string;
  instance: number;
  band: '2.4 GHz' | '5 GHz';
  enabled: boolean;
  ssid: string;
  /** False when the network name is not broadcast. */
  visible: boolean;
  security: WifiSecurity;
}

const SECURITY: Record<string, WifiSecurity> = {
  '11i': 'wpa2',
  WPAand11i: 'wpa-wpa2',
  WPA: 'wpa',
  WPA3: 'wpa3',
};

/**
 * WlanBasic.asp: `stWlan(domain, name, enable, ssid, wlHide, DeviceNum, wmmEnable, BeaconType,
 * BasicEncryptionModes, BasicAuthenticationMode, …)`. The page also holds Wi-Fi keys
 * (`stPreSharedKey`, `stWEPKey`, RADIUS key); this parser never reads them.
 */
export function parseWifiNetworks(page: string): WifiNetwork[] | null {
  if (!page.includes('function stWlan(')) return null;
  return parseConstructorCalls(page, 'stWlan')
    .filter((w) => /\.WLANConfiguration\.\d+$/.test(w[0] ?? ''))
    .map((w) => {
      const instance = Number(w[0]!.split('.').pop());
      const beacon = w[7] ?? '';
      const open = beacon === 'Basic' && (w[8] ?? 'None') === 'None';
      return {
        domain: w[0]!,
        instance,
        band: bandOf(instance),
        enabled: w[2] === '1',
        ssid: w[3] ?? '',
        visible: w[4] === '1',
        security: beacon === 'Basic' ? (open ? 'open' : 'wep') : (SECURITY[beacon] ?? 'other'),
      };
    });
}

/**
 * True when the network's WPA key equals `key`. The key on the page is compared here and
 * nowhere else; it is never returned.
 */
export function wifiKeyMatches(page: string, domain: string, key: string): boolean {
  const entry = parseConstructorCalls(page, 'stPreSharedKey').find(
    (k) => k[0] === `${domain}.PreSharedKey.1`
  );
  return !!entry && (entry[1] === key || entry[2] === key);
}

export type ParentalMode = 'block' | 'allow';

export interface ParentalPeriod {
  index: number;
  /** `HH:MM`. */
  start: string;
  end: string;
  /** 1 = Monday … 7 = Sunday. */
  days: number[];
}

export interface ParentalTemplate {
  index: number;
  name: string;
  timeEnabled: boolean;
  /** block: the periods are blocked; allow: access only during the periods. */
  timeMode: ParentalMode;
  urlEnabled: boolean;
  /** block: the URLs are blocked; allow: only the URLs are reachable. */
  urlMode: ParentalMode;
  periods: ParentalPeriod[];
  urls: { index: number; url: string }[];
}

export interface ParentalDevice {
  index: number;
  mac: string;
  description: string;
  template: number;
}

export interface ParentalState {
  templates: ParentalTemplate[];
  devices: ParentalDevice[];
}

const last = (domain: string) => Number(domain.split('.').pop());
const modeOf = (policy: string | undefined): ParentalMode => (policy === '1' ? 'allow' : 'block');

/**
 * parentalctrlinfo.asp: `TemplatesListClass(domain, Name, UrlFilterPolicy, UrlFilterRight,
 * StartDate, EndDate, DurationPolicy, DurationRight)`, `DurationListClass(domain, StartTime, EndTime,
 * RepeatDay)`, `UrlFilterUrlAddress(domain, url)`, `ChildListClass(domain, MAC, Description,
 * TemplateInst)`.
 */
export function parseParental(page: string): ParentalState | null {
  if (!page.includes('function TemplatesListClass')) return null;
  const under = (rows: string[][], prefix: string) =>
    rows.filter((r) => (r[0] ?? '').startsWith(prefix));
  const durations = parseConstructorCalls(page, 'DurationListClass');
  const urls = parseConstructorCalls(page, 'UrlFilterUrlAddress');
  return {
    templates: parseConstructorCalls(page, 'TemplatesListClass')
      .filter((t) => /\.Templates\.\d+$/.test(t[0] ?? ''))
      .map((t) => ({
        index: last(t[0]!),
        name: t[1] ?? '',
        urlMode: modeOf(t[2]),
        urlEnabled: t[3] === '1',
        timeMode: modeOf(t[6]),
        timeEnabled: t[7] === '1',
        periods: under(durations, `${t[0]}.Duration.`).map((d) => ({
          index: last(d[0]!),
          start: d[1] ?? '',
          end: d[2] ?? '',
          days: (d[3] ?? '').split(',').filter(Boolean).map(Number),
        })),
        urls: under(urls, `${t[0]}.UrlFilter.`).map((u) => ({
          index: last(u[0]!),
          url: u[1] ?? '',
        })),
      })),
    devices: parseConstructorCalls(page, 'ChildListClass')
      .filter((c) => /\.MAC\.\d+$/.test(c[0] ?? ''))
      .map((c) => ({
        index: last(c[0]!),
        mac: (c[1] ?? '').toLowerCase(),
        description: c[2] ?? '',
        template: Number(c[3]),
      })),
  };
}

export interface DnsHost {
  /** TR-098 path (`InternetGatewayDevice.X_HW_DNS.HOSTS.N`). */
  domain: string;
  index: number;
  name: string;
  ip: string;
}

/** dnshostslist.asp: `DnsHostsItemClass(domain, IPAddress, DomainName)`. */
export function parseDnsHosts(page: string): DnsHost[] | null {
  if (!page.includes('function DnsHostsItemClass')) return null;
  return parseConstructorCalls(page, 'DnsHostsItemClass')
    .filter((h) => /\.HOSTS\.\d+$/.test(h[0] ?? ''))
    .map((h) => ({ domain: h[0]!, index: last(h[0]!), ip: h[1] ?? '', name: h[2] ?? '' }));
}

export interface DdnsEntry {
  /** TR-098 path (`<WAN>.X_HW_DDNSConfiguration.N`). */
  domain: string;
  index: number;
  enabled: boolean;
  provider: string;
  username: string;
  port: number | null;
  /** The name kept up to date at the provider. */
  domainName: string;
  /** The provider's update server. */
  serverHost: string;
  status: string;
  lastError: string;
}

/**
 * ddns.asp: `stDdns(domain, Enable, Provider, Username, Port, DomainName, HostName, SaltAddress,
 * Status, LastError, LastUpdateTime)`. The page never contains the DDNS password.
 */
export function parseDdns(page: string): DdnsEntry[] | null {
  if (!page.includes('function stDdns')) return null;
  return parseConstructorCalls(page, 'stDdns')
    .filter((d) => /\.X_HW_DDNSConfiguration\.\d+$/.test(d[0] ?? ''))
    .map((d) => ({
      domain: d[0]!,
      index: last(d[0]!),
      enabled: d[1] === '1',
      provider: d[2] ?? '',
      username: d[3] ?? '',
      port: toNumber(d[4]),
      domainName: d[5] ?? '',
      serverHost: d[6] ?? '',
      status: d[8] ?? '',
      lastError: d[9] ?? '',
    }));
}

/** upnp.asp: `var enblMainUpnp` ('1' = on). Null when the page is not the UPnP page. */
export function parseUpnpEnabled(page: string): { enabled: boolean } | null {
  const main = parseStringVar(page, 'enblMainUpnp');
  if (main === null || !page.includes('function stUpnpPortMapping')) return null;
  return { enabled: main === '1' };
}

export interface WifiSchedule {
  /** While on, Wi-Fi is switched off during the periods. */
  enabled: boolean;
  periods: { start: string; end: string; days: number[] }[];
}

/**
 * WlanSchedule.asp: `var wlanSchecuelEnable = 0|1;` and `stDuration(domain, StartTime, EndTime,
 * RepeatDay)` for Duration.1–4. Empty periods are left out.
 */
export function parseWifiSchedule(page: string): WifiSchedule | null {
  const enabled = /var wlanSchecuelEnable = (\d+);/.exec(page);
  if (!enabled) return null;
  return {
    enabled: enabled[1] === '1',
    periods: parseConstructorCalls(page, 'stDuration')
      .filter((d) => /\.X_HW_WLANShutDownCtrl\.Duration\.\d+$/.test(d[0] ?? '') && d[1])
      .sort((a, b) => last(a[0]!) - last(b[0]!))
      .map((d) => ({
        start: d[1]!,
        end: d[2] ?? '',
        days: (d[3] ?? '').split(',').filter(Boolean).map(Number),
      })),
  };
}

export interface WifiRadio {
  /** The band's first network, which carries the radio settings (`…WLANConfiguration.N`). */
  domain: string;
  band: '2.4 GHz' | '5 GHz';
  /** The configured channel; 0 with automatic selection. */
  channel: number;
  autoChannel: boolean;
  /** Transmit power in percent. */
  power: number;
  standard: string;
  country: string;
  /** `X_HW_HT20` code: 0 auto 20/40, 1 20 MHz, 2 40 MHz, 3 auto 20/40/80, 4 160 MHz. */
  channelWidth: string;
}

/**
 * WlanBasic.asp: `stWlanWifi(domain, name, enable, ssid, mode, channel, power, Country,
 * AutoChannelEnable, channelWidth)`, one per radio. Holds no keys.
 */
export function parseWifiRadios(page: string): WifiRadio[] | null {
  if (!page.includes('function stWlanWifi(')) return null;
  return parseConstructorCalls(page, 'stWlanWifi')
    .filter((w) => /\.WLANConfiguration\.\d+$/.test(w[0] ?? ''))
    .map((w) => ({
      domain: w[0]!,
      band: bandOf(last(w[0]!)),
      channel: Number(w[5]),
      autoChannel: w[8] === '1',
      power: Number(w[6]),
      standard: w[4] ?? '',
      country: w[7] ?? '',
      channelWidth: w[9] ?? '',
    }));
}

/**
 * WlanBasic.asp: `stWpsPin(domain, X_HW_ConfigMethod, DevicePassword, X_HW_PinGenerator, Enable)`.
 * Returns only the network and whether WPS is on; the PIN (DevicePassword) is never read.
 */
export function parseWpsStates(page: string): Map<string, boolean> {
  return new Map(
    parseConstructorCalls(page, 'stWpsPin')
      .filter((w) => /\.WLANConfiguration\.\d+\.WPS$/.test(w[0] ?? ''))
      .map((w) => [w[0]!.replace(/\.WPS$/, ''), w[4] === '1'])
  );
}
