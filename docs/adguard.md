# AdGuard Home: DNS filtering for the home

## Deployment (NVX-14, 2026-11-16)

| Item | Value |
| --- | --- |
| Where | Ubuntu server, separate compose project `adguard` (`deploy/adguard/docker-compose.yml`), so a Nuvytrix deploy never restarts DNS |
| Version | pinned `adguard/adguardhome:v0.107.80` (since 2026-11-19). Upgrade by hand: change the tag, `docker compose -p adguard up -d`, then check DNS, DHCP and the `ss -lntup` binding |
| DNS | `192.168.100.27:53` UDP and TCP, LAN address only (not 0.0.0.0, not Tailscale, never forwarded on the router). `systemd-resolved` (127.0.0.53/54) and libvirt's dnsmasq (192.168.122.1) are untouched |
| Admin UI | `http://192.168.100.27:3000`, LAN only |
| Credentials | user `nuvytrix`, password generated on the server and stored only in `~/nuvytrix/nuvytrix-backend/.env` (`ADGUARD_PASSWORD`); Nuvytrix uses the same account |
| Data | `deploy/adguard/data` on the server (root-owned, not in git, not in the API build context) |
| Upstreams | DNS-over-HTTPS: Quad9 and Cloudflare (bootstrap 9.9.9.9, 1.1.1.1); private reverse lookups to the router 192.168.100.1 |
| Filtering | AdGuard DNS filter (~190 000 rules) |
| Logs | query log and statistics kept 7 days (household privacy: every DNS name a device asks for is recorded) |
| Restart | `restart: unless-stopped`; health check resolves through itself every 30 s |

The server itself resolves through AdGuard first and the router second (since 2026-11-20, deploy/vpn/phone-and-dns.sh), so it still resolves names when AdGuard is down.

## In Nuvytrix (NVX-15)

DNS page: status, totals and blocked share, top domains, top blocked, top clients (named after
Nuvytrix devices), upstream answer times, the latest queries (search, blocked only) and allow/block
rules for single domains. Rules are written as `||domain^` (block) and `@@||domain^` (allow); other
custom rules are kept untouched. Every rule change is audited. Domains are validated as host names,
so no AdGuard rule syntax can be injected.

## Health and alerts (NVX-16)

- Monitoring target **AdGuard DNS** (DNS check of `example.com` at 192.168.100.27 every minute):
  alert "AdGuard DNS is not answering" after two failed checks, "is back" when it answers.
- Container monitoring: "Container adguard-adguard-1 stopped / is running again / restarted".
- Verified 2026-11-16: container stopped for 3 minutes → both alerts arrived, then both recovery
  alerts; it came back healthy and resolving. Queries from the admin PC (192.168.100.2) resolve,
  `doubleclick.net` is blocked (0.0.0.0), clients are seen with their real address.

## Recovery

| Situation | What to do |
| --- | --- |
| AdGuard not answering, server up | `cd ~/nuvytrix/nuvytrix-backend/deploy/adguard && docker compose -p adguard up -d` |
| Bad settings | Fix in the admin UI, or stop the container and restore `data/conf/AdGuardHome.yaml` from a copy |
| Server down for long | **Roll back the home's DNS** (below); devices then use the router again |

## Single point of failure

There is one DNS server. If the server (a laptop) is down, every device that was given AdGuard as
its DNS cannot resolve names once its DHCP lease renews or it reconnects. There is deliberately no
second, unfiltered DNS server handed out next to it, because devices would use it at random and
bypass the filter. This is a known limitation of the current hardware, not a configuration error.

## Bypasses (NVX-17 findings)

