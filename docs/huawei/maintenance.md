# Maintenance: diagnostics, user log, LED, configuration file

## Ping and traceroute from the router (verified 2026-11-16)

Page `/html/bbsp/maintenance/diagnosecommon.asp`. A test is started with
`POST complex.cgi?x=<object>&RUNSTATE_FLAG=<Ping|Traceroute>&RequestFile=html/bbsp/maintenance/diagnosecommon.asp`:

| Test | Object | Fields |
| --- | --- | --- |
| Ping | `InternetGatewayDevice.IPPingDiagnostics` | `x.Host`, `x.DiagnosticsState=Requested`, `x.NumberOfRepetitions=4`, `x.DSCP=0`, `x.DataBlockSize=56`, `x.Timeout=10000` (ms) |
| Traceroute | `InternetGatewayDevice.TraceRouteDiagnostics` | `x.DiagnosticsState=Requested`, `x.Host`, `x.DataBlockSize=38` |

plus `RUNSTATE_FLAG.value=START` and the page token. The result pages `GetPingResult.asp` and
`GetRouteResult.asp` render a JavaScript string `"<output>[@#@]<state>"` (`NONE[@#@]NONE` when idle;
state `Requested` while running, then `Complete` or `Complete_Err`). Nuvytrix parses the string
literals (never evaluates them) and polls every 2.5 s for up to 90 s. Without `x.Interface` the
router uses its default route. Nslookup's result pages are not at the paths the page uses on this
firmware, so it is not offered. Tests change no setting; each run is audited
(`router.diagnostics_run`).

Verified through the deployed Nuvytrix: ping and traceroute to 1.1.1.1 (4/4 replies, 8 hops).

## User log

`/html/ssmp/userlog/normallogview.asp` writes the log into its textarea, like the firewall log page.
The first lines are a header with manufacturer, model, **serial number** and WAN address; Nuvytrix
returns only the dated entries. The page's download button (`logviewdown.cgi` after
`StartFileLoad.asp`) is not used. The log was empty on 2026-11-16.

## Indicator lights

See feature-parity.md: `set.cgi?x=InternetGatewayDevice.X_HW_SSMPPDT.Deviceinfo` with
`x.X_HW_LedSwitch` (0 on, 1 off), read back from `var EnableLedSwitch` on `/html/ssmp/ledcfg/ledcfg.asp`.
Value 2 (off after a delay) is not accepted by this model.

## Configuration file

`/html/ssmp/cfgfile/cfgfileroot.asp` offers the admin account only "save" (`X_HW_DEBUG.SSP.DBSave`)
and "save and reboot". There is no download or upload for this account, so Nuvytrix cannot back up
or restore the configuration.
