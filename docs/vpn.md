# Home VPN through the server (Mullvad)

Goal (owner, 2026-11-19): the provider (Orion) sees only an encrypted tunnel, not which sites the
home visits. The router stays as it is; the server becomes the home's gateway.

```
device -> switch -> server --(WireGuard, encrypted)--> switch -> router -> Orion -> Mullvad -> internet
```

## Decisions

| Question | Answer |
| --- | --- |
| VPN provider | Mullvad (account and payment by the owner; the config file never goes through chat) |
| Tunnel down | **Internet keeps working**: traffic goes directly via the router until the tunnel answers again (no kill switch) |
| Orion TV box | On its own router port, not on the home LAN; untouched, and unused anyway |
| The server's own traffic | Direct: the six sites' Cloudflare tunnels, Tailscale, updates. AdGuard's upstream DNS is already encrypted (DoH) |

## Parts (deploy/vpn)

- `setup.sh`: builds `/etc/wireguard/mullvad.conf` from the downloaded file (key, IPv4 address,
  peer; `Table = off`, no DNS change), installs the gateway, its watchdog timer, sysctl
  (forwarding, no ICMP redirects) and two ufw route rules. Changes nothing for devices.
- `gateway.sh` (`/usr/local/sbin/nuvytrix-vpn-gateway`):
  - policy routing: LAN-to-LAN stays local, devices in `/etc/nuvytrix-vpn-bypass` go direct, all
    other forwarded LAN traffic uses table 51;
  - table 51: default through `mullvad` while the tunnel answers (handshake under 3 minutes and a
    ping to 10.64.0.1 inside the tunnel), via the router after 3 failed checks (about 45 s);
  - probes always use table 50 (tunnel only), so they never leave unencrypted;
  - NAT for both paths, TCP MSS clamping into the tunnel;
  - state in `/var/log/nuvytrix/vpn.json` (`vpn` / `direct` / `off`), readable by Nuvytrix.

## Steps

| Step | Who | What | Devices affected |
| --- | --- | --- | --- |
| 1 | owner | Mullvad account, WireGuard config (Linux), `scp` it to `~/mullvad.conf` | none |
| 2 | owner | `sudo bash ~/nuvytrix/nuvytrix-backend/deploy/vpn/setup.sh`: must print `You are connected to Mullvad` | none |
| 3 | owner + Claude | Admin PC only: `route change 0.0.0.0 mask 0.0.0.0 192.168.100.27` (admin cmd, temporary), check am.i.mullvad.net, sites, speed | the PC |
| 4 | owner + Claude | IPv6: devices get a direct IPv6 route from the router, which would bypass the tunnel; turn off IPv6 address assignment on the router's LAN | all (IPv4 only on the LAN) |
| 5 | Claude | AdGuard DHCP gateway 192.168.100.1 -> 192.168.100.27; devices follow at lease renewal or Wi-Fi reconnect | all |

## Rollback

- One device: put its address in `/etc/nuvytrix-vpn-bypass`, then `sudo nuvytrix-vpn-gateway up`.
- Whole home: AdGuard -> Settings -> DHCP, gateway back to `192.168.100.1`; devices follow at renewal
  or Wi-Fi reconnect. Meanwhile `sudo systemctl stop nuvytrix-vpn-gateway` makes the server forward
  directly, so nothing waits on the tunnel.
- Tunnel off completely: `sudo systemctl disable --now nuvytrix-vpn-watchdog.timer nuvytrix-vpn-gateway wg-quick@mullvad`.

## Limits

- If the server is down, devices that use it as their gateway have no internet until it is back
  or the gateway is rolled back (they keep it until their lease ends, up to a day).
- Speed is limited by the server and Mullvad; plain browsing and streaming are fine.
- Some services block VPN addresses (banks, streaming catalogues, games): such a device goes in the
  bypass list.
- Sites see Mullvad's address and country, not the home's.
