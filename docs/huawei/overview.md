# Huawei HN8546X6: research overview

Investigation of what Nuvytrix can read from the home router, done on 2026-11-15 against the
router on the LAN. Everything here was observed on this device; nothing is taken from other
models or forum posts unless marked otherwise.

| | |
| --- | --- |
| Model | Huawei OptiXstar HN8546X6 (XG-PON ONT with router, 4×GE LAN, 2.4 + 5 GHz Wi-Fi 6) |
| Hardware | 1CF0.E |
| Software | V5R020C00S287 (UI build 2021-09-29) |
| OS hint | Linux 4.4.197 (from the UPnP `SERVER` header) |
| Config mode | `COMMON` (no CAPTCHA at login) |
| LAN address | 192.168.100.1/24 |

## How the research was done

1. **Unauthenticated look**: the login page and the scripts it loads, to learn the login flow.
2. **Port and protocol probes** from the server (TCP and UDP), plus standard read-only queries for
   SSDP/UPnP, mDNS and NAT-PMP.
3. **One authenticated, read-only crawl** of the web UI with the administrator's own account:
   the menu (`/asp/getMenuArray.asp`) was used as the starting list and every page was fetched with
   GET only. A deny-list kept anything that could change state from ever being requested (all
   `*.cgi` except login, reboot, restore, upgrade, configuration download, diagnostics start, WPS,
   password checks). 119 pages were fetched, 26 were skipped by the deny-list, and the session was
   logged out at the end.
4. **Offline analysis** of the saved pages: data constructors, TR-098 object paths, AJAX URLs and
   form actions. Raw pages stayed on the server (directory mode 700) and were deleted afterwards
   because some contain secrets (see [authentication-and-sessions.md](authentication-and-sessions.md)).

No configuration was changed, no diagnostic was started, no credential was guessed and no ISP
interface was touched.

## Headline findings

- The web UI does not use a JSON API. Each page is server-rendered ASP that embeds its data as
  JavaScript constructor calls, e.g. `new stOpticInfo("InternetGatewayDevice.X_HW_DEBUG.AMP.Optic","ok"," 3.59","-17.10",...)`,
  with strings escaped as `\xNN`. These calls are parsed as text, never evaluated.
- With the administrator account Nuvytrix can read: system info and uptime, CPU and memory use,
  optical module power/temperature/voltage/bias, per-LAN-port link state and byte counters,
  per-SSID Wi-Fi counters, every Wi-Fi client with RSSI/noise/SNR/rates, the router's own device
  list (IP, MAC, hostname, port or SSID, DHCP lease) and the **firewall log text**.
- **UPnP IGD** answers without authentication on port 49652 with WAN byte/packet counters,
  connection status, uptime, external address and the UPnP port mappings.
- Telnet is open on the LAN but does not accept the administrator account; SNMP, syslog, TFTP,
  NAT-PMP and mDNS are closed or silent. There is no documented API.

See [router-capabilities.md](router-capabilities.md) for the full capability matrix and
[implementation-plan.md](implementation-plan.md) for what was built.

## Documents

| File | Contents |
| --- | --- |
| [router-capabilities.md](router-capabilities.md) | Capability matrix with statuses |
| [web-interface-inventory.md](web-interface-inventory.md) | Every menu page and what it holds |
| [api-endpoint-inventory.md](api-endpoint-inventory.md) | Data endpoints, formats, classification |
| [device-inventory.md](device-inventory.md) | What is known about connected devices |
| [wifi-capabilities.md](wifi-capabilities.md) | Radios, SSIDs, clients, neighbours |
| [wan-lan-dhcp.md](wan-lan-dhcp.md) | WAN, LAN, DHCP, ports |
| [firewall-security.md](firewall-security.md) | Firewall log, filters, NAT, UPnP |
| [optical-monitoring.md](optical-monitoring.md) | PON/optical readings |
| [network-protocols.md](network-protocols.md) | Protocol-by-protocol results |
| [authentication-and-sessions.md](authentication-and-sessions.md) | Login flow, lockout, secrets in pages |
| [limitations.md](limitations.md) | What is not available and why |
| [implementation-plan.md](implementation-plan.md) | Backend design and what is implemented |
