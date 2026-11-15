# Feature parity with the Huawei web interface

Status on 2026-11-15. "Readable" and "Writable" describe what the router supports through its web
UI; "Backend"/"Frontend" describe Nuvytrix; "Tested" means verified against the real router.

Legend: ✅ yes · ⚠️ partial · ❌ no · ⏳ discovered, not yet built · — not applicable

## Status pages

| Router feature | Available | Readable | Writable | Backend | Frontend | Tested | Limitations |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Device info (model, versions, uptime) | ✅ | ✅ | alias only | ✅ | ✅ Router page | ✅ | serial deliberately not stored |
| CPU / memory | ✅ | ✅ | — | ✅ + history | ✅ chart | ✅ | percentages only |
| ONT registration state | ✅ | ✅ | — | ✅ | ✅ | ✅ | |
| WAN status, external IP, NAT | ✅ | ✅ (UPnP) | ⚠️ ISP-managed | ✅ | ✅ | ✅ | detailed WAN fields ⏳ |
| WAN traffic counters | ✅ | ✅ (UPnP) | — | ✅ + rate history | ✅ chart | ✅ | 32-bit counters, reset on reconnect |
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
| DHCP server (pool, lease) | ✅ | ✅ | ✅ | ⏳ | ❌ | ❌ | write format not analysed yet |
| DHCP static IP | ✅ | ✅ | ✅ | ⏳ | ❌ | ❌ | good next candidate |
| DHCPv6 | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ | |
| IPv4 filtering: view state and rules | ✅ | ✅ | — | ✅ | ✅ Router → Firewall | ✅ | |
| IPv4 filtering: add / edit / delete / enable / mode | ✅ | — | ✅ (documented) | ❌ | ❌ | ❌ supervised test pending | see firewall-management.md |
| IPv6 filtering | ❌ | — | — | — | — | ✅ (absence verified) | not in this firmware |
| MAC filtering | ✅ | ✅ | ✅ | ⏳ | ❌ | ❌ | |
| Wi-Fi MAC filtering | ✅ | ✅ | ✅ | ⏳ | ❌ | ❌ | |
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
- **Configuration parity:** read access exists for every page. Write access is documented for the
  IPv4 filter but not enabled. A first supervised write test sent the add request to the wrong
  path (`/add.cgi` instead of the page-relative `/html/bbsp/ipincoming/add.cgi`); the router did not
  answer and nothing changed. The corrected test has not been run yet.
- Write support will be added feature by feature, each only after its request format has been
  verified on the router: first IPv4 filter, then DHCP reservations, MAC filters, port mapping, DMZ
  and UPnP. WAN, account, ONT authentication and reboot stay out of scope unless explicitly asked.
- Role-based authorization: Nuvytrix has a single administrator role today. Roles become relevant
  only with more users; writes would be limited to the administrator.
