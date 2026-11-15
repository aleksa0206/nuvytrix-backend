# Authentication and sessions

## Login flow (from `/login.asp`, verified)

1. The page sets a cookie in JavaScript: `Cookie=body:Language:english:id=-1; path=/`.
2. `POST /asp/GetRandCount.asp` (empty body) returns a one-time token as plain text (may start with
   a BOM).
3. `POST /login.cgi` with form fields:
   - `UserName`: the account name
   - `PassWord`: **Base64** of the password (encoding, not hashing; the connection is plain HTTP)
   - `Language`: `english`
   - `x.X_HW_Token`: the token from step 2
4. On success the router replaces the `Cookie` value with one carrying a session id (`sid=...`) and
   answers with a small page that redirects into `/index.asp`. On failure it answers with the login
   page again.

Requests to protected pages without a valid session return a short page that redirects to
`login.asp`. Nuvytrix detects that and logs in again once.

## Lockout

The login page shows `errloginlockNum = '3'`: **three failed logins lock the account** for a period
(`LockLeftTime`). The client therefore:

- never retries a failed login automatically;
- after a failure, refuses further logins until the API restarts or the cool-down passes (30 minutes);
- reports `ROUTER_AUTH_FAILED` instead of looping.

## Sessions

- The router appears to allow one administrator session at a time. Logging in from Nuvytrix can end
  a browser session on the router UI, and the other way round.
- Nuvytrix logs in at the start of a poll, reuses the session within it, and logs out at the end
  (`POST /logout.cgi` with the page token), so the administrator's own browser login stays possible
  between polls.
- Writes use per-page `onttoken` / `x.X_HW_Token` values. Nuvytrix does not write, so it never reads
  or sends them except the login token.

## Credentials in Nuvytrix

- `ROUTER_USERNAME` and `ROUTER_PASSWORD` live in the API's `.env` on the server (mode 600). They are
  never committed, logged or returned by the API.
- The integration is disabled when either is missing.
- Pino redacts request headers; router responses are never logged as raw bodies.

## Secrets rendered into pages

| Page | Secret | Nuvytrix |
| --- | --- | --- |
| `WlanBasic.asp`, `wifiCover.asp` | Wi-Fi PSKs, WEP keys, WPS PIN | never requested (deny-list) |
| `ethinfo.asp` | GPON LOID / registration password fields | requested for port stats; only `GEInfo` and `LANStats` are parsed; body not stored |
| `deviceinfo.asp`, firewall log header | serial number, WAN IP | parsed fields exclude serial; the log header is not stored as events |
| `account.asp` | account names (no passwords) | not requested |

## Transport

The management UI is plain HTTP on the LAN. Credentials (Base64) and the session cookie cross the
LAN in clear text on every login. That is acceptable only because the path is server → router on a
wired home LAN.
