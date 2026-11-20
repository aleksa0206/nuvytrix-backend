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
| 4 | Claude | IPv6: devices get a direct IPv6 route from the router, which would bypass the tunnel; closed in AdGuard instead (no IPv6 addresses for sites, see below) | all |
| 5 | Claude | AdGuard DHCP gateway 192.168.100.1 -> 192.168.100.27; devices follow at lease renewal or Wi-Fi reconnect | all |

## Done 2026-11-20 (00:10)

- Tunnel: Mullvad Belgrade (rs-beg-wg-101), IPv4 only, no Mullvad DNS or content blocking (AdGuard does that), no Mullvad kill switch.
- Admin PC test: `am.i.mullvad.net` says connected, path PC -> 192.168.100.27 -> 10.64.0.1 -> internet, about 310 Mbit/s download, 18 ms to 1.1.1.1.
- IPv6 closed without touching the router: AdGuard -> DNS settings -> **Disable resolving of IPv6 addresses** (`disable_ipv6: true`). Devices get only IPv4 addresses for sites, so they cannot leave through the router's IPv6. Rollback: untick it.
- Router IPv6 on the LAN turned off by the owner (00:30): LAN -> DHCPv6 Server -> **Enable Route Advertisement** unticked, nothing else changed. Checked: no IPv6 default route left on the server or the PC, so no device can leave around the tunnel over IPv6. The router's `fe80::1` stays listed as a DNS server until its advertised lifetime ends or the device reconnects; queries sent there skip AdGuard (no blocking, provider can see them) but still cannot open IPv6 connections. Rollback: tick it again, Apply.
- AdGuard DHCP gateway changed from 192.168.100.1 to 192.168.100.27 (everything else unchanged). Devices move at lease renewal (up to a day) or Wi-Fi reconnect.
- Nuvytrix: integrations line **Home VPN (Mullvad)** and the alert "VPN tunnel down: the home goes out directly through the provider" (once while it lasts, "is back" afterwards), from `/var/log/nuvytrix/vpn.json` (`VPN_STATE_FILE`), checked every 30 s.

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

## Additions 2026-11-20

- **Lease 2 hours** (was 1 day) in AdGuard DHCP: after a rollback of the gateway, devices follow
  within 2 hours by themselves.
- **Phone away from home** (`deploy/vpn/phone-and-dns.sh`): the server offers itself as a Tailscale
  exit node. Its traffic arrives on `tailscale0`, rule 4025 sends it through table 51 like the
  home's (Mullvad, or direct while the tunnel is down; Tailscale masquerades it). DNS of an exit
  node client goes to the server's resolver, which is AdGuard. One-time approval in the Tailscale
  admin console: Machines -> aleksa -> Edit route settings -> Use as exit node. On the phone:
  Tailscale -> Exit node -> aleksa (with "Allow local network access" so home devices stay reachable
  on Wi-Fi).
- **The server's own DNS**: AdGuard first, the router second (netplan), so the provider no longer
  sees the server's lookups while AdGuard runs.

**Incident 2026-11-20 00:37:** `netplan try` (server DNS change) made systemd-networkd reconfigure
enp4s0 and delete the gateway's rules and table-51 LAN route; the home then went out directly (not
through Mullvad) until fixed. Since then the watchdog restores missing rules within 15 s, and
`setup.sh` tells networkd to leave foreign rules and routes alone
(`/etc/systemd/networkd.conf.d/60-nuvytrix-vpn.conf`).

**Server DNS stays on AdGuard (2026-11-20 00:55):** systemd-resolved kept using the router (second
server) after one AdGuard hiccup, so the server's own lookups, and those of phones on the exit
node, skipped AdGuard. The watchdog now moves resolved back to AdGuard within 15 s whenever AdGuard
answers (`dns_prefer_adguard` in gateway.sh). Tailscale DNS: nameserver 192.168.100.27 with "Use
with exit node" (admin console), "Override DNS servers" off.

**Incident 2026-11-20 01:10:** Nuvytrix (8086) and ntfy (8090) did not open from the LAN or over
Tailscale. Docker reaches published ports by DNAT to its bridge networks; the routing decision then
sees a 172.x destination, which rule 4020/4025 sent into table 51 (Mullvad). Fixed with rules
4010/4015: `lookup main suppress_prefixlength 0`, so every destination the main table has a
specific route for (LAN, Docker networks, libvirt) stays local and only traffic that would use the
default route goes to table 51.

**Correction 2026-11-20 11:50:** the watchdog's `dns_prefer_adguard` never worked (`resolvectl dns`
is refused on a link managed by networkd: "Link enp4s0 is managed"); resolved returned to AdGuard
by itself. The real cause of the switching was AdGuard's rate limit dropping the server's bursts
(about 15 queries at once when Nuvytrix checks the sites every minute), even with the server on
the rate-limit whitelist. Fixed in AdGuard: `ratelimit: 300` per device (`ratelimit_subnet_len_ipv4:
32`), `upstream_mode: parallel`, `cache_optimistic: true`. Burst test: 16/56 queries lost before,
0/56 after; no switch to the router in the following minutes. The function was removed.
