# Device access control

## Device Access Control (verified 2026-11-16)

Page `/html/bbsp/acl/aclsmart.asp`, model
`stAclInfo(domain, TelnetLanEnable, HTTPWifiEnable, TELNETWifiEnable)` on
`InternetGatewayDevice.X_HW_Security.AclServices`. The page saves with
`POST set.cgi?x=InternetGatewayDevice.X_HW_Security.AclServices&RequestFile=html/bbsp/acl/aclsmart.asp`.

The web account is a normal user (`curUserType = '1'`). For this account the router leaves
`TelnetLanEnable` and `TELNETWifiEnable` empty, hides the LAN and Telnet rows, and the page submits only
`x.HTTPWifiEnable` (`1` allowed, `0` blocked) with the page token. HTTP from the LAN is not on the
page at all, so this setting cannot lock wired devices out of the web interface. Telnet cannot be
switched off from this account; see security-review.md.

Nuvytrix offers this one switch (`GET/PUT /router/device-access`, `{ httpFromWifi }`). Before blocking,
it reads `GetLanUserDevInfo.asp` and refuses unless every address in `ROUTER_PROTECTED_ADDRESSES`
(server and admin PC) is seen there on a cable (`ETH`). A missing or Wi-Fi entry means refusal.
Allowing again needs no check. Each attempt is audited (`router.device_access_changed`).

## Precise Device Access Control (not offered)

`/html/bbsp/portacl/newacl.asp` edits `InternetGatewayDevice.X_HW_Security.AclServices.AccessControl`
(enable flag) and its `List` (`stNewDeviceAcl(domain, SrcPortType, SrcPortName, Protocol, Priority,
ServiceProto, ServiceProtoPort, Mode, SrcIp)`). On 2026-11-16 it was enabled with one rule allowing
TELNET, HTTP, SSH, FTP, ICMP and SAMBA, most likely provisioned by the ISP for remote management.
Changing it could cut the provider's access or the web interface, so Nuvytrix does not write to it.
