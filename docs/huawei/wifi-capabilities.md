# Wi-Fi

## Radios and SSIDs (`wlaninfo.asp`)

Two active SSIDs: `WLANConfiguration.1` (2.4 GHz, radio 1) and `WLANConfiguration.5`
(5 GHz, radio 2). Instances 2–4 and 6–8 exist but are disabled.

| Field | Example (sanitized) |
| --- | --- |
| Enabled, interface name | `1`, `ath0` / `ath4` |
| SSID | `<ssid>` |
| Security | `11i` with `AESEncryption` / `PSKAuthentication` (WPA2-PSK) |
| Channel | 7 (2.4 GHz), 36 (5 GHz) |
| Standard | `11ax` |
| Channel width code (`X_HW_HT20`) | `0` on 2.4 GHz, `4` on 5 GHz (the UI maps codes through a table; 4 is the widest mode) |
| Transmit power | `100` (%) |
| Hidden, WMM, auto channel | flags |
| Associated device count | from `DeviceNum` |

Per-SSID counters: bytes and packets sent/received (`stPacketInfo`), errors and discards (`stStats`).

## Clients (`getassociateddeviceinfo.asp`)

One `stAssociatedDevice` per associated station. Seven were associated during the research.

| Field | Unit | Example |
| --- | --- | --- |
| MAC, IP, description (hostname) | | `<MAC>`, `<IP>`, `iPhone` |
| `X_HW_Uptime` | seconds associated | `2223` |
| `X_HW_RxRate`, `X_HW_TxRate` | Mbit/s, last negotiated | `68`, `195` |
| `X_HW_RSSI` | dBm | `-65` |
| `X_HW_Noise` | dBm | `-91` |
| `X_HW_SNR` | dB | `26` |
| `X_HW_SingalQuality` | 0–100 (router's own score) | `29` |
| `X_HW_WorkingMode` | standard | `11ax`, `11bgn` |
| `X_HW_WMMStatus`, `X_HW_PSMode` | flags | |
| `X_HW_AntennaNum` | spatial streams | `2*2` |
| 11k / 11v / dual band / beamforming | flags | |

Band is the SSID instance in the domain path (1 is 2.4 GHz, 5 is 5 GHz).

This is enough for a per-device signal view and history. The values are instantaneous; the router
keeps no history.

## Neighbouring networks

`getneighbourAPinfo.asp` (`stNeighbourAP`: SSID, BSSID, network type, channel, RSSI, noise, DTIM,
beacon, security, standard, max bit rate) holds the result of the last scan. The UI starts a new scan
with a write request, so Nuvytrix does not trigger scans. A stale list may still be read.

## Secrets

`WlanBasic.asp` and `wifiCover.asp` embed the WPA pre-shared keys (`stPreSharedKey`), WEP keys and
the WPS PIN in clear text. Nuvytrix never requests these pages. They are also on the client's
deny-list, so a code change cannot fetch them by accident.

## Not available

- Channel utilisation or interference per channel (`getradar.asp` returns an empty value on this unit).
- Per-client traffic counters.
- Guest network (none configured; the page model exists).
