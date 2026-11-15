# Network protocols

Probed from the server on the LAN (192.168.100.27). TCP: connect scan of ports 1–1024 and common
high ports. UDP: targeted probes. Standard discovery queries were used for SSDP, mDNS and NAT-PMP.

| Protocol | Port | Supported | Enabled on LAN | Auth | Useful data | Integrate? |
| --- | --- | --- | --- | --- | --- | --- |
| HTTP management | TCP 80 | yes | yes | session cookie | everything in these docs | **yes** (read-only pages) |
| HTTPS management | TCP 443 | – | closed | – | – | no |
| Huawei service `mediarouter.home` | TCP 37443 (TLS, self-signed, issuer `root.home`) | yes | yes | unknown | unknown (404 on `/`) | no: undocumented, not explored further |
| UPnP IGD / SSDP | UDP 1900, TCP 49652 | yes | yes | none | WAN counters, status, external IP, port mappings | **yes** (Get actions only) |
| Telnet | TCP 23 | yes | open | separate account; admin web account refused | CLI (not accessible) | no |
| SSH | TCP 22 | – | filtered | – | – | no |
| FTP | TCP 21 | for USB sharing | filtered | – | – | no |
| SNMP v1/v2c/v3 | UDP 161/162 | not found | closed | – | – | no |
| TR-069 / CWMP | TCP 7547 | yes (ISP) | closed on LAN | ISP ACS only | – | no (ISP infrastructure) |
| TR-369 / USP | – | no evidence | – | – | – | no |
| Syslog (remote) | UDP 514 | no setting in UI | closed | – | – | no |
| NetFlow / IPFIX | – | no evidence | – | – | – | no |
| TFTP | UDP 69 | – | closed | – | – | no |
| NTP server | UDP 123 | – | closed | – | – | no |
| NAT-PMP / PCP | UDP 5351 | – | closed | – | – | no |
| mDNS | UDP 5353 | – | closed | – | – | no |
| LLDP | L2 | no evidence | – | – | – | no |
| DNS relay | UDP 53 | yes | open/filtered | none | could be monitored with test queries | already covered by DNS checks |
| DHCP | UDP 67 | yes | yes | – | leases via web UI | via web UI |

## Notes

- **TR-069** being present on the device does not give access: the ACS belongs to the ISP and the
  CWMP port is not reachable from the LAN.
- **Telnet** prompts for a separate CLI account (likely ISP-provisioned). No default or published
  credentials were tried; that would be bypassing authentication on ISP equipment.
- **SSDP** answers advertise `Linux/4.4.197, UPnP/1.0, Portable SDK for UPnP devices/1.6.25`.
