# Optical (PON) monitoring

`/html/amp/opticinfo/opticinfo.asp` exposes the optical transceiver readings through
`stOpticInfo` (path `InternetGatewayDevice.X_HW_DEBUG.AMP.Optic`).

| Field | Unit | Research value | Typical healthy range (GPON/XG-PON ONT) |
| --- | --- | --- | --- |
| `LinkStatus` | | `ok` | `ok` |
| `transOpticPower` | dBm | 3.59 | about +0.5 to +5 |
| `revOpticPower` | dBm | −17.10 | about −8 to −27 (alarm near −28) |
| `voltage` | mV | 3376 | about 3100–3500 |
| `temperature` | °C | 52 | below about 70 |
| `bias` | mA | 26 | module dependent |
| `rfRxPower`, `rfOutputPower` | dBmV | `--` | CATV only, not present |
| `VendorName`, `VendorSN`, `DateCode` | | `HUAWEI`, `<SN>`, `210605` | |
| `TxWaveLength`, `RxWaveLength` | nm | 1310, 1490 | GPON upstream/downstream |
| `MaxTxDistance` | km | 20 | |
| `LosStatus` | | `0` | `0` (1 = loss of signal) |

The ranges are general GPON guidance, not values from Huawei for this unit. Nuvytrix shows
readings and their history; it does not label a value as failing on its own.

GPON interface counters (`stStats` on `X_GponInterafceConfig.Stats`): errors sent/received,
discards, bytes and packets.

`stOLTOpticInfo` (OLT Tx power, budget class, PON identifier) is present but empty here.

## History

The router keeps no history. Nuvytrix samples the optical values on the router poll interval
(default 5 minutes) and stores them, so slow degradation (dirty connector, bent fibre, ageing laser)
shows up as a trend in Rx power and temperature.

## LOS events

There is no event log for LOS in the pages. A loss of signal can only be inferred from
`LosStatus`/`LinkStatus` in a sample, or from the router being unreachable.
