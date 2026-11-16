# Limitations

## Not available from this router

| Wanted | Why not |
| --- | --- |
| Per-device traffic (bytes per client, top talkers) | No counters per host in any page or protocol. Only per LAN port, per SSID and WAN totals. |
| Flow data / destinations per device | No NetFlow, IPFIX or connection table exposed. |
| Router-side history (signal, traffic, CPU) | Router keeps only current values; Nuvytrix samples and stores them. |
| Remote syslog / push events | No setting in this firmware's UI; UDP 514 closed. |
| SNMP | Not present. |
| CLI access | Telnet requires an account the administrator does not have. |
| Reboot history, LOS event log | Not exposed. |
| Accurate WAN line rate | UPnP reports a fixed 512 kbit/s. |
| Neighbour Wi-Fi scan on demand | Starting a scan is a write; only the last result is readable. |
| Writing firewall rules safely | Only through undocumented form posts; out of scope (see firewall-security.md). |

## Firmware and ISP dependency

- Page paths, constructor names and argument order belong to V5R020C00S287. An ISP firmware update
  can change them. The parser fails loudly per section (that section becomes "unavailable") instead
  of returning wrong numbers.
- The ISP can change the web account or reset settings via TR-069. If logins start failing, check
  the account in the router UI before anything else; the client stops after one failed login to
  avoid the 3-attempt lock.
- The device is in `COMMON` configuration mode. Other ISP modes (for example `TOT`) add a CAPTCHA to
  the login, which would break automated login.

## Counter behaviour

- UPnP WAN counters and LAN/SSID counters reset on reboot or interface restart. History stores raw
  values and computes rates from deltas, ignoring negative deltas.
- LAN counters are 64-bit split into two 32-bit words; WAN UPnP counters are 32-bit and can wrap on
  busy links. A wrap looks like a reset and costs one interval of data.

## Additional hardware for what is missing

| Goal | Hardware or setup |
| --- | --- |
| Per-device traffic and top talkers | Own router behind the ONT (OpenWrt, OPNsense, MikroTik) with flow accounting, or a managed switch with port mirroring feeding a sensor (ntopng, Zeek) |
| Per-port traffic for each wired device | Managed switch with SNMP replacing the TL-SG1008D |
| Firewall rules with a real API | Own router/firewall (OPNsense, OpenWrt, RouterOS) with the Huawei in bridge mode, if the ISP allows it |
| DNS per device | AdGuard Home on the server as the LAN DNS (no hardware needed) |
