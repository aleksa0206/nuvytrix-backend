# WAN, LAN and DHCP

## WAN

| Information | Source | Status |
| --- | --- | --- |
| Connection status, uptime, last error | UPnP `GetStatusInfo` | CONFIRMED |
| External IPv4 | UPnP `GetExternalIPAddress`, which returns a 100.64.0.0/10 (CGNAT) address | CONFIRMED |
| NAT enabled | UPnP `GetNATRSIPStatus` | CONFIRMED |
| Bytes and packets sent/received | UPnP `WANCommonInterfaceConfig` | CONFIRMED |
| Access type, link state | UPnP `GetCommonLinkProperties` (`Cable`, `Up`) | CONFIRMED |
| WAN list: name, VLAN, connection type, IPv4 mode, DNS, gateway, lease, NAT, service list, MTU | `wan_list_info.asp` (`WanInfoInst` with ~150 fields) | DISCOVERED |
| IPv6 WAN: address, prefix, lifetimes, DNS, AFTR, default router, uptime | `wanipv6state.asp` (`IPv6WanInfo`, `IPv6AddressInfo`, `IPv6PrefixInfo`) | DISCOVERED |
| PON packet counters | `waninfo.asp` (`PONPackageInfo`), empty on this unit | PARTIALLY SUPPORTED |

UPnP counters come from the router's WAN interface and work without logging in, so they can be
sampled often. They reset when the WAN connection restarts. Nuvytrix stores deltas and treats a
decrease as a counter reset.

The UPnP max bit rate (512000) is a fixed placeholder and does not reflect the real line rate.

## LAN

| Information | Source | Status |
| --- | --- | --- |
| LAN address and mask | `stLanHostInfo` (`LANHostConfigManagement.IPInterface.1`) | CONFIRMED |
| Per-port link state, speed, duplex | `ethinfo.asp` → `GEInfo` | CONFIRMED |
| Per-port bytes, packets, bad bytes (64-bit) | `ethinfo.asp` → `LANStats` | CONFIRMED |
| Per-port error counters (undersize, FCS, collisions ...) | `IncorrectStats` model exists | DISCOVERED |
| Port VLAN / L3 mode | `topoinfo.asp` → `LanInfoClass` | DISCOVERED |

During the research only LAN1 was connected (1 Gbit/s, full duplex). LAN1 goes to the unmanaged
switch, so its counters are the combined traffic of every wired device behind the switch.

## DHCP

| Information | Source | Status |
| --- | --- | --- |
| Active leases: name, IP, MAC, time remaining, vendor class, interface, source | `GetLanUserDhcpInfo.asp` → `DHCPInfo` | CONFIRMED |
| Pool start/end, lease time, options | `dhcp2.asp` | DISCOVERED (read-only page) |
| Static reservations | `dhcpstatic.asp` → `stDhcp(domain, Enable, ipAddress, macAddress)` | DISCOVERED |
| DHCPv6 | `lanaddress.asp`, `dhcpstaticaddress.asp` | DISCOVERED |

## ARP

No ARP table is exposed. The router device list (IP + MAC + online state) serves the same purpose.
