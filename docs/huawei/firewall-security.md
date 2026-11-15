# Firewall and security

## Firewall log

The Firewall Log page (`/html/bbsp/firewalllog/firewalllogview.asp`) writes the whole current log
into its textarea from an inline script:

```js
document.getElementById("logarea").value = 'Manufacturer\x3a...\x0d\x0a...<log lines>';
```

After unescaping, the text has a short device header followed by event lines:

```
Manufacturer:<...>;
ProductClass:HN8546X6;
SerialNumber:<SN>;
IP:<WAN IP>;
HWVer:1CF0.E;
SWVer:V5R020C00S287;
...
2026-11-15 10:51:28 [Notice] IN=Internet_DHCP OUT=LocalNetwork Direction=Public->Private Action=Deny SRC=<IPv6> DST=<IPv6> PROTO=TCP SPT=443 DPT=60514
```

- It is the same format as the downloaded log file, so the existing parser handles it. Header
  lines are rejected as "Line does not start with a timestamp".
- The log is a rolling buffer (48 lines at the time of the research), so it must be read regularly
  to avoid gaps. Nuvytrix polls it on an interval. Repeated reads are deduplicated by the existing
  `(line hash, occurrence)` key.
- `stFirewallLogRules(domain, Enable, Direction, Action)` shows which directions are logged.
  Nuvytrix reads this and never changes it.

## Filters and policies (read-only)

| Feature | Page / model | Notes |
| --- | --- | --- |
| IPv4 filtering | `ipincoming.asp` → `stPortFilter(domain, ipFilterInRight, ipFilterInPolicy, FirewallLevel)`, `stFilterIn(Domain, Priority, Protocol, Direction, SourceIPStart, SourceIPEnd, DestIPStart, DestIPEnd, Action, lanTcpPort, lanUdpPort, wanTcpPort, wanUdpPort, Name)` | filter disabled, blacklist mode, no rules at research time |
| MAC filtering | `macfilter.asp` → `stMacFilter(domain, MACAddress, DeviceAlias)` | |
| Wi-Fi MAC filtering | `wlanmacfilter.asp` → `stMacFilter(domain, SSIDName, DeviceName, MACAddress)` | |
| Parental control | `parentalctrl*.asp` | templates, URL lists, schedules |
| Device access control | `aclsmart.asp` → `stAclInfo(domain, TelnetLanEnable, HTTPWifiEnable, TELNETWifiEnable)` | shows whether Telnet is allowed from LAN |
| Precise device ACL | `newacl.asp` → `stNewDeviceAcl(...)` | |
| DMZ | `dmz.asp` → `stDMZInfo(domain, DMZEnable, DMZHostIPAddress, flag)` | |
| Port mapping | `portmapping.asp`, `dmz.asp` → `stPortMappingPortList` | |
| Port trigger | `porttrigger.asp` → `stPortTrigger` | |
| UPnP | `upnp.asp` → `stUpnpPortMapping`; live mappings via UPnP SOAP | |

Reading these pages makes a "configured on the router" view possible: Nuvytrix could show the real
IPv4 filter list next to its own planned rules. That is listed as a next step in the
[implementation plan](implementation-plan.md).

## Writing rules

The UI writes through `add.cgi`, `set.cgi` and `del.cgi` with a per-page `onttoken`. These were
**not** called. Automating them is technically possible but undocumented and firmware-specific.
A wrong request could lock the administrator out or disable the firewall, so it stays out of scope
until there is explicit sign-off and a test plan.

## Findings

- **UPnP is enabled** and a client (AnyDesk) opened TCP 40628 → `<LAN host>`:7070 through it. CGNAT
  makes it unreachable over IPv4 from the internet, but IPv6 and the ISP's own network are separate
  questions. Nuvytrix lists UPnP mappings so these are visible.
- **Telnet is open to the LAN** (port 23). The administrator account is refused there. Unless the
  ISP needs it, consider restricting it in Device Access Control.
- **Secrets are rendered into pages**: Wi-Fi keys and the WPS PIN (`WlanBasic.asp`, `wifiCover.asp`)
  and GPON registration fields (`ethinfo.asp`). Anyone with the web password can read them, which
  is a reason to keep that password strong and private.
