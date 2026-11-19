#!/usr/bin/env bash
# Turns on the server's firewall (ufw) with only what the home needs open. Run once, as root:
#
#   sudo bash ~/nuvytrix/nuvytrix-backend/deploy/firewall/ufw-setup.sh
#
# Safety net: right before enabling, a timer is started that turns ufw off again after 3 minutes.
# The script then asks you to open a NEW SSH session; only when you answer "yes" is the timer
# stopped. If your connection drops, wait 3 minutes and everything is open again, as before.
#
# What stays reachable (inventory of 2026-11-19, docs/firewall.md):
#   - SSH 22: from the home LAN and over Tailscale (not from the internet)
#   - AdGuard: DNS 53 and DHCP 67 from the LAN, admin page 3000 from the LAN, DNS over IPv6
#     link-local
#   - Tailscale: everything on tailscale0, and its direct-connection port 41641/udp
#   - Nuvytrix web container -> API (172.31.250.0/29 -> 172.31.250.1:4000)
#   - The six sites: they use Cloudflare tunnels (outgoing only), nothing to open
#   - Ports Docker publishes (Nuvytrix 8086, ntfy 8090) are handled by Docker's own rules, not ufw
# Outgoing traffic is not restricted. WireGuard wg0 (51820/udp, no traffic since boot) stays
# closed; open it with: sudo ufw allow 51820/udp
set -euo pipefail

LAN=192.168.100.0/24
IF=enp4s0
SERVER=192.168.100.27

[ "$(id -u)" = 0 ] || { echo "run with sudo"; exit 1; }
ip -br addr show "$IF" | grep -q "$SERVER/24" || { echo "ABORT: $IF does not have $SERVER"; exit 1; }
ip link show tailscale0 >/dev/null || { echo "ABORT: tailscale0 not found"; exit 1; }

# Known state: the old rules (from host-setup.sh) are backed up by ufw itself, then re-added here.
ufw --force reset >/dev/null
ufw default deny incoming
ufw default allow outgoing
ufw default deny routed # Docker's own forwarding rules come first and are unaffected

ufw allow in on "$IF" from "$LAN" to any port 22 proto tcp comment 'SSH from LAN'
ufw allow in on tailscale0 comment 'Tailscale: SSH, Nuvytrix, ntfy'
ufw allow 41641/udp comment 'Tailscale direct connections'

ufw allow in on "$IF" from "$LAN" to "$SERVER" port 53 comment 'AdGuard DNS'
ufw allow in on "$IF" from fe80::/10 to any port 53 comment 'AdGuard DNS over IPv6 link-local'
ufw allow in on "$IF" to any port 67 proto udp comment 'AdGuard DHCP (clients have no address yet)'
ufw allow in on "$IF" from "$LAN" to "$SERVER" port 3000 proto tcp comment 'AdGuard admin'

ufw allow from 172.31.250.0/29 to 172.31.250.1 port 4000 proto tcp comment 'Nuvytrix web -> API'

UNIT=nuvytrix-ufw-rollback
systemctl stop "$UNIT.timer" 2>/dev/null || true
systemd-run --quiet --unit="$UNIT" --on-active=180 /usr/sbin/ufw disable
ufw --force enable
ufw status verbose

echo
echo "Firewall is ON. It turns itself OFF again in 3 minutes unless you confirm."
echo "Now open a NEW terminal and run:  ssh aleksa@100.95.162.58"
echo "If that works (and http://100.95.162.58:8086 opens), type yes here."
read -r -t 170 -p "Keep the firewall? (yes/no) " answer || answer=""
if [ "$answer" = yes ]; then
  systemctl stop "$UNIT.timer"
  echo "ok: firewall stays on (rollback timer stopped)"
else
  ufw disable
  systemctl stop "$UNIT.timer" 2>/dev/null || true
  echo "firewall turned OFF again, nothing else changed"
fi
