# DMZ and port trigger management

How Nuvytrix changes the router's DMZ host and port triggers (Forward Rules → DMZ, Port Trigger).
Both live on the internet WAN connection (found as in port-mapping-management.md), use the router's
own forms, are switched on with `ROUTER_WRITES_ENABLED`, are read back and audited
(`router.dmz_changed|deleted`, `router.port_trigger_created|updated|deleted`).

## Pages

| Page | Path | Data |
| --- | --- | --- |
| DMZ | `/html/bbsp/dmz/dmz.asp` | `IpDmzInfo` / `PppDmzInfo`: `stDMZInfo(domain, DMZEnable, DMZHostIPAddress)`, domain `<WAN>.X_HW_DMZ` |
| Port trigger | `/html/bbsp/porttrigger/porttrigger.asp` | `WanIPPortTrigger` / `WanPPPPortTrigger`: `stPortTrigger(domain, Enable, TPort, TPortEnd, TProto, OPort, OPortEnd, OProto)`, domain `<WAN>.X_HW_PortTrigger.N` |

## Requests (verified 2026-11-16)

`POST`, form-encoded, session cookie, `Referer` = the page, `Origin`, `x.X_HW_Token` = page token.
CGIs relative to the page; `RequestFile=<page without leading slash>`.

| Change | URL | Body |
| --- | --- | --- |
| DMZ create | `add.cgi?x=<WAN>.X_HW_DMZ` | `x.DMZEnable`, `x.DMZHostIPAddress` |
| DMZ change | `set.cgi?x=<WAN>.X_HW_DMZ` | the same |
| DMZ delete | `del.cgi` (no object in the URL) | `<WAN>.X_HW_DMZ=` |
| Trigger add | `add.cgi?x=<WAN>.X_HW_PortTrigger` | `x.Enable`, `x.TriggerPort`, `x.TriggerPortEnd`, `x.TriggerProtocol`, `x.OpenPort`, `x.OpenPortEnd`, `x.OpenProtocol` |
| Trigger change | `set.cgi?x=<trigger domain>` | the same |
| Trigger delete | `del.cgi` | `<trigger domain>=` |

The DMZ form also lists `x.Name` with the "do not send" flag; it is not posted.

## Safety

- **DMZ host:** must be a device in the LAN, not the router, and not a `ROUTER_PROTECTED_ADDRESSES`
  entry (server, admin PC): a DMZ host receives every unsolicited connection on every port. The UI
  warns before it is turned on.
- **Port triggers:** protocols TCP, UDP, TCP/UDP; start ≤ end; no trigger range containing port 21
  or 69 (the router's own form refuses these); no overlap with another trigger on the same
  protocol; at most 256 trigger ports and 256 open ports across all triggers (the router's limits).

## Verification

1. Script `~/router-research/dmzpttest.py` with the unused address `.250`: DMZ created off, turned on,
   turned off, deleted; trigger TCP 40010 → UDP 40011–40012 added off, changed to on and
   TCP/UDP 40011–40013, deleted. Every step read back; both ended empty, as before.
2. Through the deployed Nuvytrix on 2026-11-16: the server (`.27`) as DMZ host was refused with
   nothing sent; DMZ host `.250` set off, turned on, turned off, removed; trigger TCP 40010 → UDP
   40011–40012 added off, changed to on and 40011–40013, deleted. Seven `audit_logs` rows, all
   `applied`; nothing left on the router.

## Undo

Audit entries hold `before` and `requested`.
