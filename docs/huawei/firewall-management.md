# Firewall management (IPv4 filtering)

Analysis of how the router's own page `html/bbsp/ipincoming/ipincoming.asp` reads and writes the
IPv4 filter. Everything below comes from reading the page's JavaScript; **no write request was sent
during the research**.

## Read (implemented)

The page embeds the current state:

| Data | Model | Meaning |
| --- | --- | --- |
| Filter on/off, mode, firewall level | `stPortFilter(domain, ipFilterInRight, ipFilterInPolicy, FirewallLevel)` on `InternetGatewayDevice.X_HW_Security` | `ipFilterInRight` 1 = enabled. `ipFilterInPolicy`: 0 = blacklist, 1 = whitelist, 2 = hybrid (per-rule action and priority) |
| Rules | `stFilterIn(Domain, Priority, Protocol, Direction, SourceIPStart, SourceIPEnd, DestIPStart, DestIPEnd, Action, lanTcpPort, lanUdpPort, wanTcpPort, wanUdpPort, Name)` on `X_HW_Security.IpFilterIn.{i}` | one per rule |

Nuvytrix reads this page (it contains no secrets) and shows the router's real rules and mode next
to the rules planned in Nuvytrix. That is what the "confirmed on router" status is based on.

IPv6 filtering: this firmware's menu has no IPv6 filter page, and no IPv6 filter object was found
in any crawled page. It is **UNSUPPORTED** here; IPv6 traffic is governed only by the router's
built-in firewall level.

## Write requests (documented, not executed)

All writes are `POST` with `application/x-www-form-urlencoded` bodies, the session cookie, and the
page's anti-CSRF token `x.X_HW_Token`. The token is the value of the hidden input `onttoken` on the
page that was loaded. The router answers by re-rendering `RequestFile`.

### Enable or disable filtering
```
POST /set.cgi?x=InternetGatewayDevice.X_HW_Security&RequestFile=html/bbsp/ipincoming/ipincoming.asp
x.IpFilterInRight=1|0
x.X_HW_Token=<onttoken>
```

### Change mode
```
POST /set.cgi?x=InternetGatewayDevice.X_HW_Security&RequestFile=html/bbsp/ipincoming/ipincoming.asp
x.IpFilterInPolicy=0|1|2          (blacklist | whitelist | hybrid)
x.X_HW_Token=<onttoken>
```
The UI asks for confirmation before every mode change, because a **whitelist with no matching
rule blocks all traffic**, including access to the router itself from the LAN.

### Add a rule
```
POST /add.cgi?x=InternetGatewayDevice.X_HW_Security.IpFilterIn&RequestFile=html/bbsp/ipincoming/ipincoming.asp
x.Protocol=<ALL|TCP|UDP|TCP/UDP|ICMP>     exact option values: see "Open questions"
x.Direction=Upstream|Downstream|Bidirectional
x.Name=<rule name>
x.SourceIPStart, x.SourceIPEnd           IPv4, end optional, start <= end
x.DestIPStart,   x.DestIPEnd             IPv4, end optional, start <= end
x.LanSideTcpPort, x.LanSideUdpPort       ports (see below); empty for ALL and ICMP
x.WanSideTcpPort, x.WanSideUdpPort
x.Priority=0..255, x.Action=<value>      hybrid mode only; 255 is reserved for the default rule
x.X_HW_Token=<onttoken>
```

### Edit a rule
Same fields, posted to `set.cgi?x=<rule Domain, e.g. InternetGatewayDevice.X_HW_Security.IpFilterIn.3>&RequestFile=...`.

### Delete rules
```
POST /del.cgi?RequestFile=html/bbsp/ipincoming/ipincoming.asp
<rule Domain>=            one empty-valued field per rule to delete
x.X_HW_Token=<onttoken>
```

### Client-side validation the router UI performs

- IP addresses must be valid unicast IPv4 (`isAbcIpAddress`); an end address requires a start address
  and must not be lower than it.
- Ports: comma-separated list of ports or `start:end` ranges, each 1–65535, with no leading zeros,
  at most 15 ports in total per field, and no overlaps.
- Duplicate rules are rejected (`IpFilterRepeateCfgChk`).
- In hybrid mode the priority is required and must be 0–255.

The router's server-side validation is unknown. Nuvytrix must validate everything itself and
treat any router response other than the re-rendered page as a failure.

## Open questions before enabling writes

1. Exact `x.Protocol` option values and `x.Action` values in hybrid mode. They are built at runtime
   from language tables, and the page source alone is not conclusive.
2. How the router reports a rejected write (error page, alert script, or silently ignored).
3. Whether a write takes effect immediately or needs the page to be reloaded.
4. Whether the ISP's TR-069 provisioning overwrites user filter rules.

These can only be answered by one supervised test on the real router: add a harmless blacklist
rule (for example deny TCP to an unused LAN address such as 192.168.100.250), read the list back,
then delete it and read again, with the administrator watching.

## Safety design for write support (not yet enabled)

- Disabled by default (`ROUTER_FIREWALL_WRITES=false`); enabling it is a server configuration change.
- Every write requires an explicit confirmation in the UI and is written to the audit log with the
  before and after state.
- **Lockout guard:** a whitelist switch is refused unless the rule set already allows the server and the
  administrator's address; deny rules that match the router address (192.168.100.1) from the LAN are
  refused.
- After every write, the rule list is read back and compared; on mismatch the change is reported as
  failed, with the exact rule to remove manually.
- Rollback guidance: the deleted or previous rule is stored in the audit log so it can be recreated.
  Disabling filtering (`x.IpFilterInRight=0`) is the emergency off switch, from the router UI if
  Nuvytrix cannot reach it.
