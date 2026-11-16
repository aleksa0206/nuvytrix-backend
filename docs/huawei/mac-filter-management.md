# MAC filter management

How Nuvytrix changes the router's two MAC filters. Both use the router's own forms, are switched on
with `ROUTER_WRITES_ENABLED`, are read back after every change, and are audited
(`router.mac_filter_settings_changed`, `router.mac_filter_entry_created|updated|deleted`, with
`details.list` = `lan` or `wifi`).

| List | Page | Data | Effect of an entry (blacklist) |
| --- | --- | --- | --- |
| MAC filter (`lan`) | `/html/bbsp/macfilter/macfilter.asp` | `var enableFilter`, `var Mode`, `new stMacFilter(domain, MACAddress, DeviceAlias)` | the device gets no access through the router |
| Wi-Fi MAC filter (`wifi`) | `/html/bbsp/wlanmacfilter/wlanmacfilter.asp` | `var enableFilter`, `var Mode`, `new stMacFilter(domain, SSIDName, DeviceName, MACAddress)` | the device cannot join that Wi-Fi network |

`Mode` 0 is blacklist, 1 is whitelist. The Wi-Fi network is named `SSID-<instance>` (`SSID-1` 2.4 GHz,
`SSID-5` 5 GHz): the page builds it from `wlan_list.asp` as `'SSID-' + last character of 'SSID' + instance`.

## Requests (verified 2026-11-16)

`POST`, form-encoded, session cookie, `Referer` = the page, `Origin`, `x.X_HW_Token` = page token.
The CGI path is relative to the page.

| Change | URL (`?…&RequestFile=<page without leading slash>`) | Body |
| --- | --- | --- |
| LAN entry add | `add.cgi?x=InternetGatewayDevice.X_HW_Security.MacFilter` | `x.SourceMACAddress`, `x.DeviceAlias` |
| Wi-Fi entry add | `add.cgi?x=InternetGatewayDevice.X_HW_Security.WLANMacFilter` | `x.SourceMACAddress`, `x.SSIDName`, `x.DeviceName`, `x.Enable=1` |
| Entry change | `set.cgi?x=<entry domain>` | the same fields |
| Entry delete | `del.cgi?x=<collection>` | `<entry domain>=` |
| Filter on/off | `set.cgi?x=InternetGatewayDevice.X_HW_Security` | LAN: `x.MacFilterRight=1|0`, `x.MacFilterPolicy=0`; Wi-Fi: `x.WlanMacFilterRight`, `x.WlanMacFilterPolicy=0` |

## Safety

- **Blacklist only.** A list in whitelist mode is shown but never changed, and Nuvytrix never sends
  policy 1: a whitelist without the right entries cuts every other device off.
- **Protected devices.** The MAC of any device holding a `ROUTER_PROTECTED_ADDRESSES` address (server,
  admin PC), according to the router's device list, cannot be added, and a list containing one
  cannot be turned on.
- No duplicate MAC per list (per network for Wi-Fi); Wi-Fi entries only for an active network.
- Names: up to 32 characters, letters, digits, space, `.`, `-`, `_` (the Wi-Fi form allows 32).

## Verification

1. Script `~/router-research/mactest.py` with the fake MAC `02:4e:56:00:00:01`, for each list: add,
   rename, filter on (blacklist), filter off, delete; every step read back. Both lists ended empty
   and off, as before.
2. Through the deployed Nuvytrix: see the parity table for the date.

## Undo

Audit entries hold `before` and `requested`; a deleted entry can be added again from `before`.
