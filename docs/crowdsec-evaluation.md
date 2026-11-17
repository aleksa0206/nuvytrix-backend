# CrowdSec evaluation (NVX-22, 2026-11-17)

**Decision: not installed.** Nothing was changed on the server.

## What was checked

| Item | Finding |
| --- | --- |
| Resources | 4.4 GiB RAM available, load ~0.4 on 4 cores: CrowdSec (~100–250 MiB) would fit. |
| SSH | sshd listens on all addresses, but the WAN is CGNAT and no port is forwarded, so SSH is reachable only from the LAN and Tailscale. Every login of the last 30 days came from Tailscale. Nuvytrix already records SSH logins and alerts on new sources and repeated failures (NVX-13). A brute-force from the internet is not possible on this network. |
| Websites | All six sites are published only through Cloudflare Tunnel. Their nginx logs show scanners (e.g. `/wp-admin/install.php`), but the requests arrive from the tunnel, with the visitor's address only in a forwarded header, and Cloudflare already filters at its edge. |
| Log access | The site logs go to each container's stdout. CrowdSec's Docker source reads them through the Docker socket (`/containers/{id}/logs`), which Nuvytrix deliberately does not allow (the read-only proxy refuses logs). Giving CrowdSec the socket would be root-equivalent access to all sites. |
| Enforcement | Blocking would need a bouncer: on this host it would only see Cloudflare's addresses, so it would have to run at Cloudflare (API token, separate approval). |

## Why not now

Detection alone would add a root-equivalent component and a second log pipeline to report what
Cloudflare already handles for the sites and what Nuvytrix already reports for SSH. The risk is
higher than the gain on this setup.

## If it is wanted later

1. Have each site's nginx also write an access log to a host directory (or a shared volume) using
   the real visitor address (`CF-Connecting-IP`, trusted only from the tunnel's network).
2. Run CrowdSec in Docker with that directory and `/var/log/auth.log` mounted read-only, no Docker
   socket, no bouncer.
3. Show its decisions in Nuvytrix through the local API (read-only key).
4. Blocking only with a Cloudflare bouncer, after explicit approval.
