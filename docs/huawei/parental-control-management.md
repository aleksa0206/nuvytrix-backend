# Parental control management

How Nuvytrix changes the router's parental control (Security → Parental Control): templates with
time limits and site lists, and the devices bound to them. Changes use the router page's own
requests, are switched on with `ROUTER_WRITES_ENABLED`, are read back and audited
(`router.parental_template|period|url|device_created|updated|deleted`).

## Model

- **Template** (`ParentalCtrl.Templates.N`): name; time limits on/off (`DurationRight`) with a mode
  (`DurationPolicy` 0 = the periods are blocked, 1 = internet only during the periods); site filter
  on/off (`UrlFilterRight`) with a mode (`UrlFilterPolicy` 0 = the sites are blocked, 1 = only the
  sites). Optional validity dates are left empty.
- **Period** (`Templates.N.Duration.M`): `StartTime`, `EndTime` (`HH:MM`), `RepeatDay` (`1,2,…`,
  1 = Monday … 7 = Sunday).
- **Site** (`Templates.N.UrlFilter.M`): `UrlAddress`, a host with an optional path.
- **Device** (`ParentalCtrl.MAC.K`): `MACAddress`, `Description`, `TemplateInst` = N. The router's
  page can also bind `FF:FF:FF:FF:FF:FF` (all devices); Nuvytrix never does.

## Pages

| Page | Path | Use |
| --- | --- | --- |
| Device page | `/html/bbsp/parentalctrl/parentalctrlmac.asp` | form token; CGIs relative to its folder |
| Data | `/html/bbsp/common/parentalctrlinfo.asp` | `TemplatesListClass(domain, Name, UrlFilterPolicy, UrlFilterRight, StartDate, EndDate, DurationPolicy, DurationRight)`, `DurationListClass(domain, StartTime, EndTime, RepeatDay)`, `UrlFilterUrlAddress(domain, url)`, `ChildListClass(domain, MAC, Description, TemplateInst)`; read back after every write |

## Requests (verified 2026-11-16)

`POST`, form-encoded, session cookie, `Referer`, `Origin`, `x.X_HW_Token`; CGIs under
`/html/bbsp/parentalctrl/` with `RequestFile=html/bbsp/parentalctrl/parentalctrlmac.asp` (the router's
own page names a missing file there and gets HTTP 404 back, although the change applies).

| Change | URL | Body |
| --- | --- | --- |
| Template add | `add.cgi?x_SAVE_A=…ParentalCtrl.Templates` | `x_SAVE_A.Name`, `x_SAVE_A.StartDate=`, `x_SAVE_A.EndDate=` |
| Template change | `set.cgi?x=…Templates.N` | any of `x.Name` (+ empty dates), `x.DurationRight`, `x.DurationPolicy`, `x.UrlFilterRight`, `x.UrlFilterPolicy` |
| Period add | `add.cgi?x=…Templates.N.Duration` | `x.StartTime`, `x.EndTime`, `x.RepeatDay` |
| Site add | `add.cgi?x=…Templates.N.UrlFilter` | `x.UrlAddress` |
| Device add / change | `add.cgi?x=…ParentalCtrl.MAC` / `set.cgi?x=…MAC.K` | `x.MACAddress`, `x.Description`, `x.TemplateInst` |
| Any delete | `del.cgi` | `<object path>=` |

The router's time page sends `y.DurationRight` / `y.DurationPolicy` together with a new period; on
this firmware those `y.` fields were not applied, so Nuvytrix switches time limits with a separate
template change (verified).

## Safety

- The server and the admin PC (`ROUTER_PROTECTED_ADDRESSES`, matched to MACs through the router's
  device list) cannot be bound; "all devices" (`FF:FF:FF:FF:FF:FF`, a multicast MAC) is rejected.
- One template per device; a template in use cannot be deleted.
- The UI warns when "internet only during these times" is on with no times listed, which leaves
  bound devices without internet.

## Verification

1. Script `~/router-research/pctest.py` with the fake MAC `02:4e:56:00:00:01`: template, rename,
   period, site, site filter on, device bind, then everything deleted; read back each step.
2. Through the deployed Nuvytrix on 2026-11-16: template `NuvytrixTest` added; period 08:00–20:00
   Mon–Fri and site `example.com` added; time limits on, site filter on, time mode switched to
   "internet only during these times"; the server refused as a device; the fake MAC bound, then the
   binding, period, site and template deleted. Twelve audit rows, all `applied`; the router ended with
   its original empty template only.
