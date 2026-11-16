# Wi-Fi management

How Nuvytrix changes the router's Wi-Fi networks (WLAN → Basic): name, on/off, name broadcast,
WPA2 or WPA/WPA2 with a key, and adding or removing extra networks. Changes use the router page's own
requests, are switched on with `ROUTER_WRITES_ENABLED`, are read back and audited
(`router.wifi_network_created|updated|deleted`).

## Keys: the one page that holds secrets

`/html/amp/wlanbasic/WlanBasic.asp?2G` lists every network of both bands and embeds their keys
(`stPreSharedKey(domain, psk, kpp)`, `stWEPKey`, RADIUS key). Reading it is needed to change Wi-Fi
settings, so it is allow-listed, with these rules:

- The parser (`parseWifiNetworks`) reads only non-secret `stWlan` fields; it never touches keys.
- After a key change, `wifiKeyMatches` compares the stored key with the requested one and returns
  only true/false.
- No API response, log line or audit entry contains a key; audit details record
  `password: "[changed]"`. Verified on 2026-11-16 by inspecting the audit rows and API logs.

## Data

`stWlan(domain, name, enable, ssid, wlHide, DeviceNum, wmmEnable, BeaconType, BasicEncryptionModes,
BasicAuthenticationMode, …)`: `wlHide` is `1` when the name is broadcast. `BeaconType` `11i` = WPA2,
`WPAand11i` = WPA/WPA2, `WPA`, `WPA3`, `Basic` = open or WEP. Instances 1–4 are 2.4 GHz, 5–8 are 5 GHz
(`node2G` = `WiFi.Radio.1`, `node5G` = `WiFi.Radio.2` in `wlan_list.asp`).

## Requests (verified 2026-11-16)

`POST`, form-encoded, session cookie, `Referer` = the page, `Origin`, `x.X_HW_Token` = page token;
CGIs under `/html/amp/wlanbasic/`, `RequestFile=html/amp/wlanbasic/WlanBasic.asp` (no `?2G`).

| Change | URL | Body |
| --- | --- | --- |
| Add | `add.cgi?y=InternetGatewayDevice.LANDevice.1.WLANConfiguration` | `y.Enable=0`, `y.SSIDAdvertisementEnabled`, `y.WMMEnable=1`, `y.SSID`, `y.X_HW_AssociateNum=32`, `y.LowerLayers=<radio>` |
| Change | `set.cgi?y=<network>[&k=<network>.PreSharedKey.1]` | `y.Enable`, `y.SSIDAdvertisementEnabled`, `y.SSID`, `y.BeaconType`, `y.IEEE11iAuthenticationMode=PSKAuthentication` + `y.IEEE11iEncryptionModes=AESEncryption` (WPA2) or the `X_HW_WPAand11i…` pair with `TKIPandAESEncryption` (WPA/WPA2), `y.X_HW_GroupRekey=3600`, and `k.PreSharedKey` only when the key changes |
| Delete | first `set.cgi?y=InternetGatewayDevice.X_HW_DEBUG.AMP.ParallelDelSsid` with `y.DeleteInstArray=<instance>`, then `del.cgi` with `<network>=` (same session) |

The router's own page also sends Wi-Fi coverage (`w=…WifiCoverSetWlanBasic`) and WPS (`z=…WPS`)
objects; sending only `y` (and `k`) changes just those fields, verified by read-back.

**A new network is created open** (`Basic`, no encryption). Nuvytrix therefore creates it switched
off and secures it in a second request; if that fails, it removes the network again.

## Scope and safety

- Security choices: WPA2 (recommended) and WPA/WPA2. Open and WEP are never set by Nuvytrix; an open
  or WEP network can only be changed by giving it a key.
- The main network of each band (lowest instance) cannot be removed.
- Names: 1–32 printable ASCII characters, no leading/trailing space, unique per band. Keys: 8–63
  printable ASCII characters.
- The UI warns that Wi-Fi devices drop for a moment and need the new details after a name or key
  change. Wired devices (the server, the admin PC) are not affected.

## Verification

1. Script `~/router-research/wifitest.py`: temporary `NuvytrixTest` (2.4 GHz, always off) added,
   renamed and given WPA2 with a random key, deleted. The existing networks were unchanged.
2. Through the deployed Nuvytrix on 2026-11-16: `NuvytrixTest` added (off, WPA2, random key), changed
   to `NuvytrixTest2` with a new random key and hidden name (key confirmed on read-back), deleted.
   Four audit rows, all `applied`, with `password: "[changed]"` and no key anywhere; the networks
   Aleksauros and Aleksauros 5g were unchanged.

## Not covered yet

Channel, bandwidth and transmit power (WLAN → Advanced), WPS, schedules, WPA3, per-network device
limit and client isolation.
