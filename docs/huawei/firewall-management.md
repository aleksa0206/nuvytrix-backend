# Firewall management (IPv4 filtering)

Analysis of how the router's own page `html/bbsp/ipincoming/ipincoming.asp` reads and writes the
IPv4 filter. The request formats come from the page's JavaScript; add and delete were then
verified on the real router on 2026-11-16 (see "Verification").

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

## Write requests

All writes are `POST` with `application/x-www-form-urlencoded` bodies, the session cookie, and the
page's anti-CSRF token `x.X_HW_Token`. The token is the value of the hidden input `onttoken` on the
page that was loaded. The router answers by re-rendering `RequestFile`.

**The `*.cgi` paths are relative to the page directory**, because the page builds the form with
`setAction('add.cgi?...')`. The real URLs are `/html/bbsp/ipincoming/add.cgi`, `.../set.cgi` and
`.../del.cgi`. A first test that posted to `/add.cgi` at the root got no answer at all and changed
nothing. The browser also sends `Referer` and `Origin` for the page; Nuvytrix sends the same.

### Enable or disable filtering
```
POST /html/bbsp/ipincoming/set.cgi?x=InternetGatewayDevice.X_HW_Security&RequestFile=html/bbsp/ipincoming/ipincoming.asp
x.IpFilterInRight=1|0
x.X_HW_Token=<onttoken>
```

### Change mode
```
POST /html/bbsp/ipincoming/set.cgi?x=InternetGatewayDevice.X_HW_Security&RequestFile=html/bbsp/ipincoming/ipincoming.asp
x.IpFilterInPolicy=0|1|2          (blacklist | whitelist | hybrid)
x.X_HW_Token=<onttoken>
```
The UI asks for confirmation before every mode change, because a **whitelist with no matching
rule blocks all traffic**, including access to the router itself from the LAN.

### Add a rule
```
POST /html/bbsp/ipincoming/add.cgi?x=InternetGatewayDevice.X_HW_Security.IpFilterIn&RequestFile=html/bbsp/ipincoming/ipincoming.asp
x.Protocol=ALL|TCP/UDP|TCP|UDP|ICMP
x.Direction=Upstream|Downstream|Bidirectional   (ALL only allows Bidirectional in the UI)
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
POST /html/bbsp/ipincoming/del.cgi?RequestFile=html/bbsp/ipincoming/ipincoming.asp
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

## Verification on the router (2026-11-16)

Test rule: name `NuvytrixTest`, protocol ALL, Bidirectional, LAN-side address 192.168.100.250
(unused). Blacklist mode, no other rules.

1. **Router UI in a browser:** add and delete through the router's own page; the exact requests
   were captured. Add body:
   `x.Protocol=ALL&x.Direction=Bidirectional&x.Name=NuvytrixTest&x.SourceIPStart=192.168.100.250&x.SourceIPEnd=&x.DestIPStart=&x.DestIPEnd=&x.LanSideTcpPort=&x.LanSideUdpPort=&x.WanSideTcpPort=&x.WanSideUdpPort=&x.X_HW_Token=<token>`.
   Delete body: `InternetGatewayDevice.X_HW_Security.IpFilterIn.1=&x.X_HW_Token=<token>`.
2. **From the server, without a browser:** the same add and delete sent by script. Both returned
   HTTP 200 with the re-rendered page, the rule appeared as `IpFilterIn.1` and was gone after the
   delete. The router ended in its original state (filter on, blacklist, 0 rules).

Answers:
- Writes take effect immediately; the re-rendered page already shows the new rule.
- The response is always the re-rendered page, so success is decided by reading the list back.
- An earlier script attempt with `Protocol=TCP, Direction=Downstream` and no ports got no HTTP
  answer at all (nothing was created). TCP/UDP rules with ports still need their own verification.
- The router allows **one web session at a time**. A login while another session is open (for
  example the router UI in a browser) fails, so Nuvytrix logs out after every operation.
- Still open: hybrid-mode `x.Action` values, `set.cgi` edits and mode changes (not yet tested),
  and whether TR-069 provisioning overwrites user rules.

### Verified through Nuvytrix (2026-11-16)

From Router → Firewall & UPnP in the deployed app, against the real router, on unused addresses
192.168.100.250-251: add (TCP, LAN TCP ports `80,8000:8080`), edit (TCP/UDP, LAN range .250-.251,
UDP port 53), filtering off and on, delete. Each change was read back from the router and audited
with outcome `applied`. A rule covering the server address (192.168.100.27) was refused before
anything was sent. The router ended in its original state (filter on, blacklist, no rules).

Findings:
- **Direction** is always `Bidirectional` on this firmware; the UI offers no other value. The
  earlier script attempt with `Direction=Downstream` got no HTTP answer, so Nuvytrix always sends
  `Bidirectional`.
- The router stores `Action=Accept` and `Priority=0` on blacklist rules. In blacklist mode every
  rule blocks, so Nuvytrix shows "block" whatever the stored action is.

## Safety design (implemented)

- Off unless `ROUTER_WRITES_ENABLED=true` on the server; the API answers 403 otherwise.
- Only blacklist mode is edited. In whitelist or hybrid mode every rule write is refused (422),
  and switching to those modes is not offered.
- **Lockout guard:** a rule whose LAN range covers the router address or an address in
  `ROUTER_PROTECTED_ADDRESSES` (the server, the admin's PC) is refused before anything is sent.
- Duplicate rules and duplicate names are refused.
- Every change asks for confirmation in the UI.
- After each write the page is read back. Success is reported only when the router shows the
  change; otherwise the API answers 502 `ROUTER_WRITE_NOT_APPLIED`.
- Every attempt is audited (`router.firewall_*`) with outcome `applied`, `not_applied` or `failed`.
  Updates and deletes store the previous rule, so it can be recreated from the audit log.
- Emergency off switch: turn filtering off (from Nuvytrix, or in the router UI under
  Security → IPv4 Address Filtering if Nuvytrix cannot reach the router).
- The router allows one web session at a time. Nuvytrix logs in for each operation and logs out
  right after. While someone is signed in to the router UI, Nuvytrix writes fail with 503.
