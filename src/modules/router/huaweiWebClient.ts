import { logger } from '../../config/logger';
import { isLoginPage, parseOnttoken } from './huaweiParser';

/**
 * The only pages this client may request. Anything else (including every *.cgi except login and
 * logout, and the pages that embed Wi-Fi keys) is refused before a request is made.
 * See docs/huawei/authentication-and-sessions.md.
 */
export const ALLOWED_PAGES = {
  systemInfo: '/html/ssmp/deviceinfo/deviceinfo.asp',
  optical: '/html/amp/opticinfo/opticinfo.asp',
  ethernet: '/html/amp/ethinfo/ethinfo.asp',
  wlan: '/html/amp/wlaninfo/wlaninfo.asp',
  wifiClients: '/html/amp/wlaninfo/getassociateddeviceinfo.asp',
  devices: '/html/bbsp/common/GetLanUserDevInfo.asp',
  firewallLog: '/html/bbsp/firewalllog/firewalllogview.asp',
  ipFilter: '/html/bbsp/ipincoming/ipincoming.asp',
} as const;

export type RouterPage = keyof typeof ALLOWED_PAGES;

export interface HuaweiWebClientOptions {
  baseUrl: string;
  username: string;
  password: string;
  timeoutMs?: number;
  /** After a failed login, no new login is attempted for this long (the router locks after 3). */
  loginCooldownMs?: number;
}

export class RouterAuthError extends Error {}
export class RouterUnavailableError extends Error {}

/** Reads pages of the Huawei web UI with the administrator's account. GET only, apart from login/logout. */
export class HuaweiWebClient {
  private blockedUntil = 0;
  private busy: Promise<unknown> = Promise.resolve();

  constructor(private options: HuaweiWebClientOptions) {}

  get isConfigured(): boolean {
    return this.options.username !== '' && this.options.password !== '';
  }

  /** Logs in, fetches the requested pages with one session, logs out. Calls never overlap. */
  fetchPages<T extends RouterPage>(pages: readonly T[]): Promise<Record<T, string>> {
    const run = this.busy.then(
      () => this.fetchWithSession(pages),
      () => this.fetchWithSession(pages)
    );
    this.busy = run.catch(() => undefined);
    return run;
  }

  private async fetchWithSession<T extends RouterPage>(
    pages: readonly T[]
  ): Promise<Record<T, string>> {
    if (!this.isConfigured) throw new RouterAuthError('Router credentials are not configured');
    if (Date.now() < this.blockedUntil) {
      throw new RouterAuthError('Router login is paused after a failed attempt');
    }

    const cookie = await this.login();
    const result = {} as Record<T, string>;
    let lastToken: string | null = null;
    try {
      for (const page of pages) {
        const text = await this.get(ALLOWED_PAGES[page], cookie);
        if (isLoginPage(text)) throw new RouterAuthError('Router session ended unexpectedly');
        result[page] = text;
        lastToken = parseOnttoken(text) ?? lastToken;
      }
      return result;
    } finally {
      await this.logout(cookie, lastToken);
    }
  }

  private async login(): Promise<string> {
    const initialCookie = 'Cookie=body:Language:english:id=-1';
    const tokenResponse = await this.request('/asp/GetRandCount.asp', {
      method: 'POST',
      headers: { Cookie: initialCookie },
    });
    const rawToken = await tokenResponse.text();
    // The token may be preceded by a byte order mark (U+FEFF).
    const token = (rawToken.charCodeAt(0) === 0xfeff ? rawToken.slice(1) : rawToken).trim();

    const body = new URLSearchParams({
      UserName: this.options.username,
      // The router's own login page sends the password Base64-encoded (not hashed).
      PassWord: Buffer.from(this.options.password, 'utf8').toString('base64'),
      Language: 'english',
      'x.X_HW_Token': token,
    });
    const response = await this.request('/login.cgi', {
      method: 'POST',
      headers: { Cookie: initialCookie, 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    const session = sessionCookie(response.headers.getSetCookie?.() ?? []);
    if (!session) {
      // Never retried automatically: three failures lock the account on the router.
      this.blockedUntil = Date.now() + (this.options.loginCooldownMs ?? 30 * 60_000);
      logger.warn('Router login failed; further logins paused');
      throw new RouterAuthError('Router rejected the login');
    }
    return session;
  }

  private async logout(cookie: string, token: string | null): Promise<void> {
    try {
      await this.request('/logout.cgi?RequestFile=html/logout.html', {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(token ? { 'x.X_HW_Token': token } : {}),
      });
    } catch {
      // The session times out on the router anyway; a failed logout is not an error for the caller.
    }
  }

  private async get(path: string, cookie: string): Promise<string> {
    if (!Object.values(ALLOWED_PAGES).includes(path as (typeof ALLOWED_PAGES)[RouterPage])) {
      throw new Error(`Refusing to request a page outside the allow-list: ${path}`);
    }
    const response = await this.request(path, { headers: { Cookie: cookie } });
    return response.text();
  }

  private async request(path: string, init: RequestInit): Promise<Response> {
    try {
      const response = await fetch(new URL(path, this.options.baseUrl), {
        ...init,
        redirect: 'manual',
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 10_000),
      });
      if (response.status >= 500)
        throw new RouterUnavailableError(`Router answered HTTP ${response.status}`);
      return response;
    } catch (err) {
      if (err instanceof RouterUnavailableError) throw err;
      throw new RouterUnavailableError(`Router not reachable: ${(err as Error).name}`);
    }
  }
}

/** Picks the session cookie the router sets after a successful login (it carries a sid). */
function sessionCookie(setCookies: string[]): string | null {
  for (const header of setCookies) {
    const pair = header.split(';')[0]!.trim();
    if (/^Cookie=.*sid=/i.test(pair)) return pair;
  }
  return null;
}
