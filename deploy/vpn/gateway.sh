#!/usr/bin/env bash
# Installed as /usr/local/sbin/nuvytrix-vpn-gateway by deploy/vpn/setup.sh (docs/vpn.md).
#   up     routing rules, NAT, MSS clamping (idempotent)
#   down   removes them; devices using the server as gateway then go out directly
#   check  watchdog: table 51 default through the tunnel while it works, else via the router
# Devices listed in /etc/nuvytrix-vpn-bypass (one LAN IPv4 address per line) always go direct.
set -euo pipefail

LAN=192.168.100.0/24
IF=enp4s0
ROUTER=192.168.100.1
WG=mullvad
TABLE=51
PROBE_TABLE=50 # always the tunnel: probes must never leave unencrypted
PROBE=10.64.0.1 # Mullvad's address inside the tunnel
FAILS_TO_SWITCH=3
STATE=/var/log/nuvytrix/vpn.json # read-only for Nuvytrix (adm), like sshd.log
RUN=/run/nuvytrix-vpn
BYPASS=/etc/nuvytrix-vpn-bypass

probe_route() {
  local w
  w=$(wg_ip)
  [ -n "$w" ] || return 0
  ip rule show priority 4030 | grep -q . || ip rule add priority 4030 from "$w" lookup "$PROBE_TABLE"
  ip route replace default dev "$WG" table "$PROBE_TABLE"
}
wg_ip() { ip -4 -o addr show dev "$WG" 2>/dev/null | awk '{print $4}' | cut -d/ -f1; }
ipt() { iptables -t "$1" -C "${@:2}" 2>/dev/null || iptables -t "$1" -A "${@:2}"; }
iptd() { while iptables -t "$1" -D "${@:2}" 2>/dev/null; do :; done; }
rules_flush() { while ip rule del priority "$1" 2>/dev/null; do :; done; }

write_state() { # mode reason
  mkdir -p "$RUN"
  local since now
  now=$(date -u +%FT%TZ)
  since=$now
  if [ -f "$RUN/mode" ] && [ "$(cat "$RUN/mode")" = "$1" ] && [ -f "$RUN/since" ]; then
    since=$(cat "$RUN/since")
  else
    echo "$1" > "$RUN/mode"
    echo "$since" > "$RUN/since"
    logger -t nuvytrix-vpn "home traffic now: $1 ($2)"
  fi
  printf '{"mode":"%s","since":"%s","checkedAt":"%s","reason":"%s"}\n' "$1" "$since" "$now" "$2" > "$STATE.tmp"
  chown root:adm "$STATE.tmp"
  chmod 0640 "$STATE.tmp"
  mv "$STATE.tmp" "$STATE"
}

add_rules() {
  # Order: bypass devices (4000), local and Docker destinations (4010/4015), the rest (4020/4025);
  # the tunnel's own address (4030, table 50: always the tunnel) for the watchdog's probes. Traffic to the server itself
  # is matched by the local table first and never reaches these rules.
  rules_flush 4000; rules_flush 4010; rules_flush 4015; rules_flush 4020; rules_flush 4025; rules_flush 4030
  if [ -f "$BYPASS" ]; then
    grep -Eo '^192\.168\.100\.[0-9]{1,3}' "$BYPASS" | while read -r ip; do
      ip rule add priority 4000 iif "$IF" from "$ip" lookup main
    done
  fi
  # Anything the main table has a specific route for stays local: the LAN itself, and the Docker
  # networks behind published ports (Nuvytrix 8086, ntfy 8090), which Docker reaches by DNAT. Only
  # traffic that would use the main default route goes on to table 51.
  ip rule add priority 4010 iif "$IF" lookup main suppress_prefixlength 0
  ip rule add priority 4015 iif tailscale0 lookup main suppress_prefixlength 0
  ip rule add priority 4020 iif "$IF" from "$LAN" lookup "$TABLE"
  # Phones using the server as Tailscale exit node go out the same way (Tailscale masquerades
  # them itself); table 51 keeps the LAN route, so they still reach home devices.
  ip rule add priority 4025 iif tailscale0 lookup "$TABLE"
  ip route replace "$LAN" dev "$IF" table "$TABLE"
  probe_route
}

up() {
  add_rules
  # Start direct; the first check switches to the tunnel once it answers.
  ip route replace default via "$ROUTER" dev "$IF" table "$TABLE"

  ipt nat POSTROUTING -s "$LAN" -o "$WG" -j MASQUERADE
  ipt nat POSTROUTING -s "$LAN" ! -d "$LAN" -o "$IF" -m addrtype ! --src-type LOCAL -j MASQUERADE
  ipt mangle FORWARD -o "$WG" -p tcp --tcp-flags SYN,RST SYN -j TCPMSS --clamp-mss-to-pmtu
  write_state direct "starting"
}

down() {
  rules_flush 4000; rules_flush 4010; rules_flush 4015; rules_flush 4020; rules_flush 4025; rules_flush 4030
  ip route flush table "$TABLE" 2>/dev/null || true
  ip route flush table "$PROBE_TABLE" 2>/dev/null || true
  iptd nat POSTROUTING -s "$LAN" -o "$WG" -j MASQUERADE
  iptd nat POSTROUTING -s "$LAN" ! -d "$LAN" -o "$IF" -m addrtype ! --src-type LOCAL -j MASQUERADE
  iptd mangle FORWARD -o "$WG" -p tcp --tcp-flags SYN,RST SYN -j TCPMSS --clamp-mss-to-pmtu
  write_state off "gateway stopped"
}

check() {
  mkdir -p "$RUN"
  local w ok=0 hs now fails
  # systemd-networkd removes rules it did not create when it reconfigures the link (e.g. netplan
  # apply); put them back within one check.
  if ! ip rule show priority 4015 | grep -q . || ! ip rule show priority 4020 | grep -q . || ! ip route show table "$TABLE" | grep -q "^$LAN"; then
    add_rules
    logger -t nuvytrix-vpn "routing rules were missing, restored"
  fi
  probe_route
  w=$(wg_ip)
  now=$(date +%s)
  hs=$(wg show "$WG" latest-handshakes 2>/dev/null | awk '{print $2}' | head -1)
  if [ -n "$w" ] && [ -n "$hs" ] && [ $((now - hs)) -lt 180 ] &&
    ping -c 1 -W 3 -I "$w" "$PROBE" >/dev/null 2>&1; then
    ok=1
  fi
  if [ $ok = 1 ]; then
    echo 0 > "$RUN/fails"
    ip route replace default dev "$WG" table "$TABLE"
    write_state vpn "tunnel answers"
  else
    fails=$(($(cat "$RUN/fails" 2>/dev/null || echo 0) + 1))
    echo "$fails" > "$RUN/fails"
    if [ "$fails" -ge "$FAILS_TO_SWITCH" ] || [ "$(cat "$RUN/mode" 2>/dev/null)" != vpn ]; then
      ip route replace default via "$ROUTER" dev "$IF" table "$TABLE"
      write_state direct "tunnel not answering"
    fi
  fi
}

case "${1:-}" in
  check) check ;;
  up) up ;;
  down) down ;;
  *) echo "usage: $0 up|down|check"; exit 2 ;;
esac
