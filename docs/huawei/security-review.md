# Security review: Telnet and the AnyDesk UPnP mapping

Findings from the router research on 2026-11-15, with the safest way to deal with each. Nuvytrix
did not change anything on the router; both fixes are done by the administrator in the router UI.

## 1. Telnet open on the LAN (TCP 23)

**What was observed**

- TCP 23 answers from the LAN with `Welcome Visiting Huawei Home Gateway` and a login prompt.
- The web administrator account (`admin`) is refused. The CLI account is separate, most likely
  provisioned by the ISP.
- The setting that controls it is on **Advanced → Security → Device Access Control**
  (`html/bbsp/acl/aclsmart.asp`), model `stAclInfo(domain, TelnetLanEnable, HTTPWifiEnable, TELNETWifiEnable)`
  on `InternetGatewayDevice.X_HW_Security.AclServices`.

**Why it matters**

- Telnet sends the login in clear text; any device on the LAN or Wi-Fi can try to log in.
- ISP CLI accounts on these devices have well-known default passwords published online. A
  compromised device on the network (or a guest) could try them and gain full control of the router.
- Nothing in Nuvytrix or in normal use needs Telnet.

**Safest way to disable it**

1. Open http://192.168.100.1 from a wired PC and sign in.
2. Go to **Advanced → Security → Device Access Control**.
3. Untick Telnet for **LAN** and for **Wi-Fi**. Leave **HTTP** enabled for LAN, otherwise you lock
   yourself out of the web UI.
4. Apply. Do not change anything else on that page.
5. Verify from the server: `nmap -Pn -p 23 192.168.100.1` should report the port as closed or filtered.

If the web UI becomes unreachable after a change on this page, the recovery path is the router's
reset button. That restores ISP defaults and loses Wi-Fi and filter settings, which is why only the
Telnet boxes should be touched.

**Caveat:** the ISP manages this device over TR-069 and can re-enable Telnet. Re-check after
firmware updates or provider maintenance. A periodic TCP check of port 23 is a simple way to notice.

## 2. AnyDesk port opened through UPnP

**What was observed**

UPnP `GetGenericPortMappingEntry(0)`: external TCP **40628** → `<LAN PC>`:**7070**, description
`AnyDesk`, enabled, lease 0 (permanent until removed or reboot). Port 7070 is AnyDesk's "direct
connection" listener; the AnyDesk client opened the mapping itself.

**Exposure**

- **IPv4 from the internet:** not reachable. The WAN address is CGNAT (100.64.0.0/10), so the
  mapping ends at the ISP's NAT, which does not forward unsolicited traffic.
- **Inside the ISP's network:** other subscribers behind the same carrier network may be able to
  reach the router's CGNAT address directly, and through the mapping, the PC's AnyDesk listener.
  This depends on the ISP's isolation, which cannot be checked from here.
- **IPv6:** the router advertises only UPnP IGD v1 (IPv4 port mappings). No IPv6 pinhole service
  (`WANIPv6FirewallControl`) was found, so the mapping does not open anything over IPv6.

**Why it matters**

- AnyDesk becomes reachable without going through its relay, so the only protection is the
  AnyDesk access settings on that PC: unattended-access password, access control list and 2FA.
- More generally, UPnP lets any program on the LAN open inbound ports without asking. Malware
  uses this too.

**Recommended options, safest first**

1. In AnyDesk, under **Settings → Connection**, turn off **Allow direct connections**. AnyDesk then
   uses its relay and stops requesting the mapping; remote access keeps working.
2. If unattended access is used: a long password, two-factor authentication, and an access list
   that only allows your own AnyDesk IDs.
3. Optionally disable UPnP on the router (**Advanced → Application → UPnP**). This also stops
   consoles and games from opening ports; with CGNAT those mappings do not help much anyway.

Nuvytrix shows all UPnP mappings on Router → Firewall & UPnP, so a new mapping is visible.
