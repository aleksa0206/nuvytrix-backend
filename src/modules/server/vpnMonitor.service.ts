import { readFile } from 'node:fs/promises';
import type { AlertsService } from '../alerts/alerts.service';

/** Written by the server's VPN watchdog every 15 s (deploy/vpn/gateway.sh, docs/vpn.md). */
export interface VpnState {
  mode: 'vpn' | 'direct' | 'off';
  since: string;
  checkedAt: string;
  reason: string;
}

const ALERT_KEY = 'vpn:direct';
/** The watchdog writes every 15 s; older than this means it stopped. */
const STALE_MS = 2 * 60_000;

/**
 * Reads the home VPN gateway's state file (mounted read-only) and alerts while the home goes out
 * directly through the provider instead of through Mullvad. Never changes anything.
 */
export class VpnMonitorService {
  last: { state: VpnState | null; stale: boolean; error: string | null; readAt: Date } | null =
    null;

  constructor(
    /** Empty turns this off. */
    private stateFile: string,
    private alerts: AlertsService
  ) {}

  get enabled(): boolean {
    return this.stateFile !== '';
  }

  async check(): Promise<void> {
    if (!this.enabled) return;
    let state: VpnState | null = null;
    let error: string | null = null;
    try {
      state = JSON.parse(await readFile(this.stateFile, 'utf8')) as VpnState;
    } catch (err) {
      error = (err as NodeJS.ErrnoException).code ?? 'unreadable';
    }
    const stale = !state || Date.now() - new Date(state.checkedAt).getTime() > STALE_MS;
    this.last = { state, stale, error, readAt: new Date() };
    if (!state) return;
    if (state.mode === 'direct') {
      await this.alerts.raise(
        'vpn_direct',
        'warning',
        'VPN tunnel down: the home goes out directly through the provider',
        { since: state.since, reason: state.reason },
        ALERT_KEY
      );
    } else if (state.mode === 'vpn' && !stale && (await this.alerts.resolve(ALERT_KEY))) {
      await this.alerts.raise(
        'vpn_restored',
        'info',
        'VPN tunnel is back: the home goes through Mullvad again'
      );
    }
  }
}
