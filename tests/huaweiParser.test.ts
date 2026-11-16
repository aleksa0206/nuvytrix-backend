import { describe, expect, it } from 'vitest';
import {
  isLoginPage,
  parseConstructorCalls,
  parseFirewallLogText,
  parseIpFilter,
  parseLanPorts,
  parseOnttoken,
  parseOptical,
  parseRouterDevices,
  parseSystemInfo,
  parseWifiClients,
  parseWlan,
  stripFirewallLogHeader,
  unescapeJs,
} from '../src/modules/router/huaweiParser';
import {
  DEVICES_PAGE,
  DEVICE_INFO_PAGE,
  ETH_PAGE,
  FIREWALL_LOG_PAGE,
  IP_FILTER_PAGE,
  LOGIN_REDIRECT_PAGE,
  OPTIC_PAGE,
  WIFI_CLIENTS_PAGE,
  WLAN_PAGE,
} from './fixtures/huawei';

describe('huawei page parsing', () => {
  it('unescapes \\xNN sequences without evaluating anything', () => {
    expect(unescapeJs('192\\x2e168\\x2e100\\x2e1')).toBe('192.168.100.1');
    expect(unescapeJs('a\\x3ab\\x20c\\\\d')).toBe('a:b c\\d');
  });

  it('reads constructor string arguments, including quotes and parentheses inside strings', () => {
    const calls = parseConstructorCalls(
      'x = new Item("a(b)","c\\"d",\'e\'), new Item("f"); new Other("g");',
      'Item'
    );
    expect(calls).toEqual([['a(b)', 'c"d', 'e'], ['f']]);
  });

  it('never parses code: a constructor argument that looks like code stays a string', () => {
    const calls = parseConstructorCalls('new Item("alert(1)");', 'Item');
    expect(calls).toEqual([['alert(1)']]);
  });

  it('reads system information without the serial number', () => {
    const info = parseSystemInfo(DEVICE_INFO_PAGE)!;
    expect(info).toEqual({
      model: 'HN8546X6',
      hardwareVersion: '1CF0.E',
      softwareVersion: 'V5R020C00S287',
      description: 'OptiXstar HN8546X6 XG-PON',
      uptimeSeconds: 94727,
      cpuPercent: 3,
      memoryPercent: 39,
      ontRegistrationState: 'O5',
    });
    expect(JSON.stringify(info)).not.toContain('NOT-STORED');
  });

  it('reads optical readings without the module serial', () => {
    const optical = parseOptical(OPTIC_PAGE)!;
    expect(optical).toMatchObject({
      linkStatus: 'ok',
      txPowerDbm: 3.59,
      rxPowerDbm: -17.1,
      voltageMv: 3376,
      temperatureC: 52,
      biasMa: 26,
      vendor: 'HUAWEI',
      txWavelengthNm: 1310,
      rxWavelengthNm: 1490,
      lossOfSignal: false,
      ponBytesSent: 4507039328,
      ponBytesReceived: 35770381452,
    });
    expect(JSON.stringify(optical)).not.toContain('SECRET');
  });

  it('combines 64-bit port counters and never reads GPON credentials from the same page', () => {
    const ports = parseLanPorts(ETH_PAGE)!;
    expect(ports[0]).toEqual({
      port: 1,
      linkUp: true,
      speedMbps: 1000,
      fullDuplex: true,
      packetsSent: 9600254,
      bytesSent: 2 ** 32 + 3656201063,
      packetsReceived: 6379331,
      bytesReceived: 3079905226,
    });
    expect(ports[1]).toMatchObject({ port: 2, linkUp: false, speedMbps: null, fullDuplex: null });
    expect(JSON.stringify(ports)).not.toContain('SECRET');
  });

  it('reads enabled SSIDs with band and counters', () => {
    const wlan = parseWlan(WLAN_PAGE)!;
    expect(wlan.map((w) => [w.instance, w.band, w.ssid, w.channel])).toEqual([
      [1, '2.4 GHz', 'Home Net', 7],
      [5, '5 GHz', 'Home Net 5g', 36],
    ]);
    expect(wlan[0]).toMatchObject({ bytesSent: 2869159692, errorsReceived: 2 });
  });

  it('reads Wi-Fi client radio data', () => {
    expect(parseWifiClients(WIFI_CLIENTS_PAGE)).toEqual([
      {
        macAddress: 'aa:bb:cc:00:00:31',
        ipAddress: '192.168.100.31',
        name: 'iPhone',
        band: '5 GHz',
        connectedSeconds: 2223,
        rxRateMbps: 68,
        txRateMbps: 195,
        rssiDbm: -65,
        noiseDbm: -91,
        snrDb: 26,
        signalQuality: 29,
        standard: '11ax',
        streams: '2*2',
      },
    ]);
  });

  it('reads the router device list with connection details', () => {
    const devices = parseRouterDevices(DEVICES_PAGE);
    expect(devices).toHaveLength(3);
    expect(devices[0]).toEqual({
      macAddress: 'aa:bb:cc:00:00:20',
      ipAddress: '192.168.100.20',
      port: 'LAN1',
      addressSource: 'DHCP',
      dhcpVendorClass: 'MSFT 5.0',
      online: true,
      connection: 'ethernet',
      onlineDuration: '2:16',
      hostName: 'desktop',
      leaseRemainingSeconds: 56637,
    });
    expect(devices[2]).toMatchObject({
      online: false,
      connection: 'wifi',
      leaseRemainingSeconds: null,
    });
  });

  it('keeps one entry per MAC when the page repeats the device list', () => {
    expect(parseRouterDevices(DEVICES_PAGE + DEVICES_PAGE)).toHaveLength(3);
  });

  it('reads the IPv4 filter state and rules', () => {
    expect(parseIpFilter(IP_FILTER_PAGE)).toEqual({
      enabled: true,
      mode: 'blacklist',
      firewallLevel: 'Custom',
      rules: [
        {
          domain: 'InternetGatewayDevice.X_HW_Security.IpFilterIn.3',
          priority: null,
          protocol: 'TCP',
          direction: 'Downstream',
          sourceIpStart: '192.168.100.250',
          sourceIpEnd: '',
          destIpStart: '',
          destIpEnd: '',
          action: '',
          lanTcpPorts: '',
          lanUdpPorts: '',
          wanTcpPorts: '',
          wanUdpPorts: '',
          name: 'Block test',
        },
      ],
    });
    expect(parseOnttoken(IP_FILTER_PAGE)).toBe('10403e71ab7741169fd252b637f4efbb');
  });

  it('extracts the firewall log and drops the device header', () => {
    const text = parseFirewallLogText(FIREWALL_LOG_PAGE)!;
    expect(text).toContain('SerialNumber:SECRET');
    const log = stripFirewallLogHeader(text);
    expect(log).not.toContain('SECRET');
    expect(log.trim()).toMatch(/^2026-11-15 10:51:28 \[Notice\] IN=Internet_DHCP .* DPT=60514$/);
  });

  it('returns null for a missing section instead of guessing', () => {
    expect(parseOptical('<html>changed firmware</html>')).toBeNull();
    expect(parseSystemInfo('')).toBeNull();
    expect(parseFirewallLogText('')).toBeNull();
    expect(stripFirewallLogHeader('Manufacturer:x;\nSerialNumber:y;')).toBe('');
  });

  it('recognises the login redirect returned for an expired session', () => {
    expect(isLoginPage(LOGIN_REDIRECT_PAGE)).toBe(true);
    expect(isLoginPage(DEVICE_INFO_PAGE)).toBe(false);
  });
});
