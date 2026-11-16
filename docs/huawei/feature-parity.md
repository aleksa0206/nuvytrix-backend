# Feature parity with the Huawei web interface

Status on 2026-11-16. "Readable" and "Writable" describe what the router supports through its web
UI; "Backend"/"Frontend" describe Nuvytrix; "Tested" means verified against the real router.

Legend: ✅ yes · ⚠️ partial · ❌ no · ⏳ discovered, not yet built · — not applicable

## Status pages

| Router feature | Available | Readable | Writable | Backend | Frontend | Tested | Limitations |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Device info (model, versions, uptime) | ✅ | ✅ | alias only | ✅ | ✅ Router page | ✅ | serial deliberately not stored |
| CPU / memory | ✅ | ✅ | — | ✅ + history | ✅ chart | ✅ | percentages only |
| ONT registration state | ✅ | ✅ | — | ✅ | ✅ | ✅ | |
| WAN status, external IP, NAT | ✅ | ✅ (UPnP) | ⚠️ ISP-managed | ✅ | ✅ | ✅ | detailed WAN fields ⏳ |
| WAN traffic counters | ✅ | ⚠️ (UPnP) | — | ✅ stored | ❌ not charted | ✅ | UPnP counters miss hardware-forwarded traffic (0.5 MB vs ~225 MB on LAN in the same 5 min); the chart uses LAN + Wi-Fi counters instead |
| Traffic to devices (LAN + Wi-Fi) | ✅ | ✅ | — | ✅ rate history | ✅ chart | ✅ | includes local device-to-device traffic |
| Optical module (Rx/Tx, temperature, voltage, bias) | ✅ | ✅ | — | ✅ + history | ✅ chart | ✅ | no router-side history |
| GPON interface counters | ✅ | ✅ | — | ❌ | ❌ | ❌ | low value; not built |
| Service provisioning status | ✅ | ✅ | — | ❌ | ❌ | ❌ | ISP flags |
| VoIP status | ✅ | ✅ | — | ❌ | ❌ | ❌ | no lines configured |
| Ethernet ports (link, speed, counters) | ✅ | ✅ | — | ✅ | ✅ | ✅ | |
| WLAN status and per-SSID counters | ✅ | ✅ | via WLAN pages | ✅ | ✅ | ✅ | |
| Wi-Fi clients (RSSI, SNR, rates) | ✅ | ✅ | — | ✅ | ✅ Router → Clients | ✅ | instantaneous values |
| Home network / mesh | ✅ | ✅ | ⚠️ | ❌ | ❌ | ❌ | no extenders present |
| User device information | ✅ | ✅ | delete only | ✅ merged by MAC | ✅ | ✅ | |
| One-click diagnosis | ✅ | ⚠️ results | starts with a write | ❌ | ❌ | ❌ | needs write support |

## Advanced configuration

