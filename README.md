# Nuvytrix Backend

REST API for Nuvytrix, the dashboard I use to keep an eye on my home network. It finds devices with nmap, imports the firewall log from my Huawei router, pings the things I care about, reads DNS stats from AdGuard Home and keeps a list of firewall rules I want on the router.

Frontend: [nuvytrix-frontend](https://github.com/aleksa0206/nuvytrix-frontend) (Angular).

It runs on my Ubuntu server at home and is only reachable from my LAN and over Tailscale. Unlike my other projects it has no public domain, on purpose: it can scan the network and reads the router's firewall log.

## Tech stack

Node.js 22, TypeScript, Express 5, PostgreSQL 17 with Knex, Zod, bcryptjs, Helmet, `express-rate-limit`, Multer, Pino, Swagger (`swagger-jsdoc` + `swagger-ui-express`), nmap, Vitest + Supertest, Docker, GitHub Actions.

## Architecture

```
route → controller → service → repository → Knex → PostgreSQL
```

- Routes declare the endpoints, apply middleware (auth, Zod validation, uploads) and carry the Swagger annotations.
- Controllers only deal with HTTP.
- Services hold the logic and get their repositories and integrations through the constructor.
- Repositories are the only place with SQL.
- A container (`src/container`) builds everything once. Tests rebuild it with fakes for nmap, ping and AdGuard.

Code is grouped by module (`src/modules/devices`, `firewall`, `monitoring`, ...) because most modules also have their own integration, like the nmap runner or the log parser.

Errors extend `AppError` with an HTTP status and an `ErrorCode`. Messages for each code are in `src/common/errors/errorMessages.ts`, and one error middleware turns everything into `{ code, message, details? }`. Lists come back as `{ data, meta: { total, page, pageSize, totalPages } }`.

Migrations are listed explicitly in `src/database/migrations/index.ts` and run when the API starts.

## Endpoints

All routes are under `/api`. Everything except `/health` and `/auth/login` needs the session cookie.

| Area | Endpoints |
| --- | --- |
| Auth | `POST /auth/login`, `POST /auth/logout`, `GET /auth/me` |
| Devices | `GET /devices`, `GET`/`PATCH /devices/:id` |
| Discovery | `GET`/`POST /discovery/scans`, `GET /discovery/scans/:id` |
| Firewall log | `POST`/`GET /firewall/imports`, `GET /firewall/imports/:id`, `GET /firewall/events`, `GET /firewall/events/facets`, `GET /firewall/events/:id`, `GET /firewall/summary`, `GET /firewall/insights` |
| Firewall rules | `GET`/`POST /firewall/policies`, `GET`/`PATCH`/`DELETE /firewall/policies/:id`, `POST /firewall/policies/:id/status`, `GET /firewall/policies/:id/instructions` |
| Monitoring | `GET`/`POST /monitoring/targets`, `PATCH`/`DELETE /monitoring/targets/:id`, `POST /monitoring/targets/:id/check`, `GET /monitoring/targets/:id/series` |
| DNS | `GET /dns/status`, `GET /dns/stats` |
| Notifications | `GET /alerts`, `POST /alerts/read-all` |
| Other | `GET /overview`, `GET /system/capabilities`, `GET /system/settings`, `GET /audit-logs`, `GET /health` |

Swagger UI is at `/api-docs`.

## What it can and can't do on my network

My setup is a Huawei OptiXstar HN8546X6 router at `192.168.100.1`, an unmanaged TP-Link TL-SG1008D switch and a CGNAT IPv4 address from the ISP. That limits a few things, and the app says so instead of faking data.

| Feature | Status |
| --- | --- |
| Device discovery | Works. MAC and vendor need raw sockets, which the Docker image gives to nmap only. The server never sees its own MAC. |
| Firewall log | Manual upload of the file downloaded from the router. I haven't confirmed that this firmware can forward it over syslog. |
| Firewall rules | The router has no documented API, so rules are tracked here and applied by hand with generated steps. Nothing is ever shown as confirmed by the router. |
| Ping / DNS monitoring | Works, from the server. Uptime is calculated only from checks that actually ran. |
| Notifications | In the app (Overview, with an unread badge in the menu): internet down after two failed pings of 1.1.1.1 and back, a router or other target not answering, new devices from discovery scans, fiber signal weak (below -27 dBm), back to normal (-25 dBm or better) or lost. Nothing is sent outside the app yet. |
| DNS stats | Needs AdGuard Home (`ADGUARD_URL`). |
| Per-device traffic | Not possible with an unmanaged switch. Would need a managed switch with port mirroring or a gateway that exports flow data. |
| Remote access | CGNAT blocks inbound IPv4. Use a VPN (I use Tailscale). |

Turning on the router's firewall log for every direction can slow down forwarding, so I only enable the directions I need.

## Firewall log import

The router writes lines like:

```
2026-11-14 21:31:28 [Notice] IN=Internet_DHCP OUT=LocalNetwork Direction=Public->Private Action=Deny SRC=203.0.113.7 DST=192.168.100.20 PROTO=TCP SPT=443 DPT=55090
```

- Field order doesn't matter. `Action`, `SRC`, `DST` and `PROTO` are required, the rest is optional. IPv4 and IPv6 both work.
- Lines that can't be parsed are saved with their line number and the reason, and the upload reports how many there were.
- Duplicates are skipped by hashing each line together with how many times it already appeared in the file. Uploading the same or an overlapping export again adds nothing, but two identical events in the same second are both kept.
- The router logs local time without an offset, so timestamps are converted with `ROUTER_TIMEZONE`.

The insights endpoint only describes patterns. Denied packets from port 443 to high ports are usually late replies to connections from my own devices, and it says that instead of calling them attacks.

## Security

- Login with username and password. The session is a random token in an httpOnly, `SameSite=Strict` cookie, and only its SHA-256 hash is stored. Sessions have an idle timeout and a max age, and logout deletes them on the server.
- Login throttling per username + IP and per username overall. Addresses I recently logged in from are exempt from the account-wide limit, so another device can't lock me out.
- nmap and ping run through `execFile` with fixed arguments, never through a shell. Scan targets have to be inside `ALLOWED_SCAN_CIDRS`, only one scan runs at a time and every scan has a timeout.
- Zod validation on all input, upload size and type checks, Helmet, rate limits, parameterized queries.
- Admin actions (logins, scans, imports, rule and target changes) go to the audit log.
- Secrets only come from `.env`, which is git-ignored.

## Running locally

Requires Node.js 22+ and Docker.

```bash
cp .env.example .env           # set DB_PASSWORD=devpassword and DB_PORT=5433
docker compose -f docker-compose.dev.yml up -d
npm install
npm run migrate
npm run create-admin -- admin  # asks for a password (at least 12 characters)
npm run dev                    # http://127.0.0.1:4000/api-docs
```

On Windows nmap runs without raw sockets, so you only get IPs and hostnames, and the ping parser expects Linux output. Everything works properly on the Linux server.

## Tests

```bash
npm test               # Vitest + Supertest against the nuvytrix_test database
npm run lint
npm run typecheck
npm run format:check
```

The integration tests use a real PostgreSQL database (`nuvytrix_test` on port 5433, created by the dev compose file) and empty every table, so don't point them at real data.

## Deployment

On the server, with both repositories next to each other:

```bash
mkdir -p ~/nuvytrix && cd ~/nuvytrix
git clone https://github.com/aleksa0206/nuvytrix-backend.git
git clone https://github.com/aleksa0206/nuvytrix-frontend.git
cd nuvytrix-backend
cp .env.example .env && chmod 600 .env
```

In `.env` set at least a long random `DB_PASSWORD`, `ALLOWED_SCAN_CIDRS`, `ROUTER_HOST` and `FRONTEND_URL=http://<server-ip>:8080`. Then:

```bash
docker compose up -d --build
docker compose exec api node dist/scripts/createAdmin.js admin
docker compose ps
docker compose logs -f api
docker compose down          # stops everything, data stays in the volume
```

The UI is on `http://<server-ip>:8080` from the LAN, or `http://<tailscale-ip>:8080` from anywhere on my tailnet. Don't forward the port on the router or put it behind a public tunnel.

The API container uses host networking so nmap is really on the LAN, but it only listens on `172.31.250.1`, the gateway of a small Docker network that only the web container joins. PostgreSQL listens on `127.0.0.1`. The firewall only lets the LAN and Tailscale reach the UI port:

```bash
sudo ufw allow from 192.168.100.0/24 to any port 8080 proto tcp
sudo ufw allow in on tailscale0 to any port 8080 proto tcp
```

If the app ever sits behind a reverse proxy or tunnel, set `REAL_IP_FROM` on the web container to the proxy's address so nginx reads the visitor IP from `CF-Connecting-IP`, and set `COOKIE_SECURE=true` once it's served over HTTPS.

### Updating

```bash
cd ~/nuvytrix/nuvytrix-frontend && git pull
cd ~/nuvytrix/nuvytrix-backend && git pull
docker compose up -d --build
```

### Backup and restore

```bash
docker compose exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -Fc "$POSTGRES_DB"' > nuvytrix-$(date +%F).dump

docker compose stop api
docker compose exec -T postgres sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists' < nuvytrix-YYYY-MM-DD.dump
docker compose start api
```