| Path | Effect | Can it be closed with this hardware? |
| --- | --- | --- |
| **IPv6 DNS** | The router advertises itself (`fe80::1`) as IPv6 DNS through DHCPv6 (RA "O" flag). Devices that prefer IPv6 DNS keep asking the router, which forwards to the provider: no filtering for those queries. | Only by changing the router's IPv6 DNS setting to the server's IPv6 address. That is in the one form that saves the whole IPv6 LAN configuration (docs/huawei/ipv6.md), and the server's global IPv6 address follows the provider's prefix, which can change. Not done. |
| DNS-over-HTTPS in browsers (Chrome/Edge "secure DNS", Firefox DoH) | The browser resolves itself, skipping AdGuard. | Partly: AdGuard answers the canary domain `use-application-dns.net` with NXDOMAIN when filtering is on, which turns Firefox's automatic DoH off. Chrome/Edge only use DoH automatically when the configured DNS supports it, which AdGuard does not advertise. Manually enabled DoH cannot be stopped without a firewall. |
| Android "Private DNS" (DNS-over-TLS) | Same, if set to a provider. | No (needs blocking port 853 on the router's firewall; possible later with the IPv4 filter). |
| VPN apps | DNS goes through the VPN. | No. |
| Devices with static DNS settings | Unaffected by DHCP. | Change them on the device. |

## Whole-home DNS through the router: not possible with this account (2026-11-19)

The owner approved the switch on 2026-11-19. The full main-pool form with every value re-sent
unchanged and `z.X_HW_DNSList=192.168.100.27` timed out after 40 s, and the read-back showed nothing
changed (the same as on 2026-11-16). The reason is in the page itself: `LoadFrame()` of dhcp2.asp
runs `if ((IsAdminUser() == false) && (IsSonetUser() == false)) setDisable("dnsMainPri", 1)`, so the
DNS fields are locked for the account Nuvytrix and the owner use; only the provider's administrator
account may set them. The DHCP L2 relay (used by the TV ports) is unrelated and stays on.

What remains possible:

- **Per device:** set DNS `192.168.100.27` on the phones and computers that matter (Wi-Fi settings of
  the home network only; mobile data and other networks are unaffected).
- **Ask the provider** to set the DHCP DNS, or for administrator access.

The Nuvytrix switch for this (added 2026-11-17) was removed again, since it can never succeed here.

## AdGuard as the home's DHCP server (approved 2026-11-19)

Because the router locks the DHCP DNS fields, AdGuard hands out the addresses instead: then every
device that joins gets AdGuard as DNS by itself.

| Step | Who | What |
| --- | --- | --- |
| 1 | owner, `sudo bash deploy/adguard/host-setup.sh` | fixed address 192.168.100.27 on enp4s0 (`netplan try`), ufw opens 53/67/3000 on enp4s0 |
| 2 | Claude | AdGuard to the host network (`docker-compose.yml`), DNS and admin bound to 192.168.100.27 |
| 3 | Claude | AdGuard DHCP configured, still off: enp4s0, gateway 192.168.100.1, /24, range .30–.254, lease 1 day; the admin PC keeps .2 as a static lease |
| 4 | owner + Claude, together, TV on | router: LAN → DHCP Server, untick **Enable Primary DHCP Server**, Apply; AdGuard DHCP on right after; check the TV, reconnect a phone |

**Binding is checked, not assumed:** on the host network, a setting of `0.0.0.0` in
AdGuardHome.yaml (not in git) would also expose DNS and the admin page on the Tailscale address,
where Tailscale's own firewall chain accepts traffic before ufw. After every change Nuvytrix's setup
step checks with `ss -lntup` that 53 and 3000 listen on 192.168.100.27 only.

**Done 2026-11-19 (evening):** host setup run (fixed address; note: ufw is installed but
**inactive** on this server, so its rules are on record only), AdGuard on the host network bound to
192.168.100.27 and `fe80::7a84:3cff:fe04:c314%enp4s0` (the server's link-local address, derived
from its MAC, so it does not change with the provider's prefix), AdGuard DHCP on (range .30–.254,
admin PC static .2), router DHCP off. IPv6: router → LAN → DHCPv6 Server → DNS Source **Static**,
preferred `fe80::7a84:3cff:fe04:c314` (Parent Prefix stays empty, as stored). Checked: the PC got
.2 with DNS 192.168.100.27 from AdGuard and the new IPv6 DNS from the router; `doubleclick.net` is
blocked over both. The router's `fe80::1` was still listed next to it right after the change (older
advertisement still valid).

IPv6 rollback: DHCPv6 Server → DNS Source back to **DNS agent**, Apply.

**Rollback (one minute):** tick **Enable Primary DHCP Server** again on the router, Apply; turn
AdGuard DHCP off (AdGuard → Settings → DHCP). Devices are back on the router at their next renewal or
reconnect.

**In Nuvytrix (NVX-28):** Router → DHCP shows AdGuard's DHCP (read only, `GET /api/dns/dhcp`)
above the router's own panel. Discovery takes a device's host name from its AdGuard lease when nmap
finds none (the router no longer learns names). Every 5 minutes Nuvytrix checks that AdGuard's DHCP
is on: alert "AdGuard DHCP is off" once while it lasts, "is on again" when it is back. Nuvytrix
never changes AdGuard's DHCP settings.

**Known limits:** if the server is down, newly joining devices get no address (others keep theirs
until the lease ends, up to a day); devices preferring the router's IPv6 DNS (`fe80::1`) still bypass
AdGuard for some queries (see Bypasses). The router's L2 relay (TV ports) is not touched.

## Whole-home DNS proposal (NVX-17, not applied)

Target: every DHCP client gets `192.168.100.27` as DNS.

1. Preconditions (all met on 2026-11-16 except the one-day trial): AdGuard healthy for a day, a
   device using it for a day without complaints, the DNS alert works, this rollback is tested.
2. Change on the router: LAN → DHCP Server, field "Primary DNS server" = `192.168.100.27` (the page
   posts `z.X_HW_DNSList` together with the pool settings). The earlier attempt to write only
   `z.X_HW_DNSList` timed out (docs/huawei/dns-management.md); the change has to send the same set of
   fields the router's own page sends, verified by reading the page back, never assumed.
3. Devices pick it up as their leases renew (lease time on this router: about a day) or when they
   reconnect; nothing changes for devices with static settings.
4. Verify: query log shows the devices, `nslookup` on a phone and the PC returns AdGuard answers.

**What the router's page actually sends (read 2026-11-17, not executed):** the DNS list is saved
only together with the whole main DHCP pool, in one `set.cgi` on
`z=InternetGatewayDevice.LANDevice.1.LANHostConfigManagement`: `z.DHCPServerEnable`,
`z.X_HW_DHCPL2RelayEnable`, `z.X_HW_Option125Enable`, `z.X_HW_DNSList` (primary,secondary),
`z.MinAddress`, `z.MaxAddress`, `z.DHCPLeaseTime`, and depending on the firmware mode also the LAN
interface address. The earlier attempt sent only the pool and the DNS list and timed out. Doing it
right means reading the current relay and option-125 flags exactly and sending them back unchanged;
a wrong L2-relay value would stop DHCP for every device. Not done until the one-day trial has
passed and the change can be tested with the router itself as DNS (no functional change) first.

**Rollback:** set the DHCP DNS field back to empty (the router then hands out itself, as today);
devices follow on their next renewal, or immediately after turning Wi-Fi off and on. Anyone at home
can do this in the router's web page at `http://192.168.100.1` without a working DNS.

**Risk:** if the server is down, the home has no name resolution until the rollback or the server is
back (see "Single point of failure").
