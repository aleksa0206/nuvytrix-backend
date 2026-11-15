# Endpoint inventory

## Response format

There is no JSON API. Data pages are ASP that render JavaScript like:

```js
var deviceInfo = new stDeviceInfo("InternetGatewayDevice.DeviceInfo","<serial>","1CF0.E","V5R020C00S287",...);
var UserDevinfo = new Array(new USERDevice("InternetGatewayDevice.LANDevice.1.X_HW_UserDev.1","192\x2e168\x2e100\x2e20","aa\x3abb\x3a...",...),null);
```

- Constructor names (`stDeviceInfo`, `USERDevice`, ...) and argument order are defined in the same
  page (`function stDeviceInfo(domain, SerialNumber, ...)`).
- The first argument is the TR-098 object path the values come from.
- Strings use `\xNN` escapes for `.`, `:`, `-`, spaces and so on.
- Arrays end with `null`.

Nuvytrix parses these with a small tokenizer for string literals; nothing is evaluated.

Common to every authenticated endpoint below:

- **Method:** GET
- **Auth:** session cookie from `/login.cgi` (see [authentication-and-sessions.md](authentication-and-sessions.md))
- **Unauthenticated response:** a short page that redirects to `/login.asp`
- **Classification:** read-only
- **Firmware dependency:** constructor names and argument order are tied to V5R020; expect changes on other firmware

## Endpoints used by Nuvytrix (CONFIRMED)

### Device information
- **URL:** `/html/ssmp/deviceinfo/deviceinfo.asp`
- **Data:** `stDeviceInfo(domain, SerialNumber, HardwareVersion, SoftwareVersion, ModelName, VendorID, ReleaseTime, Mac, Description, ManufactureInfo, DeviceAlias)`, `ONTInfo(domain, ONTID, Status)`, `var dev_uptime = '<seconds>'`, `var cpuUsed = '<n>%'`, `var memUsed = '<n>%'`
- **Sanitized example:** `cpuUsed = '3%'`, `memUsed = '39%'`, `dev_uptime = '94727'`, model `HN8546X6`, software `V5R020C00S287`
- **Use:** system health card and CPU/memory/uptime history. The serial number, MAC and manufacture info are discarded by the parser.

### Optical
- **URL:** `/html/amp/opticinfo/opticinfo.asp`
- **Data:** `stOpticInfo(domain, LinkStatus, transOpticPower, revOpticPower, voltage, temperature, bias, rfRxPower, rfOutputPower, VendorName, VendorSN, DateCode, TxWaveLength, RxWaveLength, MaxTxDistance, LosStatus)`; `stStats(domain, ErrorsSent, ErrorsReceived, DiscardPacketsReceived, BytesSent, BytesReceived, PacketsSent, PacketsReceived)` for the GPON interface
- **Sanitized example:** `"ok"," 3.59","-17.10","3376","52","26","--","--","HUAWEI","<module SN>","210605","1310","1490","20","0"`, which is Tx 3.59 dBm, Rx −17.10 dBm, 3376 mV, 52 °C, 26 mA, 1310/1490 nm, 20 km, LOS 0
- **Use:** optical health and trend. The module serial number is discarded.

### Ethernet ports
- **URL:** `/html/amp/ethinfo/ethinfo.asp`
- **Data:** `GEInfo(domain, Mode, Speed, Status)`, where Mode is 0 half or 1 full, Speed is 0=10M, 1=100M, 2=1G, 3=2.5G, 4=10G, and Status is 1 up. Counters: `LANStats(domain, txPackets, txPackets_H, txGoodBytes, txGoodBytes_H, txBadBytes, txBadBytes_H, rxPackets, rxPackets_H, rxGoodBytes, rxGoodBytes_H, rxBadBytes, rxBadBytes_H)`; each counter is split into low and high 32-bit words
- **Sanitized example:** port 1 `"1","2","1"` (full duplex, 1 Gbit/s, up); counters `"9600254","0","3656201063","1",...`, where tx bytes = 1×2³² + 3656201063
- **Caution:** the same page also embeds `stDevInfo(domain, serialnumber, devtype, loid, eponpwd, hexpassword)`, the GPON registration credentials. The parser only reads `GEInfo` and `LANStats`; the page body is never stored or logged.

### Wi-Fi radios and SSIDs
- **URL:** `/html/amp/wlaninfo/wlaninfo.asp`
- **Data:** `stWlan(domain, enable, name, ssid, BeaconType, ..., Channel, LowerLayers, X_HW_Standard, RegulatoryDomain, X_HW_HT20, TransmitPower, X_HW_ServiceEnable, wlHide, wmmEnable, DeviceNum, AutoChannelEnable)`, `stPacketInfo(domain, totalBytesSent, totalPacketsSent, totalBytesReceived, totalPacketsReceived)`, `stStats(domain, errorsSent, errorsReceived, discardPacketsSent, discardPacketsReceived)`
- **Sanitized example:** SSID instance 1 (2.4 GHz) on channel 7, `11ax`; instance 5 (5 GHz) on channel 36, `11ax`; bytes sent 2.87 GB / received 0.26 GB
- **Note:** no keys in this page (`WlanBasic.asp` has them and is never fetched).

