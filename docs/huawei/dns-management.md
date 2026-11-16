# DNS management

## Static DNS entries (supported)

Application → Static DNS: names the router answers itself, for devices that use it as their DNS
server (all DHCP clients today, since the DHCP DNS list is empty). Changes use the router page's own
requests, are switched on with `ROUTER_WRITES_ENABLED`, are read back and audited
(`router.dns_host_created|updated|deleted`).

| Page | Path | Use |
| --- | --- | --- |
| Form | `/html/bbsp/dnsconfiguration/dnshosts.asp` | token; CGIs relative to its folder |
| Data | `/html/bbsp/common/dnshostslist.asp` | `DnsHostsItemClass(domain, IPAddress, DomainName)`, read back after every write |

| Change | URL (`&RequestFile=html/bbsp/dnsconfiguration/dnshosts.asp`) | Body |
| --- | --- | --- |
| Add | `add.cgi?x=InternetGatewayDevice.X_HW_DNS.HOSTS` | `x.IPAddress`, `x.DomainName` |
| Change | `set.cgi?x=<entry>` | the same |
| Delete | `del.cgi?x=InternetGatewayDevice.X_HW_DNS.HOSTS` | `<entry>=` |

Rules: at most 20 entries (the router page's limit), one entry per name, names are host names
(`nas.lan`), addresses IPv4 or IPv6, one of each per name (as the router page allows). IPv6 verified
through Nuvytrix on 2026-11-16 (`nuvytrix-test6.lan` → `fd00::250`, added and deleted).

Verified 2026-11-16: by script, then through the deployed Nuvytrix (`nuvytrix-test.lan` → `.250`,
changed to `.251`, deleted; a second entry for the same name refused).

## Dynamic DNS (supported)

Application → DDNS, on the internet WAN connection. Page `/html/bbsp/ddns/ddns.asp`:
`stDdns(domain, Enable, Provider, Username, Port, DomainName, HostName, SaltAddress, Status,
LastError, LastUpdateTime)`; the page never contains the password.

| Change | URL (`&RequestFile=html/bbsp/ddns/ddns.asp`) | Body |
| --- | --- | --- |
| Add | `add.cgi?x=<WAN>.X_HW_DDNSConfiguration` | `x.DDNSCfgEnabled`, `x.DDNSProvider`, `x.DDNSUsername`, `x.DDNSPassword`, `x.ServicePort`, `x.DDNSDomainName`, `x.DDNSHostName` (update server) |
| Change | `set.cgi?x=<entry>` | the same; `x.DDNSPassword` only when it changes |
| Delete | `del.cgi` | `<entry>=` |

Rules: at most four entries per WAN (router page), one entry per name; providers dyndns,
dyndns-static, dyndns-custom, no-ip, easydns, dtdns, qdns, qdns-static, ORAY (gnudip needs a salt
address and is not offered). The password is write-only and recorded as `[changed]` in the audit log.

Verified 2026-11-16 by script and through the deployed Nuvytrix with a disabled, made-up entry
(never sent to a provider): added, renamed with the password left unchanged, deleted.

## DNS servers handed out by DHCP (not supported)

The DHCP page posts `z.X_HW_DNSList` (comma-separated) with the main pool. On 2026-11-16 a request
with the pool fields unchanged and `z.X_HW_DNSList=192.168.100.1` got no answer from the router
(timeout after 20 s), and the read-back showed the list unchanged (empty). The router stayed
reachable and DNS kept working. The router's own page sends more fields in this request
(`z.DHCPServerEnable`, relay and option 125 flags, and the secondary pool objects); which of them it
needs is not known. Not retried without the owner's approval, because a wrong value changes DNS for
every device.

**Lesson from that run:** after the timeout the router session was no longer valid, and the test
script read an empty list where it expected data, so it reported a cleanup as done although the test
entry was still there (Nuvytrix removed it later). Nuvytrix itself treats a page without the expected
data as an error (502), never as "empty".
