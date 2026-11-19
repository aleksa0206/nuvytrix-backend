#!/bin/bash
# Prepares the server for AdGuard Home as the home's DHCP server (docs/adguard.md, "AdGuard as DHCP").
# Run once, at the server's keyboard or over SSH, with sudo:
#
#   sudo bash ~/nuvytrix/nuvytrix-backend/deploy/adguard/host-setup.sh
#
# 1. Fixed address: enp4s0 keeps 192.168.100.27/24 without asking DHCP (the server cannot get its
#    own address from the DHCP server running on it). IPv6 (router advertisements) is unchanged.
#    Applied with `netplan try`: press ENTER within 120 s to keep it; otherwise it rolls back by itself.
# 2. Firewall: DNS (53), DHCP (67) and the AdGuard admin page (3000) open on the LAN interface only.
#    Needed because AdGuard then runs on the host network, where ufw applies.
#
# Undo: sudo rm /etc/netplan/60-nuvytrix-static.yaml && sudo netplan apply
#       sudo ufw delete allow in on enp4s0 to any port 67 proto udp   (and the 53/3000 rules)
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "Run with sudo" >&2; exit 1; }

cat > /etc/netplan/60-nuvytrix-static.yaml <<'CONF'
# Nuvytrix: fixed LAN address, because AdGuard Home on this server is the home's DHCP server.
network:
  version: 2
  ethernets:
    enp4s0:
      dhcp4: false
      addresses: [192.168.100.27/24]
      routes:
        - to: default
          via: 192.168.100.1
      # The server keeps resolving through the router, never through its own container.
      nameservers:
        addresses: [192.168.100.1]
CONF
chmod 600 /etc/netplan/60-nuvytrix-static.yaml
# cloud-init must not rewrite the network config on the next boot.
echo 'network: {config: disabled}' > /etc/cloud/cloud.cfg.d/99-nuvytrix-network.cfg

ufw allow in on enp4s0 from 192.168.100.0/24 to any port 53 comment 'AdGuard DNS'
ufw allow in on enp4s0 to any port 67 proto udp comment 'AdGuard DHCP'
ufw allow in on enp4s0 from 192.168.100.0/24 to any port 3000 proto tcp comment 'AdGuard admin'
# IPv6 DNS on the server's link-local address (the router hands it out as the home's IPv6 DNS).
ufw allow in on enp4s0 from fe80::/10 to any port 53 comment 'AdGuard DNS IPv6 link-local'

echo
echo "Applying the fixed address. Press ENTER when asked to keep it (SSH stays connected)."
netplan try --timeout 120
ip -4 -br addr show enp4s0
