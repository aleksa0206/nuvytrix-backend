export interface AdGuardSettings {
  url: string;
  username: string;
  password: string;
}

export interface AdGuardStatus {
  version: string;
  protection_enabled: boolean;
  running: boolean;
  dns_addresses: string[];
}

// AdGuard Home reports top lists as arrays of single-key objects: [{ "example.com": 42 }, ...]
export type TopList = Record<string, number>[];

export interface AdGuardStats {
  time_units: string;
  num_dns_queries: number;
  num_blocked_filtering: number;
  num_replaced_safebrowsing: number;
  num_replaced_parental: number;
  avg_processing_time: number;
  top_queried_domains: TopList;
  top_blocked_domains: TopList;
  top_clients: TopList;
}

const REQUEST_TIMEOUT_MS = 5000;

/** Client for the documented AdGuard Home control API (/control/status, /control/stats). */
export class AdGuardClient {
  constructor(private settings: AdGuardSettings) {}

  get isConfigured(): boolean {
    return this.settings.url !== '';
  }

  getStatus(): Promise<AdGuardStatus> {
    return this.get<AdGuardStatus>('/control/status');
  }

  getStats(): Promise<AdGuardStats> {
    return this.get<AdGuardStats>('/control/stats');
  }

  private async get<T>(path: string): Promise<T> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (this.settings.username) {
      const credentials = `${this.settings.username}:${this.settings.password}`;
      headers.Authorization = `Basic ${Buffer.from(credentials).toString('base64')}`;
    }
    const response = await fetch(new URL(path, this.settings.url), {
      headers,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      redirect: 'error',
    });
    if (!response.ok) throw new Error(`AdGuard Home responded with HTTP ${response.status}`);
    return (await response.json()) as T;
  }
}