### Wi-Fi clients
- **URL:** `/html/amp/wlaninfo/getassociateddeviceinfo.asp`
- **Data:** `stAssociatedDevice(domain, AssociatedDeviceMACAddress, X_HW_Uptime, X_HW_RxRate, X_HW_TxRate, X_HW_RSSI, X_HW_Noise, X_HW_SNR, X_HW_SingalQuality, X_HW_WorkingMode, X_HW_WMMStatus, X_HW_PSMode, X_HW_HighBandFlag, AssociatedDeviceIPAddress, HW_AssociatedDevicedescriptions, X_HW_AntennaNum, X_HW_11kSupported, X_HW_11vSupported, X_HW_DualBandSupported, X_HW_BeamFormingSupported)`
- **Sanitized example:** `"<MAC>","2223","68","195","-65","-91","26","29","11ax","4294967295","0","0","<IP>","iPhone","2*2","1","1","0","0"`, which is uptime 2223 s, Rx 68 / Tx 195 Mbit/s, RSSI −65 dBm, noise −91 dBm, SNR 26 dB, quality 29, 11ax, 2×2
- **Domain:** `WLANConfiguration.1` is 2.4 GHz and `.5` is 5 GHz

### Device list
- **URL:** `/html/bbsp/common/GetLanUserDevInfo.asp`
- **Data:** `USERDevice(Domain, IpAddr, MacAddr, Port, IpType, DevType, DevStatus, PortType, Time, HostName, IPv4Enabled, IPv6Enabled, DeviceType, UserDevAlias, UserSpecifiedDeviceType, LeaseTimeRemaining)`
- **Sanitized example:** `"<IP>","<MAC>","LAN1","DHCP","MSFT 5.0","Online","ETH","2:16","<hostname>","1","1","0","","0","56637"`
- **Fields:** `Port` is `LAN1`–`LAN4` or `SSID1`/`SSID5`. `DevType` is the DHCP vendor class. `Time` is the online duration as h:mm. `LeaseTimeRemaining` is in seconds.

### DHCP hosts
- **URL:** `/html/bbsp/common/GetLanUserDhcpInfo.asp`
- **Data:** `DHCPInfo(domain, name, ip, mac, remaintime, devtype, interfacetype, AddressSource)`
- **Use:** cross-check of the device list; the device list already carries the same fields.

### Firewall log
- **URL:** `/html/bbsp/firewalllog/firewalllogview.asp`
- **Data:** `document.getElementById("logarea").value = '<escaped text>'`. The text starts with a header (manufacturer, product class, serial, WAN IP, hardware and software versions), followed by log lines in the format Nuvytrix already imports (see the main README). `stFirewallLogRules(domain, Enable, Direction, Action)` lists the configured log rules.
- **Use:** automatic periodic import into the existing firewall pipeline. The header lines are rejected by the parser as non-events. Deduplication makes repeated imports of the same rolling log safe.

## Unauthenticated: UPnP IGD (CONFIRMED)

- **Description:** `http://192.168.100.1:49652/49652gatedesc.xml` (`Huawei IGD`, `Huawei EchoLife Series`)
- **Method:** SOAP over HTTP POST. These are standard *Get* actions, read-only by definition of the UPnP IGD:1 specification.

| Service, control URL | Action | Returns |
| --- | --- | --- |
| WANCommonInterfaceConfig:1, `/upnp/control/WANCommonIFC1` | `GetTotalBytesSent`, `GetTotalBytesReceived`, `GetTotalPacketsSent`, `GetTotalPacketsReceived` | WAN counters |
| | `GetCommonLinkProperties` | access type `Cable`, link `Up`, max bit rate (reports 512000, not meaningful) |
| WANIPConnection:1, `/upnp/control/WANIPConn1` | `GetStatusInfo` | `Connected`, last error, uptime seconds |
| | `GetExternalIPAddress` | CGNAT address |
| | `GetNATRSIPStatus` | NAT enabled |
| | `GetGenericPortMappingEntry(index)` | one UPnP mapping per index; error 713 after the last |

## Discovered but not used

| URL | Why not used |
| --- | --- |
| `/html/bbsp/common/wan_list_info.asp`, `getwanlist.asp`, `wanipv6state.asp` | rich WAN data (VLAN, DNS, lease, IPv6 prefix) but large and firmware-specific; UPnP covers the monitoring need |
| `/html/amp/wlaninfo/getneighbourAPinfo.asp` | neighbour list is only fresh after a scan, which the UI starts with a write |
| `/html/bbsp/maintenance/GetPingResult.asp`, `GetRouteResult.asp`, `GetPingDnsResult.asp` | only meaningful after starting a diagnostic (write) |
| `/html/ssmp/userlog/normallogview.asp` | log text needs `StartFileLoad.asp` + `logviewdown.cgi` |
| Configuration pages (`ipincoming.asp`, `macfilter.asp`, `dmz.asp`, `porttrigger.asp`, `upnp.asp`, `dhcp2.asp`, `dhcpstatic.asp`, `aclsmart.asp`) | readable, but not needed for monitoring yet; candidates for a read-only "router configuration" view |
| `/asp/GetRandCount.asp`, `/html/ssmp/common/GetRandToken.asp` | tokens; only the login flow uses the first |

## Never requested (configuration-changing or sensitive)

`login.cgi` was used once per session. Never requested: `set.cgi`, `add.cgi`, `del.cgi`,
`resetBoard.cgi`, `staticroute.cgi`, `logviewdown.cgi`, `downloadfile.cgi`, `MdfPwd*.cgi`,
`getCheckCode.cgi`, `reboot.asp`, `cfgfileroot.asp`, `CheckPwdNotLogin.asp`, and `WlanBasic.asp` /
`wifiCover.asp` (Wi-Fi keys).
