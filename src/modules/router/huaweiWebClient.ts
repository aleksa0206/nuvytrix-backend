import { logger } from '../../config/logger';
import { isLoginPage, parseOnttoken } from './huaweiParser';

/**
 * The only pages this client may request. Anything else (including every *.cgi except login and
 * logout) is refused before a request is made. One page embeds Wi-Fi keys (`wifi`): it is needed to
 * change Wi-Fi settings, its parser keeps only non-secret fields, and keys are only compared with a
 * requested one, never returned, stored or logged. See docs/huawei/wifi-management.md.
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
  dhcpServer: '/html/bbsp/dhcpservercfg/dhcp2.asp',
  dhcpStatic: '/html/bbsp/dhcpstatic/dhcpstatic.asp',
  macFilter: '/html/bbsp/macfilter/macfilter.asp',
  wifiMacFilter: '/html/bbsp/wlanmacfilter/wlanmacfilter.asp',
  portMapping: '/html/bbsp/portmapping/portmappingnew.asp',
  dmz: '/html/bbsp/dmz/dmz.asp',
  portTrigger: '/html/bbsp/porttrigger/porttrigger.asp',
  // Lists every SSID of both bands, with their Wi-Fi keys (see above).
  wifi: '/html/amp/wlanbasic/WlanBasic.asp?2G',
  // Parental control: the forms live on the MAC page, the data in parentalctrlinfo.asp.
  parental: '/html/bbsp/parentalctrl/parentalctrlmac.asp',
  parentalInfo: '/html/bbsp/common/parentalctrlinfo.asp',
  // Static DNS: the form on dnshosts.asp, the data in dnshostslist.asp.
  dnsHosts: '/html/bbsp/dnsconfiguration/dnshosts.asp',
  dnsHostsData: '/html/bbsp/common/dnshostslist.asp',
  // DDNS: the page lists entries without their passwords (write-only on the router).
  ddns: '/html/bbsp/ddns/ddns.asp',
  upnp: '/html/bbsp/upnp/upnp.asp',
  wifiSchedule: '/html/amp/wifische/WlanSchedule.asp',
  // Form token for radio settings; the values are read back from `wifi`.
  wifiAdvanced: '/html/amp/wlanadv/WlanAdvance.asp',
  led: '/html/ssmp/ledcfg/ledcfg.asp',
  // Maintenance → Configuration File: its "save and reboot" form restarts the router.
  cfgFile: '/html/ssmp/cfgfile/cfgfileroot.asp',
  // Diagnostics: started from the page, results polled from the Get*Result pages.
  diagnostics: '/html/bbsp/maintenance/diagnosecommon.asp',
  pingResult: '/html/bbsp/maintenance/GetPingResult.asp',
  traceResult: '/html/bbsp/maintenance/GetRouteResult.asp',
  userLog: '/html/ssmp/userlog/normallogview.asp',
  deviceAccess: '/html/bbsp/acl/aclsmart.asp',
  // IPv6 LAN settings; read only.
  ipv6Lan: '/html/bbsp/lanaddress/lanaddress.asp',
  // Also carries WAN account fields; only the WAN path, mode and services are parsed from it.
  wanList: '/html/bbsp/common/wan_list.asp',
} as const;

export type RouterPage = keyof typeof ALLOWED_PAGES;

/**
 * Pages whose own forms Nuvytrix may submit, and the CGI actions allowed for each. Each entry is
 * added only after its request format was verified on the router (docs/huawei/feature-parity.md).
 */
export const WRITABLE_PAGES = {
  ipFilter: ['add', 'set', 'del'],
  dhcpServer: ['set'],
  dhcpStatic: ['add', 'set', 'del'],
  macFilter: ['add', 'set', 'del'],
  wifiMacFilter: ['add', 'set', 'del'],
  // The page posts mappings with its ajax CGIs; delete is the ordinary del.cgi.
  portMapping: ['addcfgajax', 'complexajax', 'del'],
  dmz: ['add', 'set', 'del'],
  portTrigger: ['add', 'set', 'del'],
  wifi: ['add', 'set', 'del'],
  parental: ['add', 'set', 'del'],
  dnsHosts: ['add', 'set', 'del'],
  ddns: ['add', 'set', 'del'],
  upnp: ['set'],
  wifiSchedule: ['set'],
  wifiAdvanced: ['set'],
  led: ['set'],
  // Only the page's own "save and reboot" request (RouterRebootService).
  cfgFile: ['set'],
  // Starts a ping or traceroute; changes no setting.
  diagnostics: ['complex'],
  deviceAccess: ['set'],
} as const satisfies Partial<Record<RouterPage, readonly string[]>>;

export type WritablePage = keyof typeof WRITABLE_PAGES;
export type WriteAction = (typeof WRITABLE_PAGES)[WritablePage][number];

export interface FormSubmission {
  page: WritablePage;
  action: WriteAction;
  /** TR-098 object in the URL (`x=` by default); some pages also send it for del. */
  object?: string;
  /** The URL key the page uses for the object, e.g. `z` on the DHCP server page. Default `x`. */
  objectKey?: string;
  /** More objects in the URL after the main one, e.g. `ma=<mapping>.X_HW_Portlist.1`. */
  extraQuery?: Record<string, string>;
  fields: Record<string, string>;
  /** A request the page sends first in the same session (the Wi-Fi page does before a delete). */
  before?: Omit<FormSubmission, 'page' | 'before'>;
  /** Page to read back after the write when the data is not on the form's page; false = none. */
  readBack?: RouterPage | false;
}

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

