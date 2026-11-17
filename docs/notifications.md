# Phone notifications (ntfy)

Every alert Nuvytrix raises (the Notifications panel on the overview page) is also pushed to phones
through **ntfy**, self-hosted on the Ubuntu server. Nothing goes through a third-party push service.

## Deployment

| Item | Value |
| --- | --- |
| Where | Separate compose project `ntfy` (`deploy/ntfy/docker-compose.yml`), so a Nuvytrix deploy never restarts it |
| Address | `http://100.95.162.58:8090` (Tailscale) and `http://192.168.100.27:8090` (LAN); IPv4 only, nothing forwarded on the router |
| Access | `auth-default-access: deny-all`: every read and write needs a login or token |
| Users | `nuvytrix` (write-only on topic `nuvytrix`, used through a token) and `phone` (read-only on `nuvytrix`) |
| Secrets | `NTFY_TOKEN` in `~/nuvytrix/nuvytrix-backend/.env`; the `phone` password is given to the owner once and not stored anywhere else |
| Data | `deploy/ntfy/data` (auth and 72-hour message cache), not in git |

Start: `cd ~/nuvytrix/nuvytrix-backend/deploy/ntfy && docker compose -p ntfy up -d`.

Users and token (once):

```sh
docker exec -e NTFY_PASSWORD=... ntfy-ntfy-1 ntfy user add nuvytrix
docker exec ntfy-ntfy-1 ntfy access nuvytrix nuvytrix write-only
docker exec ntfy-ntfy-1 ntfy token add nuvytrix        # -> NTFY_TOKEN
docker exec -e NTFY_PASSWORD=... ntfy-ntfy-1 ntfy user add phone
docker exec ntfy-ntfy-1 ntfy access phone nuvytrix read-only
```

`.env`: `NTFY_URL=http://127.0.0.1:8090/nuvytrix`, `NTFY_TOKEN=tk_...`.

## On the phone

1. Install Tailscale and sign in, so the phone reaches the server away from home.
2. Install the ntfy app (Android: Google Play or F-Droid).
3. Settings → Manage users → add server `http://100.95.162.58:8090`, user `phone` and its password.
4. Subscribe to topic `nuvytrix` on that server. Android connects directly (no Firebase); allow the
   app to run in the background so it keeps the connection.
5. In Nuvytrix: Settings → Alert thresholds → **Send test notification**.

iPhone: the app only gets instant pushes through ntfy.sh's relay (`upstream-base-url`), which is not
configured on purpose; without it messages arrive when the app is opened.

## Behaviour

- Priority: error = high, warning = default, info = low.
- The message is the alert title. A push that fails (server down, token wrong) is logged without the
  token and never blocks or loses the alert; it is still in the app.
