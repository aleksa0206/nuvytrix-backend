# Capability matrix

Statuses:

- **CONFIRMED**: fetched and parsed successfully on this router, useful.
- **DISCOVERED**: referenced in the UI code, not tested (usually because testing would change state).
- **PARTIALLY SUPPORTED**: some of the information is available.
- **UNSUPPORTED**: tested and not available.
- **UNKNOWN**: not enough evidence.

"Auth" means the administrator web session is required.

## System

| Capability | Status | Source | Auth |
| --- | --- | --- | --- |
| Model, hardware and software version, description, alias | CONFIRMED | `deviceinfo.asp` → `stDeviceInfo` | yes |
| Serial number, manufacture info | CONFIRMED (not stored) | `stDeviceInfo` | yes |
| Uptime (seconds) | CONFIRMED | `deviceinfo.asp` → `var dev_uptime` | yes |
| CPU and memory use (percent) | CONFIRMED | `deviceinfo.asp` → `var cpuUsed`, `var memUsed` | yes |
| Extended monitor (I/O wait, processes, load, total/free memory) | DISCOVERED | `MonitorData(...)` constructor exists, no data on this firmware | yes |
| ONT registration state (O1–O5) and ONT ID | CONFIRMED | `ONTInfo` (`X_HW_DEBUG.AMP.ONT`) | yes |
| User log (system events) | PARTIALLY SUPPORTED | text is loaded via `StartFileLoad.asp` + `logviewdown.cgi`; not fetched | yes |
| Configuration backup | DISCOVERED, deliberately not used | `cfgfileroot.asp` → download CGI; file contains secrets | yes |
| Reboot history | UNSUPPORTED | not present in any page | – |

## WAN / internet

| Capability | Status | Source | Auth |
| --- | --- | --- | --- |
| Connection status, uptime, last error | CONFIRMED | UPnP `WANIPConnection#GetStatusInfo` | no |
| External IPv4 address (CGNAT) | CONFIRMED | UPnP `GetExternalIPAddress` | no |
| NAT enabled | CONFIRMED | UPnP `GetNATRSIPStatus` | no |
| WAN bytes/packets sent and received | CONFIRMED | UPnP `WANCommonInterfaceConfig#GetTotal*` | no |
| WAN interface details (VLAN, DNS, gateway, lease, IPv6, AFTR) | DISCOVERED | `wan_list_info.asp`, `wanipv6state.asp`, `getwanlist.asp` | yes |
| PON packet counters | PARTIALLY SUPPORTED | `PONPackageInfo` present but empty on this unit | yes |
| GPON interface counters (bytes, errors, discards) | CONFIRMED | `opticinfo.asp` → `stStats` | yes |
| Link speed reported by UPnP | UNSUPPORTED (bogus) | reports 512 kbit/s, not the real line rate | no |

## LAN and devices

| Capability | Status | Source | Auth |
| --- | --- | --- | --- |
| Router's device list: IP, MAC, hostname, LAN port or SSID, ETH/WIFI, online state, online duration, DHCP lease remaining, address source, DHCP vendor class | CONFIRMED | `GetLanUserDevInfo.asp` → `USERDevice` | yes |
| DHCP hosts table | CONFIRMED | `GetLanUserDhcpInfo.asp` → `DHCPInfo` | yes |
| LAN address and mask | CONFIRMED | `stLanHostInfo` | yes |
| DHCP pool, static reservations | DISCOVERED | `dhcp2.asp`, `dhcpstatic.asp` | yes |
| Per-port link (up/down, 10M–10G, duplex) | CONFIRMED | `ethinfo.asp` → `GEInfo` | yes |
| Per-port byte/packet/error counters | CONFIRMED | `ethinfo.asp` → `LANStats` (64-bit as high/low pairs) | yes |
| ARP table | UNSUPPORTED | not exposed; the device list is the closest equivalent | – |

## Wi-Fi

| Capability | Status | Source | Auth |
| --- | --- | --- | --- |
| SSIDs, band, channel, standard, transmit power, enabled, client count | CONFIRMED | `wlaninfo.asp` → `stWlan` | yes |
| Per-SSID bytes/packets, errors, discards | CONFIRMED | `stPacketInfo`, `stStats` | yes |
| Per-client: MAC, IP, hostname, uptime, Rx/Tx rate, RSSI, noise, SNR, signal quality, standard, power save, antennas, 11k/11v, dual band | CONFIRMED | `getassociateddeviceinfo.asp` → `stAssociatedDevice` | yes |
| Neighbouring access points (SSID, BSSID, channel, RSSI, security) | DISCOVERED | `getneighbourAPinfo.asp`; scan is triggered by the UI | yes |
| Band steering policy | DISCOVERED | `StXHWGlobalConfig` | yes |
| Wi-Fi passwords, WPS PIN | present in `WlanBasic.asp` / `wifiCover.asp`, **never fetched by Nuvytrix** | – | yes |

## Optical

| Capability | Status | Source | Auth |
| --- | --- | --- | --- |
| Rx/Tx optical power (dBm), temperature (°C), supply voltage (mV), bias current (mA), link status, LOS | CONFIRMED | `opticinfo.asp` → `stOpticInfo` | yes |
| Module vendor, date code, wavelengths, max distance | CONFIRMED | `stOpticInfo` | yes |
| OLT Tx power, budget class | PARTIALLY SUPPORTED | `stOLTOpticInfo` (empty on this unit) | yes |
| History of optical readings | UNSUPPORTED on the router | Nuvytrix stores its own samples | – |

## Security

| Capability | Status | Source | Auth |
| --- | --- | --- | --- |
| Firewall log text | CONFIRMED | `firewalllogview.asp` embeds the full log in `logarea` | yes |
| Firewall log rule configuration (enabled, direction, action) | CONFIRMED | `stFirewallLogRules` | yes |
| IPv4 filter list and firewall level | CONFIRMED (read) | `ipincoming.asp` → `stFilterIn`, `stPortFilter` | yes |
| MAC filter, Wi-Fi MAC filter, parental control | CONFIRMED (read) | `macfilter.asp`, `wlanmacfilter.asp`, `parentalctrl*.asp` | yes |
| DMZ, port mapping, port trigger | CONFIRMED (read) | `dmz.asp`, `porttrigger.asp` | yes |
| Service access control (Telnet/HTTP from LAN/Wi-Fi) | CONFIRMED (read) | `aclsmart.asp` → `stAclInfo`, `newacl.asp` | yes |
| UPnP port mappings | CONFIRMED | UPnP `GetGenericPortMappingEntry` | no |
| Writing rules | DISCOVERED, not used | `add.cgi` / `set.cgi` / `del.cgi` form actions | yes |

## Protocols

See [network-protocols.md](network-protocols.md). Summary: HTTP (80) and UPnP IGD (49652) are
usable; Telnet (23) is open but not available to the administrator account; HTTPS on 37443 is an
undocumented Huawei service; SNMP, syslog, TFTP, NTP, NAT-PMP, mDNS and TR-069 on the LAN are closed.
