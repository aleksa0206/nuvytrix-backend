# UPnP management

Application → UPnP: one switch. The page `/html/bbsp/upnp/upnp.asp` shows it as
`var enblMainUpnp` / `var enblSlvUpnp` (`'1'` = on) and lists the live mappings (`stUpnpPortMapping`).
Nuvytrix also reads the live mappings and the WAN status over UPnP SOAP (see network-protocols.md).

## Request (verified 2026-11-16)

`POST set.cgi?x=InternetGatewayDevice.X_HW_MainUPnP&y=InternetGatewayDevice.X_HW_SlvUPnP&RequestFile=html/bbsp/upnp/upnp.asp`
with `x.Enable`, `y.Enable` (both the same value), session cookie, `Referer`, `Origin` and
`x.X_HW_Token`. Read back from the page; audited as `router.upnp_changed`.

## Effects

- Turning UPnP **off removes every UPnP port mapping**. On 2026-11-16 that removed the AnyDesk mapping
  of the admin PC (TCP 40628 → 7070) and Tailscale's port mapping on the server (UDP 59616 → 41641).
  Apps create them again on their own when they need them; Tailscale kept its direct connection and
  its netcheck reported UPnP port mapping available again right after UPnP was turned back on.
- While UPnP is off, Nuvytrix cannot read the WAN status, traffic counters and live mappings it gets
  over UPnP. The UI says so and asks for confirmation before turning it off.

## Verification

Through the deployed Nuvytrix on 2026-11-16: turned off (read back off), turned on (read back on),
two audit rows `applied`.
