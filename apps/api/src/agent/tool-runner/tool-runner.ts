import {
  ConnectorConfig,
  EscalateToHumanOutputSchema,
  GetOrderOutputSchema,
  IssueRefundOutputSchema,
  resolvePath,
  TOOL_INPUT_SCHEMAS,
  TrackShipmentOutputSchema,
} from '@supportpilot/shared';
import { ConnectorConfigRepository } from '../../connectors/connector-config.repository';
import { sendToolHttpRequest } from './http-client';
import { buildToolRequestUrl, RequestTemplateError, substitutePathTemplate } from './request-template';
import { envSecretProvider, SecretProvider } from './secret-provider';
import { assertSafeToolRequestUrl, DnsResolver, realDnsResolver, SsrfGuardError } from './ssrf-guard';
import { ToolRunnerSettings } from './tool-runner.settings';

export type ToolRunErrorCode =
  | 'INVALID_INPUT'
  | 'CONFIG_ERROR'
  | 'SECRET_NOT_CONFIGURED'
  | 'BLOCKED_BY_POLICY'
  | 'TIMEOUT'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'UPSTREAM_AUTH_FAILED'
  | 'UPSTREAM_ERROR'
  | 'RESPONSE_TOO_LARGE'
  | 'INVALID_RESPONSE';

export type ToolRunResult =
  | { ok: true; data: unknown; riskLevel: 'low' | 'high' }
  | { ok: false; error: { code: ToolRunErrorCode; message: string } };

const TOOL_OUTPUT_SCHEMAS = {
  get_order: GetOrderOutputSchema,
  track_shipment: TrackShipmentOutputSchema,
  issue_refund: IssueRefundOutputSchema,
  escalate_to_human: EscalateToHumanOutputSchema,
} as const;

/** Which input arguments are id-shaped, for applying a connector's idPattern. */
const ID_ARG_NAMES: Record<string, string[]> = {
  get_order: ['order_id'],
  track_shipment: ['order_id'],
  issue_refund: ['order_id'],
  escalate_to_human: [],
};

export type LogOutcome = (tenantId: string, tool: string, code: string, durationMs: number) => void;

export interface RunToolParams {
  tenantId: string;
  toolName: string;
  args: Record<string, unknown>;
  repository: ConnectorConfigRepository;
  settings: ToolRunnerSettings;
  secretProvider?: SecretProvider;
  resolveDns?: DnsResolver;
  logOutcome?: LogOutcome;
}

const GENERIC_ERROR_MESSAGES: Record<ToolRunErrorCode, string> = {
  INVALID_INPUT: 'The arguments provided are invalid.',
  CONFIG_ERROR: 'Connector is not configured correctly.',
  SECRET_NOT_CONFIGURED: 'Connector secret is not configured.',
  BLOCKED_BY_POLICY: 'Request was blocked by security policy.',
  TIMEOUT: 'Upstream request timed out.',
  NOT_FOUND: 'Requested resource was not found.',
  CONFLICT: 'Requested action conflicts with the current state.',
  UPSTREAM_AUTH_FAILED: 'Upstream rejected the request credentials.',
  UPSTREAM_ERROR: 'Upstream request failed.',
  RESPONSE_TOO_LARGE: 'Upstream response exceeded the allowed size.',
  INVALID_RESPONSE: 'Upstream response was not in the expected shape.',
};

/**
 * The single entry point. Never throws for expected failures - every
 * outcome, success or failure, is returned as a structured result. Error
 * messages are always the fixed, generic text above: never the token, the
 * resolved URL, customerRef, response bodies, or stack traces.
 */
