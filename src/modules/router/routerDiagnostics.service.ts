import { z } from 'zod';
import { AppError } from '../../common/errors/AppError';
import { ErrorCode } from '../../common/errors/errorCodes';
import type { RequestContext } from '../auth/auth.types';
import { parseFirewallLogText, stripFirewallLogHeader, unescapeJs } from './huaweiParser';
import type { RouterPage } from './huaweiWebClient';
import type { RouterWriter } from './routerWriter';

/** A host name or an IPv4 address, as the router's diagnostics page accepts it. */
export const diagnosticsSchema = z.object({
  kind: z.enum(['ping', 'traceroute']),
  host: z
    .string()
    .trim()
    .min(1)
    .max(255)
    .regex(
      /^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/,
      'Use a host name like example.com or an IPv4 address'
    ),
});

export type DiagnosticsInput = z.infer<typeof diagnosticsSchema>;

const TESTS = {
  ping: {
    object: 'InternetGatewayDevice.IPPingDiagnostics',
    flag: 'Ping',
    result: 'pingResult',
    fields: (host: string) => ({
      'x.Host': host,
      'x.DiagnosticsState': 'Requested',
      'x.NumberOfRepetitions': '4',
      'x.DSCP': '0',
      'x.DataBlockSize': '56',
      'x.Timeout': '10000',
    }),
  },
  traceroute: {
    object: 'InternetGatewayDevice.TraceRouteDiagnostics',
    flag: 'Traceroute',
    result: 'traceResult',
    fields: (host: string) => ({
      'x.DiagnosticsState': 'Requested',
      'x.Host': host,
      'x.DataBlockSize': '38',
    }),
  },
} as const satisfies Record<string, { result: RouterPage } & Record<string, unknown>>;

export interface DiagnosticsResult {
  /** `Complete`, `Complete_Err`, or `Requested` when it was still running at the time limit. */
  state: string;
  output: string;
}

/** Result pages render `"<output>[@#@]<state>"`, possibly split into several string literals. */
export function parseDiagnosticsResult(page: string): DiagnosticsResult {
  const text = [...page.matchAll(/"((?:\\.|[^"\\])*)"/g)].map((m) => unescapeJs(m[1]!)).join('');
  const [output = '', state = ''] = text.split('[@#@]');
  return {
    state: state.trim(),
    output: output === 'NONE' || output === 'None' ? '' : output.trim(),
  };
}

export interface RouterDiagnosticsSettings {
  pollMs: number;
  maxWaitMs: number;
}

/**
 * Ping and traceroute run by the router itself (Maintenance Diagnosis), the way its page starts them,
 * and the router's user log. Neither changes a setting. Request formats: docs/huawei/maintenance.md.
 */
export class RouterDiagnosticsService {
  constructor(
    private writer: RouterWriter,
    private settings: RouterDiagnosticsSettings = { pollMs: 2500, maxWaitMs: 90_000 }
  ) {}

  /** Starts the test and waits for the router to finish it (or the time limit). */
  async run(input: DiagnosticsInput, adminId: number, context: RequestContext) {
    const test = TESTS[input.kind];
    const started = await this.writer.write({
      action: 'router.diagnostics_run',
      entityType: 'router_diagnostics',
      form: {
        page: 'diagnostics',
        readBack: test.result,
        action: 'complex',
        object: test.object,
        extraQuery: { RUNSTATE_FLAG: test.flag },
        fields: { ...test.fields(input.host), 'RUNSTATE_FLAG.value': 'START' },
      },
      parse: parseDiagnosticsResult,
      // Any answer from the result page means the router took the request.
      verify: () => ({}),
      adminId,
      context,
      details: { requested: input },
    });
    let result = started.state;
    const deadline = Date.now() + this.settings.maxWaitMs;
    while (!result.state.startsWith('Complete') && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, this.settings.pollMs));
      const pages = await this.writer.read([test.result] as const);
      result = parseDiagnosticsResult(pages[test.result]);
    }
    return result;
  }

  /** The router's user log (configuration, shell and alarm entries), newest last. */
  async userLog(): Promise<string[]> {
    const { userLog } = await this.writer.read(['userLog'] as const);
    const text = parseFirewallLogText(userLog);
    if (text === null) throw new AppError(ErrorCode.ROUTER_UNAVAILABLE, 502, 'User log not found');
    // The header holds the serial number and WAN address; only dated entries are returned.
    return stripFirewallLogHeader(text)
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  }
}
