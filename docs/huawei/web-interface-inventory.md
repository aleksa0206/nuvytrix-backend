# Web interface inventory

The menu is served by `/asp/getMenuArray.asp` as a JavaScript array of
`{ name, id, url, subMenus }`; URLs are relative to the web root. All pages below returned HTTP 200
for the administrator account. "Holds" lists the data embedded in the page; "Writes via" lists the
form action used by the page's buttons (never called during the research).

## Status (System Information)

| Menu | Page | Holds | Writes via |
| --- | --- | --- | --- |
| Home Page | `CustomApp/mainpage.asp` | overview tiles, repeater info model | – |
| One-Click Diagnosis | `html/ssmp/maintain/smartdiagnose.asp` | diagnosis results (polls `getSmartDiagnoseResult.asp`) | diagnosis start (CGI) |
| Device | `html/ssmp/deviceinfo/deviceinfo.asp` | model, versions, serial, uptime, CPU, memory, ONT state | alias (`set.cgi`) |
| WAN | `html/bbsp/waninfo/waninfo.asp` | WAN list, IPv4/IPv6 status, PON packets, LAN address | – |
| Optical | `html/amp/opticinfo/opticinfo.asp` | optical readings, GPON counters | CATV (`set.cgi`), `resetBoard.cgi` |
| Service Provisioning Status | `html/ssmp/bss/bssinfo.asp` | OLT/EMS/ACS provisioning flags | – |
| VoIP | `html/voip/status/voipmaintain.asp` | VoIP line state (no lines configured) | – |
| Eth Port | `html/amp/ethinfo/ethinfo.asp` | per-port link and counters, WAN Ethernet stats, **GPON auth fields** | – |
| WLAN | `html/amp/wlaninfo/wlaninfo.asp` | SSIDs, radio settings, per-SSID stats | neighbour scan, STA boost list |
| Home Network | `html/amp/wificoverinfo/wlancoverinfo.asp` | mesh/extender topology (no APs here) | – |
| Cloud Platform Status | `html/ssmp/osgiplugin/pluginstatusabroad.asp` | plugin status | – |
| User Device Information | `html/bbsp/userdevinfo/userdevinfo1.asp` | device list (via `GetLanUserDevInfo.asp`) | `del.cgi` (forget device) |

## Advanced

| Menu | Page | Holds |
| --- | --- | --- |
| WAN | `html/bbsp/wan/wan.asp` | WAN configuration (VLAN, mode, NAT, DNS) |
| LAN → LAN Host | `html/bbsp/dhcp/dhcp.asp` | LAN address, mask, secondary DHCP |
| LAN → DHCP Server | `html/bbsp/dhcpservercfg/dhcp2.asp` | pool, lease time, options |
| LAN → DHCP Static IP | `html/bbsp/dhcpstatic/dhcpstatic.asp` | reservations |
| LAN → DHCPv6 Server / Static IP | `html/bbsp/lanaddress/lanaddress.asp`, `dhcpstaticaddr/dhcpstaticaddress.asp` | IPv6 LAN |
| Security → IPv4 Filtering | `html/bbsp/ipincoming/ipincoming.asp` | filter mode, firewall level, rule list |
| Security → MAC Filtering | `html/bbsp/macfilter/macfilter.asp` | MAC list |
| Security → Wi-Fi MAC Filtering | `html/bbsp/wlanmacfilter/wlanmacfilter.asp` | per-SSID MAC list |
| Security → Parental Control | `html/bbsp/parentalctrl/parentalctrlstatus.asp` (+ `mac`, `template`, `url`, `time`) | templates and schedules |
| Security → Precise Device Access Control | `html/bbsp/portacl/newacl.asp` | per-device service ACL |
| Security → Device Access Control | `html/bbsp/acl/aclsmart.asp` | Telnet/HTTP from LAN and Wi-Fi |
| Forward Rules → DMZ | `html/bbsp/dmz/dmz.asp` | DMZ host |
| Forward Rules → IPv4 Port Mapping | `html/bbsp/portmapping/portmapping.asp` | port forwards |
| Forward Rules → Port Trigger | `html/bbsp/porttrigger/porttrigger.asp` | triggers |
| Application → USB, Media Sharing, DDNS, UPnP, Static DNS | `usbhost.asp`, `dlna.asp`, `ddns.asp`, `upnp.asp`, `dnshosts.asp` | service settings |
| WLAN → Basic / Advanced (2.4 and 5 GHz) | `html/amp/wlanbasic/WlanBasic.asp?2G/5G`, `wlanadv/WlanAdvance.asp` | radio settings, **Wi-Fi keys and WPS PIN** |
| WLAN → Automatic Wi-Fi Shutdown, Wi-Fi Coverage | `wifische/WlanSchedule.asp`, `wificovercfg/wifiCover.asp` | schedules; mesh config **with keys** |
| System Management → Account, ONT Authentication, Open Source Software | `account.asp`, `ontauth/passwordcommon.asp`, `softnotice/opensfnotice.asp` | accounts (no password values), notices |
| Maintenance Diagnosis → Configuration File | `html/ssmp/cfgfile/cfgfileroot.asp` | **skipped** (configuration download) |
| Maintenance Diagnosis → Maintenance | `html/bbsp/maintenance/diagnosecommon.asp` | ping/traceroute/nslookup forms; results via `GetPingResult.asp`, `GetRouteResult.asp`, `GetPingDnsResult.asp` |
| Maintenance Diagnosis → User Log | `html/ssmp/userlog/normallogview.asp` | log is loaded by a download CGI |
| Maintenance Diagnosis → Firewall Log | `html/bbsp/firewalllog/firewalllogview.asp` | **full firewall log text** and log rules |
| Maintenance Diagnosis → Indicator Status | `html/ssmp/ledcfg/ledcfg.asp` | LED settings |
| Maintenance Diagnosis → Reboot | `html/ssmp/reboot/reboot.asp` | **skipped** |
| Bundle → Bundle Information | `html/ssmp/smartontinfo/bundlestatus.asp` | firmware bundle state |

## Helper pages discovered through the crawl

Loaded by the pages above (not in the menu): `GetLanUserDevInfo.asp`, `GetLanUserDhcpInfo.asp`,
`lanuserinfo.asp`, `topoinfo.asp`, `ontstate.asp`, `wanipv6state.asp`, `getwanlist.asp`,
`wan_list_info.asp`, `managemode.asp`, `getassociateddeviceinfo.asp`, `getneighbourAPinfo.asp`,
`apssidStat.asp`, `apssidStation.asp`, `apNeighborList.asp`, `getTopoInfo.asp`,
`getSmartDiagnoseResult.asp`, `getEquipTestResult*.asp`, `GetRandToken.asp`, `GetDeviceState.asp`.
Page-specific ones are listed in [api-endpoint-inventory.md](api-endpoint-inventory.md).
