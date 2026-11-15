# Connected devices

## What the router knows

`GetLanUserDevInfo.asp` returns one `USERDevice` per device the router has seen, online or offline.
This is the most complete source.

| Field | Meaning | Example (sanitized) |
| --- | --- | --- |
| `Domain` | TR-098 path, `LANDevice.1.X_HW_UserDev.{n}` | `...X_HW_UserDev.4` |
| `IpAddr` | current IPv4 | `<IP>` |
| `MacAddr` | MAC | `<MAC>` |
| `Port` | where it connects: `LAN1`–`LAN4`, `SSID1` (2.4 GHz), `SSID5` (5 GHz) | `LAN1` |
| `IpType` | address source | `DHCP` or `Static` |
| `DevType` | DHCP option 60 vendor class | `MSFT 5.0` (Windows), `android-dhcp-14` |
| `DevStatus` | `Online` / `Offline` | `Online` |
| `PortType` | `ETH` / `WIFI` | `WIFI` |
| `Time` | online duration, `h:mm` | `12:51` |
| `HostName` | DHCP hostname | `<hostname>` |
| `IPv4Enabled`, `IPv6Enabled` | flags | `1`, `1` |
| `DeviceType` | router's own classification code | `0` |
| `UserDevAlias` | alias set in the router UI | empty |
| `UserSpecifiedDeviceType` | type set in the router UI | `0` |
| `LeaseTimeRemaining` | DHCP lease left, seconds | `56637` |

On this network the list contained every LAN and Wi-Fi client, including the Ubuntu server. Hostname
coverage is better than nmap's, because the router learns names from DHCP requests.

## Compared with nmap discovery

| Information | nmap (Nuvytrix discovery) | Router device list |
| --- | --- | --- |
| IP, MAC | yes (ARP) | yes |
| Vendor (OUI) | yes | no (vendor class only) |
| Hostname | only with reverse DNS | yes, from DHCP |
| Ethernet port / SSID | no | yes |
| Wired or Wi-Fi | no | yes |
| Offline devices | only as "not seen" | listed with `Offline` |
| Online duration, lease | no | yes |
| IPv6 addresses | no | `X_HW_UserDev.{n}.IPv6Address` exists (not parsed) |

Nuvytrix keeps nmap as the discovery engine. The router list is merged in by MAC address to add
the hostname, connection (port or SSID) and Wi-Fi radio data.

## Wi-Fi specific

For wireless devices `getassociateddeviceinfo.asp` adds RSSI, noise, SNR, Rx/Tx rate, standard,
power-save state, antenna count and 11k/11v/dual-band support. See [wifi-capabilities.md](wifi-capabilities.md).

## Not available

- Per-device traffic counters. The router has none in any page; only per-port and per-SSID totals exist.
- First-seen timestamp from the router. Nuvytrix records its own.
- Device fingerprinting beyond the DHCP vendor class.
