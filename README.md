# Nuvytrix — Backend

REST API for **Nuvytrix**, a personal platform for monitoring and administering a home network.
It discovers devices with nmap, ingests the Huawei router's firewall log, monitors availability
and latency, integrates with AdGuard Home for DNS statistics, and tracks intended firewall rules.

The Angular client lives in a separate repository: `nuvytrix-frontend`.

## What works, and what does not

Nuvytrix never shows simulated data. Each area reports one of: implemented, partial, requires
hardware, requires router support, or planned. The same list is served by
`GET /api/system/capabilities` and shown in the app's Settings page.

| Feature | Status | Notes |
| --- | --- | --- |
| Device discovery | Implemented | `nmap -sn` from the server. MAC and vendor need raw sockets (the Docker image grants them to nmap only). The server never sees its own MAC. |
| Firewall log analysis | Partial | Manual upload of the file downloaded from the router's firewall log page. Syslog forwarding has not been verified on this firmware. |
| Firewall rule management | Requires router support | The HN8546X6 exposes no documented management API. Rules are tracked here as intended state and applied by hand with generated instructions. Nothing is ever reported as "confirmed by the router". |
| Availability, latency, packet loss | Implemented | ICMP and DNS checks on a schedule, stored in PostgreSQL. Uptime is computed only from checks that ran. |
| DNS statistics | Requires AdGuard Home | Off until `ADGUARD_URL` is set. |
| Per-device traffic | Requires hardware | The TL-SG1005D is unmanaged (no mirroring, no SNMP). A managed switch with port mirroring, a gateway that exports flow data, or a dedicated sensor is needed. |
| Remote access | Planned | The WAN address is behind CGNAT; use a VPN (WireGuard/Tailscale). Do not expose the app publicly. |

### Network notes

- **Router:** Huawei OptiXstar (reported ProductClass HN8546X6, software V5R020C00S287) at
  `192.168.100.1`. Enabling the firewall log can reduce forwarding performance; enable it only
  for the directions you need.
- **Switch:** TP-Link TL-SG1005D, unmanaged. A host on the switch only sees its own traffic plus
  broadcast and multicast, so complete traffic monitoring is not possible from the server.
- **WAN:** CGNAT IPv4 (100.64.0.0/10), so inbound IPv4 connections from the internet do not reach
  the network. IPv6 behaves differently and is filtered separately on the router.

## Architecture

```
Route → Middleware (auth, validation) → Controller → Service → Repository → PostgreSQL
```

```
src/
  config/        env (Zod-validated), knex, logger (pino), swagger
  common/        errors (AppError + ErrorCode), middleware, utils
  container/     composition root: builds repositories and services once
  database/      migrations (explicit list in migrations/index.ts), migrate runner
  modules/
    auth/        sessions, login throttling
    audit/       audit log of administrative actions
    devices/     nmap runner + XML parser, devices, discovery scans
    firewall/    Huawei log parser, imports, events, insights, policies
    monitoring/  ping/DNS probes, targets, results
    dns/         AdGuard Home client
    overview/    dashboard summary and capability matrix
    health/
  scripts/       createAdmin
```

- **Responses:** JSON resources; lists are `{ data, meta: { total, page, pageSize, totalPages } }`.
  Errors are `{ code, message, details? }`, where `code` is an `ErrorCode`.
- **Authentication:** username and password, then an httpOnly `SameSite=Strict` session cookie.
  Only the SHA-256 of the token is stored. Sessions have an idle timeout and an absolute max age,
  and logout deletes the session on the server. Login is throttled per (username, client address)
  and per username across addresses; addresses the admin recently signed in from are exempt from
  the account-wide limit.
- **External processes:** nmap and ping run through `execFile` with fixed argument lists, never a
  shell. Scan targets must be inside `ALLOWED_SCAN_CIDRS`. Only one scan runs at a time, and each
  has a timeout.
- **Firewall log import:** each line is parsed independently (field order does not matter). Rejected
  lines are stored with their line number and reason. Events are deduplicated on
  `(sha256 of the normalised line, occurrence within the file)`: re-uploading an overlapping export
  adds nothing, while genuinely repeated events in one file are kept. Router timestamps are local
  time and are converted using `ROUTER_TIMEZONE`.