export async function runTool(params: RunToolParams): Promise<ToolRunResult> {
  const {
    tenantId,
    toolName,
    args,
    repository,
    settings,
    secretProvider = envSecretProvider,
    resolveDns = realDnsResolver,
    logOutcome,
  } = params;

  const startedAt = Date.now();
  const finish = (result: ToolRunResult): ToolRunResult => {
    const code = result.ok ? 'OK' : result.error.code;
    logOutcome?.(tenantId, toolName, code, Date.now() - startedAt);
    return result;
  };
  const fail = (code: ToolRunErrorCode): ToolRunResult =>
    finish({ ok: false, error: { code, message: GENERIC_ERROR_MESSAGES[code] } });

  // 1. Load the config for THIS tenant only.
  let config: ConnectorConfig;
  try {
    config = repository.findByTool(tenantId, toolName);
  } catch {
    return fail('CONFIG_ERROR');
  }

  // 2. Validate args: the shared tool input schema first (generic id
  // pattern), then the connector's own idPattern as an additional check.
  const inputSchema = TOOL_INPUT_SCHEMAS[config.tool];
  const parsedArgs = inputSchema.safeParse(args);
  if (!parsedArgs.success) {
    return fail('INVALID_INPUT');
  }
  const validatedArgs: Record<string, unknown> = parsedArgs.data;

  if (config.idPattern) {
    let idPatternRegex: RegExp;
    try {
      idPatternRegex = new RegExp(config.idPattern);
    } catch {
      return fail('CONFIG_ERROR');
    }
    for (const argName of ID_ARG_NAMES[config.tool] ?? []) {
      const value = validatedArgs[argName];
      if (typeof value === 'string' && !idPatternRegex.test(value)) {
        return fail('INVALID_INPUT');
      }
    }
  }

  // 3. Build the URL and (for POST) the body - only mapped fields are sent.
  let url: URL;
  let body: string | undefined;
  try {
    const pathArgs = stringifyArgsForTemplate(validatedArgs);
    const substitutedPath = substitutePathTemplate(config.request.path, pathArgs);
    url = buildToolRequestUrl(config.request.baseUrl, substitutedPath);

    if (config.request.method === 'POST' && config.request.body) {
      const bodyObject: Record<string, unknown> = {};
      for (const [outboundField, argName] of Object.entries(config.request.body)) {
        bodyObject[outboundField] = validatedArgs[argName];
      }
      body = JSON.stringify(bodyObject);
    }
  } catch (err) {
    if (err instanceof RequestTemplateError) {
      return fail('INVALID_INPUT');
    }
    return fail('CONFIG_ERROR');
  }

  // 4. Pass the guard.
  try {
    await assertSafeToolRequestUrl({ url, settings, resolveDns });
  } catch (err) {
    if (err instanceof SsrfGuardError) {
      return fail('BLOCKED_BY_POLICY');
    }
    return fail('CONFIG_ERROR');
  }

  // 5. Resolve the secret. Unset means no request is ever sent.
  const secretValue = secretProvider(config.request.auth.secretRef);
  if (!secretValue) {
    return fail('SECRET_NOT_CONFIGURED');
  }

  // 6. Build headers and send exactly one request, no retries for any method.
  const headers: Record<string, string> = {
    Authorization: `Bearer ${secretValue}`,
    'Accept-Encoding': 'identity',
    Accept: 'application/json',
  };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    headers['Content-Length'] = String(Buffer.byteLength(body));
  }

  const outcome = await sendToolHttpRequest({
    url,
    method: config.request.method,
    headers,
    body,
    settings,
    resolveDns,
  });

  switch (outcome.kind) {
    case 'timeout':
      return fail('TIMEOUT');
    case 'response-too-large':
      return fail('RESPONSE_TOO_LARGE');
    case 'redirect-refused':
    case 'network-error':
      return fail('UPSTREAM_ERROR');
    case 'success':
      break;
  }

  // 7. Reject any encoded response (we asked for identity only).
  if (outcome.headers['content-encoding']) {
    return fail('INVALID_RESPONSE');
  }

  const statusErrorCode = mapStatusToErrorCode(outcome.status);
  if (statusErrorCode) {
    return fail(statusErrorCode);
  }

  const contentType = outcome.headers['content-type'];
  const contentTypeValue = Array.isArray(contentType) ? contentType[0] : contentType;
  if (!contentTypeValue || !contentTypeValue.toLowerCase().includes('application/json')) {
    return fail('INVALID_RESPONSE');
  }

  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(outcome.body.toString('utf-8'));
  } catch {
    return fail('INVALID_RESPONSE');
  }

  const mapped: Record<string, unknown> = {};
  for (const [field, path] of Object.entries(config.responseMap)) {
    mapped[field] = resolvePath(parsedBody, path);
  }

  const outputSchema = TOOL_OUTPUT_SCHEMAS[config.tool];
  const parsedOutput = outputSchema.safeParse(mapped);
  if (!parsedOutput.success) {
    return fail('INVALID_RESPONSE');
  }

  return finish({ ok: true, data: parsedOutput.data, riskLevel: config.riskLevel });
}

function mapStatusToErrorCode(status: number): ToolRunErrorCode | null {
  if (status >= 200 && status < 300) {
    return null;
  }
  if (status === 401 || status === 403) {
    return 'UPSTREAM_AUTH_FAILED';
  }
  if (status === 404) {
    return 'NOT_FOUND';
  }
  if (status === 409) {
    return 'CONFLICT';
  }
  return 'UPSTREAM_ERROR';
}

function stringifyArgsForTemplate(args: Record<string, unknown>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === 'string') {
      result[key] = value;
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      result[key] = String(value);
    }
  }
  return result;
}
