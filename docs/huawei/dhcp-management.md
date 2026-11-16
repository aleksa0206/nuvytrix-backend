# DHCP management

How Nuvytrix changes the router's main DHCP pool and its static address reservations. Both use the
router's own forms, are switched on with `ROUTER_WRITES_ENABLED`, are read back after every change,
and are audited (`router.dhcp_server_changed`, `router.dhcp_reservation_created|updated|deleted`).

## Pages

| Page | Path | Data |
| --- | --- | --- |
| LAN → DHCP Server | `/html/bbsp/dhcpservercfg/dhcp2.asp` | `new stipaddr(domain, enable, ip, mask)` (LAN address, `IPInterface.1`); `new dhcpmainst(domain, enable, start, end, lease, l2relay, 10 × pool-split fields, mainDNS, option125, DNSServers, optionEnable)` |
| LAN → DHCP Static IP | `/html/bbsp/dhcpstatic/dhcpstatic.asp` | `new stDhcp(domain, Enable, ipAddress, macAddress)`; `new Array(null)` when there are none |

## Requests (verified 2026-11-16)

All are `POST`, form-encoded, with the session cookie, `Referer` = the page, `Origin`, and
`x.X_HW_Token` = the page's `onttoken`. The CGI path is relative to the page's directory.

| Change | URL | Body |
| --- | --- | --- |
| Pool and lease | `dhcpservercfg/set.cgi?z=InternetGatewayDevice.LANDevice.1.LANHostConfigManagement&RequestFile=html/bbsp/dhcpservercfg/dhcp2.asp` | `z.MinAddress`, `z.MaxAddress`, `z.DHCPLeaseTime` (seconds) |
| Add reservation | `dhcpstatic/add.cgi?x=InternetGatewayDevice.LANDevice.1.LANHostConfigManagement.DHCPStaticAddress&RequestFile=html/bbsp/dhcpstatic/dhcpstatic.asp` | `x.Yiaddr`, `x.Chaddr`, `x.Enable=1` |
| Change reservation | `dhcpstatic/set.cgi?x=<reservation domain>&RequestFile=…` | `x.Yiaddr`, `x.Chaddr` |
| Delete reservation | `dhcpstatic/del.cgi?x=…DHCPStaticAddress&RequestFile=…` (unlike the IPv4 filter, the object is in the URL) | `<reservation domain>=` |

The router's own page posts many more fields to `set.cgi` on the DHCP server page (secondary pool,
DNS, relay, option 125) across several objects (`x=`, `y=`, `z=`). Sending only the `z=` object with
the three fields above changes only those fields; everything else was unchanged on read-back. The
router's page itself uses this `z=`-only form in some of its configuration branches.

The router's form validates nothing on this model (`ProductType = 1`), so Nuvytrix validates:

- **Lease:** whole minutes, 60 s to 10 weeks (the router's `checkLease` allows up to 604800 × 10).
- **Pool:** inside the LAN subnet, not the network or broadcast address, start ≤ end, must not
  include the router, must keep every `ROUTER_PROTECTED_ADDRESSES` entry and every reservation.
- **Reservation:** MAC without multicast bit; address in the LAN subnet and not the router; no second
  reservation for the same MAC or address; refused when another device (by the router's device
  list) holds the address.

## Verification

1. Script on the server (`~/router-research/dhcptest.py`): added `02:4e:56:00:00:01` → `.250`,
   changed it to `.251`, deleted it; each step read back. Router ended with no reservations.
2. Script `~/router-research/dhcppooltest.py`: lease 86400 → 43200 → 86400, range re-sent
   unchanged; read back each time.
3. Through the deployed Nuvytrix on 2026-11-16: reservation `02:4e:56:00:00:01` added at `.250`,
   moved to `.251`; a pool ending at `.200` was refused (it would drop the reservation) with nothing
   sent; lease set to 12 h and back to 1 day; reservation deleted. Five `audit_logs` rows, all
   `applied`. The router ended in its original state.

## Undo

The audit entry of every change holds `before` and `requested`. A deleted reservation can be added
again with the MAC and address from `before`; a pool change is undone by saving the `before` values.
