# Implementation

Only CONFIRMED, read-only capabilities are integrated. The module follows the existing layering
(route → service → repository) and keeps the router-specific parts in two clients and one parser.

## Module

```
src/modules/router/
  huaweiParser.ts      text parsing of ASP pages: \xNN unescaping, constructor-call tokenizer, section parsers
  huaweiWebClient.ts   login, session reuse, allow-listed GET pages, lockout guard, logout
  upnpClient.ts        UPnP IGD Get* actions (no auth)
  router.repository.ts router_samples table
  router.service.ts    poll → snapshot, sample storage, firewall log import, device enrichment
  router.routes.ts     REST endpoints (+ Swagger)
  router.schema.ts     query validation
```

### Web client rules

- **Allow-list, not deny-list:** the client can only request these pages:
  `deviceinfo.asp`, `opticinfo.asp`, `ethinfo.asp`, `wlaninfo.asp`, `getassociateddeviceinfo.asp`,
  `GetLanUserDevInfo.asp`, `firewalllogview.asp`. Any other path throws before a request is made.
- One login per poll. The session is reused for all pages and logged out at the end.
- A failed login is never retried. The client refuses further logins for 30 minutes to stay clear
  of the router's 3-attempt lock.
- Timeouts on every request (10 s), and one poll at a time (in-process lock).
- Response bodies are parsed and dropped; they are never logged or stored.

### Parser rules

- No `eval`, no `Function`: a tokenizer reads the double- or single-quoted string arguments of
  `new Name(...)` calls and unescapes `\xNN`, `\\`, `\'`, `\"`.
- Each section is parsed independently. A missing or changed section yields `null` for that section
  with a warning, not wrong numbers.
- Sensitive fields (serial numbers, GPON fields, module serial) are never read into the result.

### Data flow

```
every ROUTER_POLL_SECONDS (default 300):
  web session: device info, optics, ports, Wi-Fi, Wi-Fi clients, device list
  UPnP: WAN counters, status, external address
  → in-memory snapshot (served by GET /router/status and /router/clients)
  → one row in router_samples (history for charts)

every ROUTER_FIREWALL_LOG_POLL_MINUTES (default 15):
  web session: firewall log page → strip the device header → existing firewall import (deduplicated)
  → an import record only when new events were added
```

### API

| Method | Path | Returns |
| --- | --- | --- |
| GET | `/api/router/status` | latest snapshot: system, optics, WAN, LAN ports, SSIDs, configuration state, last poll time and errors |
| GET | `/api/router/clients` | router device list merged with Wi-Fi radio data and the Nuvytrix device id (by MAC) |
| GET | `/api/router/upnp` | current UPnP port mappings |
| GET | `/api/router/history?hours=24` | sampled CPU, memory, optical, WAN rate, client count |
| POST | `/api/router/refresh` | run a poll now (409 if one is running) |

### Configuration

```
ROUTER_HOST=192.168.100.1
ROUTER_USERNAME=           # web UI account; integration is off when empty
ROUTER_PASSWORD=
ROUTER_POLL_SECONDS=300
ROUTER_FIREWALL_LOG_POLL_MINUTES=15   # 0 disables automatic log import
```

## Not implemented (deliberately)

- Any write to the router (rules, DHCP, Wi-Fi, reboot). Needs explicit sign-off; see firewall-security.md.
- WAN details from `wan_list_info.asp` (firmware-specific, large; UPnP covers monitoring).
- Neighbour AP scan (requires a write to start).
- Configuration file backup (contains secrets; would need encrypted storage).

## Next steps worth considering

1. Read-only "configured on router" view of IPv4 filters, DMZ, port forwards and UPnP, next to the
   rules planned in Nuvytrix.
2. Alerts on optical Rx power trend and on new UPnP mappings, once notifications exist.
3. Per-SSID and per-port traffic rate charts from the stored samples.
