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

## Automatic Wi-Fi shutdown (verified 2026-11-16)

`/html/amp/wifische/WlanSchedule.asp`: `var wlanSchecuelEnable = 0|1;` and `stDuration(domain,
StartTime, EndTime, RepeatDay)` for `X_HW_WLANShutDownCtrl.Duration.1–4` (the page also contains a
template call with an unquoted domain, which the parser skips). While the schedule is on, the router
switches Wi-Fi off during each period (1 = Monday … 7 = Sunday).

The page writes in two steps, which Nuvytrix sends in one session:
1. `set.cgi?x=…Duration.1&y=…Duration.2&z=…Duration.3&w=…Duration.4` with `x|y|z|w.StartTime`,
   `.EndTime`, `.RepeatDay` (an unused period: empty times and `1,2,3,4,5,6,7`);
2. `set.cgi?x=…X_HW_WLANShutDownCtrl` with `x.Enable`.

Verified by script and through the deployed Nuvytrix with the period Sunday 03:00–03:05 (tested on a
Monday, so Wi-Fi never went off): saved, switched on, switched off and cleared. The UI warns when
switching on would turn Wi-Fi off at once.

## Radio channel and transmit power (verified 2026-11-16)

The advanced page `/html/amp/wlanadv/WlanAdvance.asp` (logic in `wlanadvance_api.asp`) posts the radio
settings to the band's first network: `set.cgi?y=<WLANConfiguration.N>&RequestFile=html/amp/wlanadv/WlanAdvance.asp`
with `y.Channel` (0 = automatic), `y.AutoChannelEnable` and `y.TransmitPower` (100/80/60/40/20).
The current values are read from `stWlanWifi(domain, name, enable, ssid, mode, channel, power, Country,
AutoChannelEnable, channelWidth)` on WlanBasic.asp.

Offered channels: 2.4 GHz 1–13 (country RS); 5 GHz only 36–48, because DFS channels can switch the
radio off while it checks for radar. The standard is not changed.

Verified by script (2.4 GHz power 100 → 80 → 100) and through the deployed Nuvytrix (2.4 GHz channel
6 at 80 %, then automatic at 100 %). Each change restarts that radio briefly; wired devices are not
affected.

## Channel width (verified 2026-11-16)

Sent with the radio settings as `y.X_HW_HT20`. Codes from `initChannelWidthList` /
`X_HW_StandardChange` in `wlanadvance_api.asp`: `0` auto 20/40 MHz, `1` 20 MHz, `2` 40 MHz, `3` auto
20/40/80 MHz, `4` 160 MHz (`5` 80+80 and `6` fixed 80 are not offered on this model). The page offers
20 MHz only for legacy standards (11a/b/g/bg), 0–2 on 2.4 GHz, and 3 and 4 on 5 GHz in 11ac/11ax
(160 MHz in 11ax). Nuvytrix offers the same and reads the value back from `stWlanWifi(…, channelWidth)`.
The router was found at auto 20/40 (2.4 GHz) and 160 MHz (5 GHz). Note: 160 MHz on 5 GHz uses DFS
channels anyway.

Verified through the deployed Nuvytrix: 2.4 GHz auto 20/40 → 20 MHz → auto 20/40, channel and power
unchanged.

## WPS (verified 2026-11-16)

WlanBasic.asp: `stWpsPin(domain, X_HW_ConfigMethod, DevicePassword, X_HW_PinGenerator, Enable)` for
`WLANConfiguration.1.WPS` and `.5.WPS` (the main network of each band; push button mode). Nuvytrix
reads only the domain and `Enable`; the PIN (`DevicePassword`) is never read, returned or logged.
Switched with `set.cgi?z=<network>.WPS&RequestFile=html/amp/wlanbasic/WlanBasic.asp` and only
`z.Enable` (method and PIN stay as they are). Connected devices are not affected.

Verified through the deployed Nuvytrix: 2.4 GHz WPS off, then on again (it was on when found).

## Not covered yet

WPA3, per-network device limit and client isolation.
