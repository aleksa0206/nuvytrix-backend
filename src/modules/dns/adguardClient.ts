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
  /** Newer versions: answers and average time per upstream. */
  top_upstreams_responses?: TopList;
  top_upstreams_avg_time?: TopList;
}

export interface AdGuardQueryLogEntry {
  time: string;
  client: string;
  question?: { name?: string; type?: string };
  reason?: string;
  elapsedMs?: string;
  upstream?: string;
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

  getQueryLog(params: { limit: number; search?: string; blockedOnly?: boolean }) {
    const query = new URLSearchParams({ limit: String(params.limit) });
    if (params.search) query.set('search', params.search);
    if (params.blockedOnly) query.set('response_status', 'blocked');
    return this.get<{ data: AdGuardQueryLogEntry[] }>(`/control/querylog?${query}`);
  }

  getUserRules(): Promise<string[]> {
    return this.get<{ user_rules?: string[] }>('/control/filtering/status').then(
      (s) => s.user_rules ?? []
    );
  }

  setUserRules(rules: string[]): Promise<void> {
    return this.send('/control/filtering/set_rules', { rules });
  }

  private async send(path: string, body: unknown): Promise<void> {
    const response = await fetch(new URL(path, this.settings.url), {
      method: 'POST',
      headers: { ...this.authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      redirect: 'error',
    });
    if (!response.ok) throw new Error(`AdGuard Home responded with HTTP ${response.status}`);
  }

  private authHeaders(): Record<string, string> {
    if (!this.settings.username) return {};
    const credentials = `${this.settings.username}:${this.settings.password}`;
    return { Authorization: `Basic ${Buffer.from(credentials).toString('base64')}` };
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