API documentation: `http://<api>/api-docs` (Swagger UI) and `/api-docs.json`.

## Development

Requirements: Node.js 22+, Docker.

```bash
cp .env.example .env               # then set DB_PASSWORD=devpassword, DB_PORT=5433
docker compose -f docker-compose.dev.yml up -d
npm install
npm run migrate
npm run create-admin -- admin      # prompts for a password (min. 12 characters)
npm run dev                        # http://127.0.0.1:4000/api-docs
```

On Windows or macOS, nmap (if installed at all) runs without raw sockets, so discovery returns IPs
and hostnames only. Ping parsing expects Linux iputils output. Full functionality needs the Linux
server.

### Checks

```bash
npm test             # Vitest + supertest against the nuvytrix_test database
npm run lint
npm run typecheck
npm run format:check
```

The integration tests use a real PostgreSQL (`nuvytrix_test` on port 5433, created by the dev
compose file). They truncate every table, so never point them at real data.

## Deployment (Ubuntu server, Docker Compose)

Both repositories are checked out side by side:

```bash
mkdir -p ~/nuvytrix && cd ~/nuvytrix
git clone git@github.com:aleksa0206/nuvytrix-backend.git
git clone git@github.com:aleksa0206/nuvytrix-frontend.git
cd nuvytrix-backend
cp .env.example .env && chmod 600 .env
```

In `.env`, set at least: a long random `DB_PASSWORD`, `ALLOWED_SCAN_CIDRS`, `ROUTER_HOST`, and
`FRONTEND_URL=http://<server-ip>:8080`. Keep `COOKIE_SECURE=false` unless the app is served over
HTTPS. Then:

```bash
docker compose up -d --build                                          # build and start
docker compose exec api node dist/scripts/createAdmin.js admin         # first admin
docker compose ps                                                     # health status
docker compose logs -f api                                            # follow logs
docker compose down                                                   # stop (data is kept)
```

The web UI is at `http://<server-ip>:8080`. Migrations run automatically when the API starts; to
run them by hand use `docker compose exec api node dist/database/migrate.js`.

**Firewall the API port.** The API container uses host networking (nmap must be on the LAN), and
it listens on port 4000 so the web container can reach it. Allow the UI port from the LAN and
block 4000:

```bash
sudo ufw allow from 192.168.100.0/24 to any port 8080 proto tcp
sudo ufw deny 4000/tcp
```

PostgreSQL listens on `127.0.0.1` only.

### Update

```bash
cd ~/nuvytrix/nuvytrix-frontend && git pull
cd ~/nuvytrix/nuvytrix-backend && git pull
docker compose up -d --build
```

### Back up and restore

```bash
# Backup
docker compose exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -Fc "$POSTGRES_DB"' > nuvytrix-$(date +%F).dump

# Restore (replaces the current data)
docker compose stop api
docker compose exec -T postgres sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists' < nuvytrix-YYYY-MM-DD.dump
docker compose start api
```

### Remote access

Do not forward the dashboard to the internet. CGNAT already blocks inbound IPv4, and the app is
designed for the trusted LAN. For access from outside, run a VPN on the server (WireGuard, or
Tailscale, which works through CGNAT) and reach the UI over the VPN.

## Firewall log format

Lines look like this (one per event):

```
2026-11-14 21:31:28 [Notice] IN=Internet_DHCP OUT=LocalNetwork Direction=Public->Private Action=Deny SRC=203.0.113.7 DST=192.168.100.20 PROTO=TCP SPT=443 DPT=55090
```

`Action`, `SRC`, `DST` and `PROTO` are required. `SPT`, `DPT`, `IN`, `OUT`, `Direction` and the
severity tag are optional. Directions map to `internet_to_lan`, `internet_to_router`,
`lan_to_internet` and `lan_to_router`. Unknown directions are kept as raw text.

Denied packets from source port 443 to high ports are usually late replies to connections opened
from the LAN, not attacks. The insights endpoint says so instead of labelling them.
