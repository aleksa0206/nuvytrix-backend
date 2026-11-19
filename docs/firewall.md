# Server firewall (ufw)

Until 2026-11-19 ufw was installed but **inactive**: every listening port was reachable from the
LAN. `deploy/firewall/ufw-setup.sh` turns it on with only what the home needs.

## What is open (inventory of 2026-11-19)

| Port | From | Why |
| --- | --- | --- |
| 22/tcp | LAN 192.168.100.0/24, Tailscale | SSH (not from the internet) |
| everything on `tailscale0` | Tailscale devices | SSH, Nuvytrix, ntfy from the phone |
| 41641/udp | any | Tailscale direct connections (otherwise it falls back to relays) |
| 53 | LAN, IPv6 link-local | AdGuard DNS |
| 67/udp | LAN (clients without an address) | AdGuard DHCP |
| 3000/tcp | LAN | AdGuard admin page |
| 4000/tcp | 172.31.250.0/29 only | Nuvytrix web container to the API on the host network |

Not in ufw on purpose:

- **The six sites** reach the internet through Cloudflare tunnels (outgoing connections only), so
  nothing is opened for them.
- **Ports published by Docker** (Nuvytrix 8086, ntfy 8090) go through Docker's own iptables rules,
  which come before ufw's. They are reachable on the LAN as before; the router forwards neither.
- **WireGuard wg0** (51820/udp) had no traffic since boot and stays closed. To use it:
  `sudo ufw allow 51820/udp`.
- Outgoing traffic is not restricted (monitoring, scans, updates, tunnels).

## Turning it on

`sudo bash ~/nuvytrix/nuvytrix-backend/deploy/firewall/ufw-setup.sh`. A timer turns ufw off again
after 3 minutes unless the owner confirms from a new SSH session that access still works.

## Rollback

`sudo ufw disable` (from the server's keyboard, LAN SSH or Tailscale). The previous rules are kept
by ufw as backups in `/etc/ufw/*.rules.<date>`.