/**
 * Talks to the Huawei web UI with the administrator's account. Reads are GETs of allow-listed
 * pages; writes submit only the allow-listed forms in WRITABLE_PAGES, exactly as the router's own
 * page does. The router allows one web session at a time, so every call logs in and out.
 */
export class HuaweiWebClient {
  private blockedUntil = 0;
  private busy: Promise<unknown> = Promise.resolve();

  constructor(private options: HuaweiWebClientOptions) {}

  get isConfigured(): boolean {
    return this.options.username !== '' && this.options.password !== '';
  }

  /** Logs in, fetches the requested pages with one session, logs out. Calls never overlap. */
  fetchPages<T extends RouterPage>(pages: readonly T[]): Promise<Record<T, string>> {
    return this.withSession(async (session) => {
      const result = {} as Record<T, string>;
      for (const page of pages) result[page] = await session.read(page);
      return result;
    });
  }

  /**
   * Loads the form's page (for its anti-CSRF token), submits the form, then reads the page again.
   * Returns the page as read after the write, so the caller can verify the change.
   */
  submitForm(form: FormSubmission): Promise<string> {
    const first = form.before ? { ...form.before, page: form.page } : null;
    const problem = checkForm(form) ?? (first ? checkForm(first) : null);
    if (problem) return Promise.reject(new Error(problem));
    return this.withSession(async (session) => {
      await session.read(form.page);
      if (first) await session.post(first);
      await session.post(form);
      return form.readBack === false ? '' : session.read(form.readBack ?? form.page);
    });
  }

  private withSession<R>(work: (session: Session) => Promise<R>): Promise<R> {
    const run = this.busy.then(
      () => this.runSession(work),
      () => this.runSession(work)
    );
    this.busy = run.catch(() => undefined);
    return run;
  }

  private async runSession<R>(work: (session: Session) => Promise<R>): Promise<R> {
    if (!this.isConfigured) throw new RouterAuthError('Router credentials are not configured');
    if (Date.now() < this.blockedUntil) {
      throw new RouterAuthError('Router login is paused after a failed attempt');
    }

    const cookie = await this.login();
    let token: string | null = null;
    const session: Session = {
      read: async (page) => {
        const text = await this.get(ALLOWED_PAGES[page], cookie);
        if (isLoginPage(text)) throw new RouterAuthError('Router session ended unexpectedly');
        token = parseOnttoken(text) ?? token;
        return text;
      },
      post: async (form) => {
        if (!token) throw new RouterUnavailableError('The router page carried no form token');
        // The page's query (`?2G`) is not part of the CGI directory or RequestFile.
        const pagePath = ALLOWED_PAGES[form.page].split('?')[0]!;
        const directory = pagePath.slice(0, pagePath.lastIndexOf('/') + 1);
        // Same URL the page builds: the CGI is relative to the page, RequestFile has no leading slash.
        const query =
          (form.object ? `${form.objectKey ?? 'x'}=${form.object}&` : '') +
          Object.entries(form.extraQuery ?? {})
            .map(([key, value]) => `${key}=${value}&`)
            .join('') +
          `RequestFile=${pagePath.slice(1)}`;
        const response = await this.request(`${directory}${form.action}.cgi?${query}`, {
          method: 'POST',
          headers: {
            Cookie: cookie,
            'Content-Type': 'application/x-www-form-urlencoded',
            Referer: new URL(ALLOWED_PAGES[form.page], this.options.baseUrl).href,
            Origin: new URL(this.options.baseUrl).origin,
          },
          body: new URLSearchParams({ ...form.fields, 'x.X_HW_Token': token }),
        });
        const text = await response.text();
        if (response.status !== 200 || isLoginPage(text)) {
          throw new RouterUnavailableError(`Router answered the form with HTTP ${response.status}`);
        }
        token = parseOnttoken(text) ?? token;
      },
    };
    try {
      return await work(session);
    } finally {
      await this.logout(cookie, token);
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

/** Why a form must not be sent, or null: only allow-listed CGIs and well-formed object paths. */
function checkForm(form: FormSubmission): string | null {
  const allowed: readonly string[] = WRITABLE_PAGES[form.page];
  if (!allowed.includes(form.action)) return `Refusing ${form.action}.cgi on ${form.page}`;
  if (form.object !== undefined && !/^InternetGatewayDevice(\.[A-Za-z0-9_]+)+$/.test(form.object)) {
    return `Refusing malformed object path ${form.object}`;
  }
  const keys = [form.objectKey ?? 'x', ...Object.keys(form.extraQuery ?? {})];
  if (keys.some((key) => !/^[A-Za-z_]{1,16}$/.test(key))) {
    return `Refusing URL keys ${keys.join(',')}`;
  }
  // Extra objects are router paths, or a path inside the object being added (GROUP_a_x.…).
  const badExtra = Object.values(form.extraQuery ?? {}).find(
    // Router paths, a path inside the object being added (GROUP_a_x.…), or a plain flag word.
    (value) => !/^((InternetGatewayDevice|GROUP_a_x)(\.[A-Za-z0-9_]+)+|[A-Za-z]{1,32})$/.test(value)
  );
  return badExtra === undefined ? null : `Refusing malformed object path ${badExtra}`;
}

interface Session {
  read(page: RouterPage): Promise<string>;
  post(form: FormSubmission): Promise<void>;
}

/** Picks the session cookie the router sets after a successful login (it carries a sid). */
function sessionCookie(setCookies: string[]): string | null {
  for (const header of setCookies) {
    const pair = header.split(';')[0]!.trim();
    if (/^Cookie=.*sid=/i.test(pair)) return pair;
  }
  return null;
}
