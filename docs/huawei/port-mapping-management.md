# Port mapping (port forwarding) management

How Nuvytrix changes the router's IPv4 port mappings (Forward Rules → IPv4 Port Mapping). Changes
use the router page's own requests, are switched on with `ROUTER_WRITES_ENABLED`, are read back
after every change and audited (`router.port_mapping_created|updated|deleted`).

## Pages

| Page | Path | Data |
| --- | --- | --- |
| Port mapping | `/html/bbsp/portmapping/portmappingnew.asp` (`portmapping.asp` only redirects to it) | `WanIPPortMapping` / `WanPPPPortMapping`: `stPortMap(domain, ProtMapEnabled, RemoteHost, RemoteHostRange, OperateRule, InClient, Description, ExternalIP)`; `WanIPPortMappingPortList`: `stPortMappingPortList(domain, Protocol, InternalPort, ExternalPort, ExternalSrcPort)`; LAN address in `stipaddr` |
| WAN list | `/html/bbsp/common/wan_list.asp` | `WanIP(domain, …)`: index 12 `Mode`, 25 `ServiceList`, 29 `IPv4Enable` |

A mapping belongs to a WAN connection: `<WAN>.PortMapping.N`, and has one or more port ranges
`<mapping>.X_HW_Portlist.M`. The router page offers routed IPv4 WANs with `INTERNET` in their
service list; on this router that is `WANConnectionDevice.3.WANIPConnection.1` (the others are
TR-069 and VoIP). The WAN list page also holds WAN account fields; Nuvytrix parses only path, mode
and services from it and never logs or returns the page.

## Requests (verified 2026-11-16)

`POST`, form-encoded, session cookie, `Referer` = the page, `Origin`, `x.X_HW_Token` = page token.
All CGIs are relative to `/html/bbsp/portmapping/` and end with
`&RequestFile=html/bbsp/portmapping/portmappingnew.asp`.

| Change | URL | Body |
| --- | --- | --- |
| Add | `addcfgajax.cgi?GROUP_a_x=<WAN>.PortMapping&GROUP_a_ya=GROUP_a_x.X_HW_Portlist` | `GROUP_a_x.PortMappingEnabled`, `.PortMappingDescription`, `.InternalClient`, `.RemoteHost`, `.X_HW_RemoteHostRange`; `GROUP_a_ya.Protocol`, `.InternalPort` (`port`), `.ExternalPort` (`start:end`) |
| Change | `complexajax.cgi?x=<mapping>&ma=<mapping>.X_HW_Portlist.M` | the same fields with `x.` and `ma.` prefixes, plus `ma.ExternalSrcPort=` |
| Delete | `del.cgi?RequestFile=…` (no object in the URL) | `<mapping>=` |

The ajax CGIs answer with a JavaScript-escaped JSON string, `{ "result": 0 }` on success; errors
carry a code (for example `0xf734b002`, port mapping conflict). Nuvytrix does not rely on it: it
reads the page back and compares.

## Scope and safety

- One port range per mapping (what the page shows by default). Mappings with several ranges are
  listed and can be deleted, but are changed in the router's own interface.
- Refused: the router itself as target (it would expose its admin pages), addresses outside the
  LAN, network/broadcast address, a duplicate name, and external ports that another mapping already
  uses for the same protocol.
- The UI warns that a forward opens a device to the internet. The router's WAN address on this
  connection is a shared CGNAT address (100.64.0.0/10), so forwards are not reachable from the
  internet unless the provider gives a public address.

## Verification

1. Script `~/router-research/pmtest.py`: added `NuvytrixTest` (TCP 40001 → `.250`:40001, off),
   changed it to UDP 40002–40003 → 40002 and on, deleted it; each step read back. The router ended
   with no mappings, as before.
2. Through the deployed Nuvytrix on 2026-11-16: a forward to the router itself was refused with
   nothing sent; `NuvytrixTest` added (off, TCP 40001 → `.250`), changed to UDP 40002–40003 → 40002,
   turned on, turned off and deleted. Five `audit_logs` rows, all `applied`; no mappings left.

## Undo

The audit entry of every change holds `before` and `requested`; a deleted mapping can be recreated
from `before`.