| Router feature | Available | Readable | Writable | Backend | Frontend | Tested | Limitations |
| --- | --- | --- | --- | --- | --- | --- | --- |
| WAN configuration | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ | **not planned:** ISP-provisioned, TR-069 overwrites it, a mistake cuts the internet |
| LAN host (address, mask) | ✅ | ✅ | ✅ | ⚠️ read in parser | ❌ | ❌ | changing it disconnects every device |
| DHCP server: pool range and lease time | ✅ | ✅ | ✅ | ✅ | ✅ Router → DHCP | ✅ 2026-11-16: lease 86400 → 43200 → 86400 (script), then through Nuvytrix (add, edit, refused pool, lease 12 h and back, delete; 5 audit rows) | turning the DHCP server off, the secondary pool, DHCP options and DNS handed out are not offered yet |
| DHCP static IP (reservations): add / edit / delete | ✅ | ✅ | ✅ | ✅ | ✅ Router → DHCP | ✅ 2026-11-16: add, change address, delete (script), then through Nuvytrix (add, edit, refused pool, lease 12 h and back, delete; 5 audit rows) | an address held by another device is refused |
| DHCPv6 | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ | |
| IPv4 filtering: view state and rules | ✅ | ✅ | — | ✅ | ✅ Router → Firewall | ✅ | |
| IPv4 filtering: add / edit / delete rules (blacklist) | ✅ | ✅ | ✅ | ✅ | ✅ Router → Firewall | ✅ 2026-11-16: ALL, TCP with ports, TCP/UDP with ports and LAN range | direction is always Bidirectional on this firmware |
| IPv4 filtering: on / off | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ 2026-11-16 | |
| IPv4 filtering: whitelist / hybrid mode | ✅ | ✅ | ✅ | ❌ refused | ❌ | ❌ | not built: a whitelist without matching rules cuts every device off; hybrid rule fields not verified |
| IPv6 filtering | ❌ | — | — | — | — | ✅ (absence verified) | not in this firmware |
| MAC filtering: add / edit / delete, on / off (blacklist) | ✅ | ✅ | ✅ | ✅ | ✅ Router → MAC filter | ✅ 2026-11-16: script, then through Nuvytrix (add, rename, on, off, delete; server refused) | whitelist mode is shown, never edited; server and admin PC cannot be blocked |
| Wi-Fi MAC filtering: per network, add / edit / delete, on / off (blacklist) | ✅ | ✅ | ✅ | ✅ | ✅ Router → MAC filter | ✅ 2026-11-16: script, then through Nuvytrix on the 5 GHz network (add, on, off, delete) | same limits as the MAC filter |
| Parental control: templates (time limits, site lists, block or allow), devices | ✅ | ✅ | ✅ | ✅ | ✅ Router → Parental control | ✅ 2026-11-16: script, then through Nuvytrix with a fake device | server, admin PC and "all devices" cannot be bound; validity dates not offered |
| Precise device access control | ✅ | ✅ | ✅ | ⏳ | ❌ | ❌ | |
| Device access control (Telnet/HTTP from LAN/Wi-Fi) | ✅ | ✅ | ✅ | ⏳ | ❌ | ❌ | risk of locking out the web UI |
| DMZ: set host, on / off, remove | ✅ | ✅ | ✅ | ✅ | ✅ Router → Port forwarding & DMZ | ✅ 2026-11-16: script, then through Nuvytrix (server refused; set off, on, off, remove) | server and admin PC cannot be the DMZ host |
| IPv4 port mapping: add / edit / delete, on / off | ✅ | ✅ | ✅ | ✅ | ✅ Router → Port forwarding | ✅ 2026-11-16: script, then through Nuvytrix (router as target refused; add off, edit to UDP range, on, off, delete) | one port range per mapping is edited here; mappings with several ranges can only be deleted |
| Port trigger: add / edit / delete | ✅ | ✅ | ✅ | ✅ | ✅ Router → Port forwarding & DMZ | ✅ 2026-11-16: script, then through Nuvytrix (add off, edit on, delete) | |
| UPnP mappings (live) | ✅ | ✅ (UPnP) | — | ✅ | ✅ | ✅ | |
| UPnP on/off | ✅ | ✅ | ✅ | ✅ | ✅ Router → Firewall & UPnP | ✅ 2026-11-16 through Nuvytrix (off, on) | turning it off removes all UPnP mappings; monitoring over UPnP pauses while off |
| USB / FTP, media sharing | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ | no USB device in use |
| DDNS: add / edit / delete (internet WAN) | ✅ | ✅ (no password) | ✅ | ✅ | ✅ Router → DHCP & DNS | ✅ 2026-11-16: script, then through Nuvytrix with a disabled made-up entry | password write-only; gnudip providers not offered; of no use behind CGNAT |
| Static DNS entries: add / edit / delete (IPv4 and IPv6) | ✅ | ✅ | ✅ | ✅ | ✅ Router → DHCP & DNS | ✅ 2026-11-16: script, then through Nuvytrix (IPv4 and IPv6) | at most 20; one IPv4 and one IPv6 address per name |
| DNS servers handed out by DHCP | ✅ | ✅ | ⚠️ | ❌ | ❌ | ⚠️ attempt timed out, not applied | see dns-management.md; needs the owner's go-ahead to retry |
| Wi-Fi networks: name, on / off, name broadcast, WPA2 or WPA/WPA2 key; add / remove extra networks | ✅ | ✅ | ✅ | ✅ | ✅ Router → Wi-Fi | ✅ 2026-11-16: script, then through Nuvytrix with a temporary network | the page holds keys: compared, never returned or logged; open/WEP never set; main networks cannot be removed |
| Wi-Fi automatic shutdown schedule | ✅ | ✅ | ✅ | ✅ | ✅ Router → Wi-Fi | ✅ 2026-11-16: script, then through Nuvytrix (period that could not hit) | four periods |
| Wi-Fi radio: channel (auto / manual) and transmit power | ✅ | ✅ | ✅ | ✅ | ✅ Router → Wi-Fi | ✅ 2026-11-16: script, then through Nuvytrix on 2.4 GHz | 5 GHz manual channels 36–48 only; width not offered; a change restarts that radio |
| Wi-Fi channel width, WPS, coverage (mesh) | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ | |
| Account management | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ | not planned: changing the router password from another app is a lockout risk |
| ONT authentication | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ | not planned: ISP registration data |
| Configuration file backup | ✅ (provider account) | ❌ for this account | — | ❌ | ❌ | ✅ absence verified 2026-11-16 | cfgfileroot.asp offers only "save" and "save and reboot" to the admin account; no download |
| Maintenance (ping, traceroute, nslookup) | ✅ | results | starts with a write | ❌ | ❌ | ❌ | Nuvytrix can run these from the server instead |
| User log | ✅ | ⚠️ via download CGI | — | ❌ | ❌ | ❌ | |
| Firewall log | ✅ | ✅ | log rules writable | ✅ automatic import | ✅ Firewall events | ✅ | rolling buffer, read every 15 min |
| Indicator (LED): on / off | ✅ | ✅ | ✅ | ✅ | ✅ Router → Status | ✅ 2026-11-16 through Nuvytrix (off, on) | "off after a delay" (value 2) is not accepted by this model; LED off-time periods not offered |
| Reboot | ✅ | — | ✅ | ❌ | ❌ | ❌ | not planned without explicit request |
| Bundle information | ✅ | ✅ | — | ❌ | ❌ | ❌ | |

## Summary

- **Monitoring parity:** every status page with operational value is read, stored where history
  helps, and shown in Nuvytrix. Tested against the real router.
- **Configuration parity:** read access exists for every page. The write mechanism (page-relative
  `add.cgi` / `set.cgi` / `del.cgi` with the page token) is verified on 2026-11-16 for the IPv4
  filter, DHCP reservations, the main DHCP pool, both MAC filters, IPv4 port mapping, DMZ, port triggers, Wi-Fi networks, parental control, static DNS, DDNS and the UPnP switch. Other forms use the same mechanism, but each
  still needs its own verification.
- Write support will be added feature by feature, each only after its request format has been
  verified on the router: IPv4 filter, DHCP, MAC filters, port mapping, DMZ, port triggers and
  Wi-Fi networks, parental control, static and dynamic DNS and UPnP are done; next Wi-Fi advanced settings, device access control and IPv6. WAN, account, ONT authentication and reboot stay out of scope unless explicitly asked.
- Role-based authorization: Nuvytrix has a single administrator role today. Roles become relevant
  only with more users; writes would be limited to the administrator.
