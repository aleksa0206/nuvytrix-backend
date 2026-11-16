# IPv6 on the LAN (read only, 2026-11-16)

Page `/html/bbsp/lanaddress/lanaddress.asp`. Data models (first occurrence; the page repeats them):

| Model | Fields | Found |
| --- | --- | --- |
| `Br0IPv6PrefixClass` | domain, Alias, ParentPrefix, ChildPrefixMask, Mode, Prefix, PreferredLifeTime, ValidLifeTime | `WANDelegated`, provider /64 |
| `RaConfigInfoClass` (`LANDevice.1.X_HW_RouterAdvertisement`) | domain, ManagedFlag, OtherConfigFlag, mode, Enable, MTU | on, M=0, O=1 (SLAAC, DNS over DHCPv6), MTU 1500 |
| `DhcpV6Server` (`LANDevice.1.X_HW_DHCPv6.Server`) | domain, Enable, DHCPv6LeaseTime | on |
| `IPv6DNSConfigClass` (`LANDevice.1.X_HW_IPv6Config`) | domain, DomainName, IPv6DNSConfigType, IPv6DNSWANConnection, IPv6DNSServers | `HGWProxy`, `fe80::1` |
| `stLanDhcp6Info` (`X_HW_DHCPv6.Server.Pool.1`) | domain, MinAddress, MaxAddress, IAPDAddLength | ::1 – ::100, 64 |

The page saves all of it in one `set.cgi` with objects x, y, m, z, q, r, p, n, o, t (address, prefix,
RA, LAN binding, pool, DHCPv6 server, DNS, ULA mode and prefix, PD length).

**Why Nuvytrix does not write here:** the current setup is the working default from the provider,
nothing in normal use needs changing, and a wrong RA, prefix or DHCPv6 value cuts IPv6 for every
device. The owner skipped the IPv6 DNS change. Nuvytrix shows the state (`GET /router/ipv6`,
Router → DHCP & DNS).
