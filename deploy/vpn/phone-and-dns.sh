#!/usr/bin/env bash
# Two additions to the home VPN (docs/vpn.md), run once as root:
#
#   sudo bash ~/nuvytrix/nuvytrix-backend/deploy/vpn/phone-and-dns.sh
#
# 1. The server offers itself as a Tailscale exit node. A phone that selects it away from home
#    sends everything through the server and Mullvad, and its DNS through the server's resolver,
#    which is AdGuard after step 2. The exit node must still be approved once in the Tailscale
#    admin console (Machines -> aleksa -> Edit route settings -> Use as exit node).
# 2. The server's own DNS goes to AdGuard (encrypted upstreams) instead of the router (plain text
#    to the provider). The router stays listed second, so the server still resolves names when
#    AdGuard is down. Applied with `netplan try`: press ENTER to keep it.
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
NETPLAN=/etc/netplan/60-nuvytrix-static.yaml

[ "$(id -u)" = 0 ] || { echo "run with sudo"; exit 1; }
[ -f "$NETPLAN" ] || { echo "ABORT: $NETPLAN not found"; exit 1; }
nslookup -timeout=3 example.com 192.168.100.27 >/dev/null || { echo "ABORT: AdGuard does not answer"; exit 1; }

# Gateway: exit-node traffic from tailscale0 uses the same table as the home.
install -m 0755 "$HERE/gateway.sh" /usr/local/sbin/nuvytrix-vpn-gateway
/usr/local/sbin/nuvytrix-vpn-gateway up
/usr/local/sbin/nuvytrix-vpn-gateway check
echo "gateway: $(cat /var/log/nuvytrix/vpn.json)"

tailscale set --advertise-exit-node
echo "tailscale: exit node offered (approve it once in the admin console)"

cp -a "$NETPLAN" "$NETPLAN.bak-$(date +%Y%m%d%H%M)"
sed -i \
  -e 's|^      # The server keeps resolving through the router, never through its own container.|      # AdGuard first (encrypted upstreams); the router second, for when AdGuard is down.|' \
  -e 's|^        addresses: \[192.168.100.1\]|        addresses: [192.168.100.27, 192.168.100.1]|' \
  "$NETPLAN"
grep -q 'addresses: \[192.168.100.27, 192.168.100.1\]' "$NETPLAN" || { echo "ABORT: netplan file not as expected, unchanged"; exit 1; }

echo
echo "Applying the DNS change. Press ENTER when asked to keep it."
netplan try --timeout 60
resolvectl dns enp4s0
nslookup -timeout=3 example.com >/dev/null && echo "ok: the server resolves names"
