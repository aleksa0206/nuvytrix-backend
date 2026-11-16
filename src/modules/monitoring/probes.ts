import { execFile } from 'node:child_process';
import { Resolver } from 'node:dns/promises';
import { connect } from 'node:tls';

export interface ProbeResult {
  success: boolean;
  latencyMs: number | null;
  packetLossPercent: number | null;
  error: string | null;
  /** Ping only: mean deviation of the round-trip times (iputils "mdev"). */
  jitterMs?: number | null;
  /** HTTP only. */
  httpStatus?: number | null;
  certExpiresAt?: Date | null;
}

export interface Prober {
  ping(host: string): Promise<ProbeResult>;
  resolve(resolver: string, queryName: string): Promise<ProbeResult>;
  http(url: string): Promise<ProbeResult>;
}

const PING_COUNT = 3;
const PING_WAIT_SECONDS = 2;
const DNS_TIMEOUT_MS = 3000;
const HTTP_TIMEOUT_MS = 10_000;

/**
 * Reads the summary of Linux iputils `ping`, e.g.
 *   3 packets transmitted, 3 received, 0% packet loss, time 2003ms
 *   rtt min/avg/max/mdev = 0.412/0.508/0.617/0.083 ms
 */
export function parsePingOutput(output: string): ProbeResult | null {
  const loss = /(\d+(?:\.\d+)?)% packet loss/.exec(output);
  if (!loss) return null;
  const packetLossPercent = Number(loss[1]);
  const rtt = /= [\d.]+\/([\d.]+)\/[\d.]+\/([\d.]+) ms/.exec(output);
  return {
    success: packetLossPercent < 100,
    latencyMs: rtt ? Number(rtt[1]) : null,
    jitterMs: rtt ? Number(rtt[2]) : null,
    packetLossPercent,
    error: packetLossPercent === 100 ? 'No reply' : null,
  };
}

export class SystemProber implements Prober {
  constructor(private pingPath: string) {}

  ping(host: string): Promise<ProbeResult> {
    // Host is validated as an IP or hostname that cannot start with "-", so it is never an option.
    const args = ['-n', '-c', String(PING_COUNT), '-W', String(PING_WAIT_SECONDS), host];
    return new Promise((resolve) => {
      execFile(
        this.pingPath,
        args,
        { timeout: (PING_COUNT * PING_WAIT_SECONDS + 5) * 1000, windowsHide: true },
        (error, stdout, stderr) => {
          const parsed = parsePingOutput(stdout);
          if (parsed) return resolve(parsed);
          const reason = (stderr.trim() || error?.message || 'Unreadable ping output').slice(
            0,
            500
          );
          resolve({ success: false, latencyMs: null, packetLossPercent: null, error: reason });
        }
      );
    });
  }

  async resolve(resolverAddress: string, queryName: string): Promise<ProbeResult> {
    const resolver = new Resolver({ timeout: DNS_TIMEOUT_MS, tries: 1 });
    resolver.setServers([resolverAddress]);
    const startedAt = performance.now();
    try {
      await resolver.resolve(queryName);
      return {
        success: true,
        latencyMs: Math.round((performance.now() - startedAt) * 100) / 100,
        packetLossPercent: null,
        error: null,
      };
    } catch (err) {
      return {
        success: false,
        latencyMs: null,
        packetLossPercent: null,
        error: ((err as NodeJS.ErrnoException).code ?? (err as Error).message).slice(0, 500),
      };
    }
  }

  /** GET with redirects; up when the final status is below 400. HTTPS also reports certificate expiry. */
  async http(url: string): Promise<ProbeResult> {
    const target = new URL(url);
    const certificate = target.protocol === 'https:' ? certificateExpiry(target) : null;
    const startedAt = performance.now();
    try {
      const res = await fetch(target, {
        redirect: 'follow',
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
        headers: { 'user-agent': 'Nuvytrix uptime check' },
      });
      await res.body?.cancel();
      return {
        success: res.status < 400,
        latencyMs: Math.round((performance.now() - startedAt) * 100) / 100,
        packetLossPercent: null,
        httpStatus: res.status,
        certExpiresAt: await certificate,
        error: res.status < 400 ? null : `HTTP ${res.status}`,
      };
    } catch (err) {
      const cause = (err as { cause?: { code?: string } }).cause?.code;
      return {
        success: false,
        latencyMs: null,
        packetLossPercent: null,
        httpStatus: null,
        certExpiresAt: await certificate,
        error: (cause ?? (err as Error).message).slice(0, 500),
      };
    }
  }
}

/** The server certificate's end date, or null when it cannot be read. */
function certificateExpiry(url: URL): Promise<Date | null> {
  return new Promise((resolve) => {
    const socket = connect({
      host: url.hostname,
      port: Number(url.port) || 443,
      servername: url.hostname,
      timeout: HTTP_TIMEOUT_MS,
    });
    const done = (value: Date | null) => {
      socket.destroy();
      resolve(value);
    };
    socket.once('secureConnect', () => {
      const validTo = socket.getPeerCertificate()?.valid_to;
      done(validTo ? new Date(validTo) : null);
    });
    socket.once('error', () => done(null));
    socket.once('timeout', () => done(null));
  });
}
