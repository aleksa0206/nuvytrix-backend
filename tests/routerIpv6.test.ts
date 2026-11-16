import { describe, expect, it } from 'vitest';
import { parseIpv6Lan } from '../src/modules/router/routerIpv6.service';

const PAGE = `
var Temp2 = new Array(new Br0IPv6PrefixClass("InternetGatewayDevice.LANDevice.1.LANHostConfigManagement.X_HW_IPv6Interface.1.IPv6Prefix.1","br0\x5fprefix\x5f1","","\x3a\x3a\x2f64","WANDelegated","2001\x3adb8\x3a1\x3a\x3a\x2f64","950400","1209600"),null);
var Temp4 = new Array(new RaConfigInfoClass("InternetGatewayDevice.LANDevice.1.X_HW_RouterAdvertisement","0","1","Manual","1","1500"),null);
var Temp7 = new Array(new IPv6DNSConfigClass("InternetGatewayDevice.LANDevice.1.X_HW_IPv6Config","","HGWProxy","","fe80\x3a\x3a1"),null);
var DhcpV6SServer = new Array(new DhcpV6Server("InternetGatewayDevice.LANDevice.1.X_HW_DHCPv6.Server","1","0"),null);`;

describe('IPv6 LAN parser', () => {
  it('reads prefix, router advertisements, DHCPv6 server and DNS', () => {
    expect(parseIpv6Lan(PAGE)).toEqual({
      prefix: {
        prefix: '2001:db8:1::/64',
        mode: 'WANDelegated',
        preferredSeconds: 950400,
        validSeconds: 1209600,
      },
      routerAdvertisement: { enabled: true, managed: false, otherConfig: true, mtu: 1500 },
      dhcpv6Server: { enabled: true },
      dns: { mode: 'HGWProxy', servers: ['fe80::1'] },
    });
  });

  it('fails when the page holds no IPv6 data', () => {
    expect(() => parseIpv6Lan('<html></html>')).toThrow('IPv6 LAN settings not found');
  });
});
