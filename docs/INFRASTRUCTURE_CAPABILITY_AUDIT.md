# Infrastructure capability audit (NVX-01, 2026-11-16)

Read-only review of the code (backend, frontend, migrations, Docker Compose) and of the production
server. Nothing was changed on the server or the router for this audit.

Status labels: **IMPLEMENTED**, **PARTIALLY_IMPLEMENTED**, **MISSING**, **HARDWARE_LIMITED**,
**EXTERNAL_SERVICE_REQUIRED**.

## 1. Infrastructure as found

| Item | Finding |
| --- | --- |
| Server | Ubuntu 24.04.4, kernel 6.8, 4 CPU, 7.4 GiB RAM (4.4 GiB available, 1 GiB swap in use), load ~0.4. It is a **laptop**: `BAT0` (100 %, full) and `ADP1` (on mains) exist, so the battery acts as a small UPS. |
| Disks | `sda` Kingston SA400 112 GB SSD (system, `/` 52 % of 108 GB); `sdb` Samsung HM321HI 298 GB HDD mounted at `/mnt/data` (backups, 1 % used). `smartctl` is installed. |
| Sensors | `coretemp` and `acpitz` under `/sys/class/hwmon` (CPU temperature available). |
| Interfaces | `enp4s0` (LAN, 78:84:3c:04:c3:14, reserved as 192.168.100.27), `tailscale0` (100.95.162.58), `wg0` (WireGuard), `wlp2s0` down, `virbr0` down. |
| Port 53 | `systemd-resolved` on 127.0.0.53 and 127.0.0.54; a leftover libvirt `dnsmasq` on 192.168.122.1 (virbr0, libvirtd inactive). **192.168.100.27:53 is free**, so AdGuard can bind there without touching resolved. |
| Containers | 28: Nuvytrix (web, api, postgres) and six sites (focentra, veltris, remly, portfolio, homewise, staffaway), each with web, api, mysql and a cloudflared tunnel. Combined use ~2.3 GiB RAM; the six MySQL instances are most of it (125–440 MiB each). |
| Nuvytrix deployment | `api` on the host network with `NET_RAW` (nmap ARP), listening only on 172.31.250.1; `web` on 0.0.0.0:8086 (LAN + Tailscale); postgres on 127.0.0.1:5432. No Docker socket mounted. |
| Backups | Cron 03:00–03:40: staffaway, remly, focentra, veltris (`.sql.gz`) and Nuvytrix (`pg_dump -Fc`, verified with `pg_restore --list`, 30-day retention) into `/mnt/data/backups` (63 files). All logs show `ok` for 2026-11-15 and 2026-11-16. **homewise and portfolio have MySQL but no backup job.** |
| Logs | `/var/log/auth.log` is `syslog:adm 0640`; user `aleksa` is in `adm`, so a read-only mount works without root. |
| Remote access | Tailscale up; WAN is CGNAT. |
| Switch | TP-Link TL-SG1008D, unmanaged (README said TL-SG1005D; corrected). |

## 2. Capability inventory

### Network discovery and devices

| Capability | Status | Where / why |
| --- | --- | --- |
| Discovery (nmap ping scan, ARP, vendor) | IMPLEMENTED | `devices/nmapRunner.ts` (`-sn -T3`), every 30 min (`DISCOVERY_INTERVAL_MINUTES=30`) |
| First seen / last seen | IMPLEMENTED | `devices.first_seen_at`, `last_seen_at` |
| Per-scan observations (IP, hostname) | IMPLEMENTED | `device_observations` |
| New device flag and alert | IMPLEMENTED | "new" filter (24 h), `alerts` kind `new_device` |
| Custom name, device type, notes | IMPLEMENTED | `devices.custom_name`, `device_type`, `notes`, `PATCH /devices/:id` |
| Router client list (port, Wi-Fi band, RSSI, address source, lease) | IMPLEMENTED (live) | `GET /router/clients`, merged with devices by MAC |
| IP / hostname change history | PARTIALLY_IMPLEMENTED | observations hold the data; no change detection, view or alert |
| MAC change on the same IP, IP conflict | MISSING | |
| DHCP vs static, lease expiry | PARTIALLY_IMPLEMENTED | shown live on the Router page; not stored or shown on the device |
| Reservation linked to device | MISSING | reservations exist in `/router/dhcp`, not linked |
| Availability history per device | MISSING | only last_seen; router reads every 5 min could feed it |
| Tags, trusted/untrusted | MISSING | |
| Port / service scan | MISSING | nmap runs ping scan only |

### Network monitoring

| Capability | Status | Where / why |
| --- | --- | --- |
| Router and internet availability (ICMP) | IMPLEMENTED | built-in targets `router` and `internet` (1.1.1.1), every 60 s |
| Latency, packet loss, 24 h series, uptime % | IMPLEMENTED | `monitoring_results` |
| DNS availability (resolve check) | IMPLEMENTED | target kind `dns` |
| Jitter | MISSING | ping output has mdev; not stored |
| DNS response time | PARTIALLY_IMPLEMENTED | stored as latency of DNS checks; not shown as such |
| Outage history | MISSING | derivable from results |
| HTTP/HTTPS targets, certificate expiry | MISSING | the six sites are not monitored |
| Internet traffic (fiber counters) | IMPLEMENTED | GPON `stStats`, history chart |
| LAN/Wi-Fi traffic, CPU/RAM, optical history | IMPLEMENTED | `router_samples` |
| Internet / router / optical alerts | IMPLEMENTED | `alerts` |

