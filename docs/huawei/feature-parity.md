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
| MAC filtering: add / edit / delete, on / off (blacklist) | ✅ | ✅ | ✅ | ✅ | ✅ Router → MAC filter | ✅ 2026-11-16 (script) | whitelist mode is shown, never edited; server and admin PC cannot be blocked |
| Wi-Fi MAC filtering: per network, add / edit / delete, on / off (blacklist) | ✅ | ✅ | ✅ | ✅ | ✅ Router → MAC filter | ✅ 2026-11-16 (script) | same limits as the MAC filter |
| Parental control | ✅ | ✅ | ✅ | ⏳ | ❌ | ❌ | several pages, templates and schedules |
| Precise device access control | ✅ | ✅ | ✅ | ⏳ | ❌ | ❌ | |
| Device access control (Telnet/HTTP from LAN/Wi-Fi) | ✅ | ✅ | ✅ | ⏳ | ❌ | ❌ | risk of locking out the web UI |
| DMZ | ✅ | ✅ | ✅ | ⏳ | ❌ | ❌ | |
| IPv4 port mapping | ✅ | ✅ | ✅ | ⏳ | ❌ | ❌ | |
| Port trigger | ✅ | ✅ | ✅ | ⏳ | ❌ | ❌ | |
| UPnP mappings (live) | ✅ | ✅ (UPnP) | — | ✅ | ✅ | ✅ | |
| UPnP on/off | ✅ | ✅ | ✅ | ⏳ | ❌ | ❌ | |
| USB / FTP, media sharing | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ | no USB device in use |
| DDNS | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ | not needed behind CGNAT |
| Static DNS hosts | ✅ | ✅ | ✅ | ⏳ | ❌ | ❌ | |
| WLAN basic (SSID, security, key) | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ | pages embed keys; would need careful handling |
| WLAN advanced, schedule, coverage | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ | |
| Account management | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ | not planned: changing the router password from another app is a lockout risk |
| ONT authentication | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ | not planned: ISP registration data |
| Configuration file backup | ✅ | download | upload restore | ❌ | ❌ | ❌ | contains secrets; would need encrypted storage |
| Maintenance (ping, traceroute, nslookup) | ✅ | results | starts with a write | ❌ | ❌ | ❌ | Nuvytrix can run these from the server instead |
| User log | ✅ | ⚠️ via download CGI | — | ❌ | ❌ | ❌ | |
| Firewall log | ✅ | ✅ | log rules writable | ✅ automatic import | ✅ Firewall events | ✅ | rolling buffer, read every 15 min |
| Indicator (LED) | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ | low value |
| Reboot | ✅ | — | ✅ | ❌ | ❌ | ❌ | not planned without explicit request |
| Bundle information | ✅ | ✅ | — | ❌ | ❌ | ❌ | |

## Summary

- **Monitoring parity:** every status page with operational value is read, stored where history
  helps, and shown in Nuvytrix. Tested against the real router.
- **Configuration parity:** read access exists for every page. The write mechanism (page-relative
  `add.cgi` / `set.cgi` / `del.cgi` with the page token) is verified on 2026-11-16 for the IPv4
  filter, DHCP reservations, the main DHCP pool and both MAC filters. Other forms use the same mechanism, but each
  still needs its own verification.
- Write support will be added feature by feature, each only after its request format has been
  verified on the router: IPv4 filter, DHCP and MAC filters are done; next port mapping, DMZ, port
  triggering, Wi-Fi and parental controls. WAN, account, ONT authentication and reboot stay out of scope unless explicitly asked.
- Role-based authorization: Nuvytrix has a single administrator role today. Roles become relevant
  only with more users; writes would be limited to the administrator.