### Server, Docker, PostgreSQL

| Capability | Status | Where / why |
| --- | --- | --- |
| CPU, RAM, disk, load, uptime, temperature, NIC errors | MISSING | readable from `/proc`, `/sys` (read-only) |
| Disk health (SMART) | PARTIALLY possible | `smartctl` needs root; a root cron writing a JSON summary would be needed |
| Battery / mains (laptop) | MISSING | `/sys/class/power_supply` — useful as power-outage signal |
| PostgreSQL health | PARTIALLY_IMPLEMENTED | API health checks the DB; no stats |
| Docker container state, restarts, resources | MISSING | needs a read-only Docker API proxy (socket never mounted into the API) |

### DNS (AdGuard Home)

| Capability | Status | Where / why |
| --- | --- | --- |
| AdGuard status and stats client | PARTIALLY_IMPLEMENTED | `dns/adguardClient.ts` (`/control/status`, `/control/stats`), DNS page; `ADGUARD_URL` empty |
| AdGuard deployed | MISSING / EXTERNAL_SERVICE_REQUIRED | not installed |
| Query log, per-client stats, allow/block lists, rules | MISSING | AdGuard API supports them |
| Whole-home DNS via Huawei DHCP | MISSING, needs approval | earlier attempt timed out (docs/huawei/dns-management.md); IPv6 RDNSS/DHCPv6 still hands out `fe80::1` |

### Security

| Capability | Status | Where / why |
| --- | --- | --- |
| Firewall log import, events, insights, rule tracking | IMPLEMENTED | firewall module, automatic router log import |
| Router security controls (filters, MAC, parental, access) | IMPLEMENTED | see docs/huawei/feature-parity.md |
| Port / service discovery, new service alerts | MISSING | |
| SSH login monitoring | MISSING | `auth.log` readable via `adm` |
| CrowdSec | EXTERNAL_SERVICE_REQUIRED | optional, later |
| Threat intelligence | not planned | would send network data to third parties |

### Alerts, audit, reliability

| Capability | Status | Where / why |
| --- | --- | --- |
| In-app alerts, unread badge, mark read | IMPLEMENTED | `alerts`, `GET /alerts` |
| Thresholds, acknowledge/resolve, suppression | PARTIALLY_IMPLEMENTED | fixed thresholds; one alert per state change; no settings, no resolve |
| Push notifications (phone) | EXTERNAL_SERVICE_REQUIRED | channel not chosen |
| Audit of admin actions | IMPLEMENTED | `audit_logs`, all router writes |
| Database backups | IMPLEMENTED (outside the app) | `backup.sh` + cron; not visible in Nuvytrix |
| Backup status in the app | MISSING | |
| Integration health page | MISSING | router poll errors are logged only |
| Credentials | IMPLEMENTED | `.env` only, never logged; router keys and PINs never returned |

### Hardware limited (not built, by design)

| Capability | Status | Reason |
| --- | --- | --- |
| VLANs, SNMP, per-port statistics, port mirroring, PoE on the switch | HARDWARE_LIMITED | TL-SG1008D is unmanaged |
| Per-device bandwidth | HARDWARE_LIMITED | no mirroring; router has counters only per LAN port, per SSID and WAN |
| Packet inspection | HARDWARE_LIMITED | no traffic visibility at the server |
| Telnet switch-off, configuration backup, WAN/ONT changes | ISP restricted | see docs/huawei/security-review.md, maintenance.md |

## 3. Resource estimate (additions)

| Addition | RAM | Notes |
| --- | --- | --- |
| Server/Postgres/device/port features | ~0 extra containers | inside the existing API; a few MB of rows per day |
| Docker read-only proxy (`docker-socket-proxy`) | ~10–20 MiB | internal network only |
| AdGuard Home | ~60–150 MiB | grows with query log retention |
| CrowdSec (optional) | ~100–250 MiB | evaluated last |

With 4.4 GiB available the server has room; the six MySQL instances remain the largest consumers.

## 4. Production risks

1. **AdGuard as the only DNS** — server down means no name resolution for the house; no true HA.
   Mitigation: health alert, documented and tested rollback, approval before the router change.
2. **IPv6 DNS bypass** — devices preferring the router's IPv6 DNS (`fe80::1`) skip AdGuard until the
   IPv6 DNS setting changes, which is the whole-IPv6 form (approval required).
3. **Port scans** — limited to 192.168.100.0/24, top ports, `-T3`, scheduled at night; no NSE
   vulnerability scripts.
4. **Docker proxy** — must allow GET only; a misconfiguration would grant root-equivalent access.
5. **Compose changes** — new mounts (`/proc`, `/sys`, `auth.log`) are read-only; the API keeps host
   networking.
6. **Backup gap** — homewise and portfolio databases are not backed up (outside Nuvytrix; reported).

## 5. Plan

Tasks NVX-02 … NVX-23 in order: device intelligence (02–05), monitoring (06–07), server and Postgres
(08–09), Docker (10–11), port scans and SSH (12–13), AdGuard (14–17; 18 only with approval),
alerts, backups and integration health (19–21), CrowdSec evaluation (22), final verification (23).
