/**
 * Manual only - calls the REAL Gemini API and spends real free-tier quota.
 * Never run in CI, never run automatically. Stage 4 finding 2.
 *
 *   pnpm run latency-probe -- --transport raw
 *   pnpm run latency-probe -- --transport raw --no-keepalive
 *   pnpm run latency-probe -- --transport sdk
 *   pnpm run latency-probe -- --transport provider
 *
 * --count N (default 5, down from the original 15 - Stage 4 finding 2/6)
 * and --spacing MS (default 5000) keep a routine check cheap. QUOTA
 * WARNING, printed every run: a failed call (TIMEOUT, UNAVAILABLE, 503,
 * 429, ...) is not necessarily free - this project observed circumstantial
 * evidence (not proof) that even rejected/timed-out requests can count
 * against a model's daily cap (see docs/learning-notes.md, Stage 4
 * finding 1/2026-11-03) - a failing run still spends real budget.
 *
 * Three transports, so a stall observed on one can be narrowed to our own
 * code, the SDK, or the network/server, instead of guessed at:
 *  - raw:      node:https directly, no SDK, no throttled client. API key
 *              sent only in the x-goog-api-key request header (confirmed
 *              against the installed @google/genai@2.31.0 SDK's own
 *              source - generativelanguage.googleapis.com/v1beta/models/
 *              {model}:generateContent, camelCase JSON fields - a live
 *              docs fetch for this endpoint returned a DIFFERENT, wrong
 *              API shape, so the SDK's own source is what this is built
 *              from, not that fetch). Prints time-to-response-headers and
 *              time-to-body separately. --no-keepalive forces a brand new
 *              TCP+TLS connection for every single call (agent: false);
 *              the default reuses one keep-alive connection across all 15
 *              calls, same as a normal persistent HTTP client.
 *  - sdk:      the real @google/genai SDK directly (new GoogleGenAI(...).
 *              models.generateContent()), no ThrottledClient, no retry.
 *  - provider: our real GeminiLlmProvider, exactly as the app uses it
 *              today (throttled, retried, the TIMEOUT/ABORTED split).
 *
 * Every call also fires an "embedding ping" - one tiny, real embed() call,
 * via GeminiLlmProvider, STARTED CONCURRENTLY with the main call (same
 * instant, via Promise.all) - so a stall that only affects generation
 * (not embedding) looks different from a stall that affects connectivity
 * to the API in general.
 *
 * Prints, per call: transport, latency, outcome code (OK or a
 * GenerateErrorCode-shaped string), token counts, finish reason, the raw
 * transport's header/body split when applicable, and the embedding ping's
 * own outcome/latency - and NOTHING else. Never the API key, never a URL
 * containing it, never a full response body or prompt text.
 *
 * Lives in apps/api/dev-scripts/, compiled by tsconfig.dev-scripts.json
 * into the gitignored dist-dev/ - see docs/learning-notes.md for why.
 */
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';
import { GoogleGenAI, ThinkingLevel } from '@google/genai';
import { PlannerOutputSchema, toGeminiResponseJsonSchema } from '@supportpilot/shared';
import { GeminiLlmProvider } from '../src/llm/gemini-llm-provider';
import { loadLlmSettingsFromEnv } from '../src/llm/llm.settings';
import { formatThinkingLevel } from '../src/llm/thinking-level';

const DEFAULT_CALL_COUNT = 5;
const DEFAULT_SPACING_MS = 5000;

const SYSTEM_INSTRUCTION =
  'You are a fictional test fixture for a support agent. Respond with structured JSON only, per the provided schema. Do not request any tool.';
const USER_MESSAGE = 'Do you offer price matching with competitors?';
const EMBED_PING_TEXT = 'ping';

type Transport = 'raw' | 'sdk' | 'provider';

function parseTransport(): Transport {
  const idx = process.argv.indexOf('--transport');
  if (idx === -1) {
    return 'provider';
  }
  const value = process.argv[idx + 1];
  if (value !== 'raw' && value !== 'sdk' && value !== 'provider') {
    throw new Error(`--transport must be one of raw, sdk, provider (got ${JSON.stringify(value)}).`);
  }
  return value;
}

function parseIntFlag(flag: string, defaultValue: number): number {
  const idx = process.argv.indexOf(flag);
  if (idx === -1) {
    return defaultValue;
  }
  const raw = process.argv[idx + 1];
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${flag} must be a positive integer (got ${JSON.stringify(raw)}).`);
  }
  return value;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface GenerateCallResult {
  outcomeCode: string;
  latencyMs: number;
  /** raw transport only. */
  timeToHeadersMs?: number;
  timeToBodyMs?: number;
  inputTokens: number;
  outputTokens: number;
  finishReason: string;
}

interface PingResult {
  outcomeCode: string;
  latencyMs: number;
}

// --- raw transport (node:https directly) -----------------------------------

function buildThinkingLevelForWire(level: string | undefined): string | undefined {
  return level === undefined ? undefined : level.toUpperCase();
}

/** Maps our plain lowercase level to the real SDK enum - same mapping gemini-llm-provider.ts uses. */
function toSdkThinkingLevel(level: string | undefined): ThinkingLevel | undefined {
  switch (level) {
    case 'minimal':
      return ThinkingLevel.MINIMAL;
    case 'low':
      return ThinkingLevel.LOW;
    case 'medium':
      return ThinkingLevel.MEDIUM;
    case 'high':
      return ThinkingLevel.HIGH;
    default:
      return undefined;
  }
}

function callRaw(
  apiKey: string,
  model: string,
  responseSchema: Record<string, unknown>,
  maxOutputTokens: number,
  thinkingLevel: string | undefined,
  timeoutMs: number,
  agent: HttpsAgent | false,
): Promise<GenerateCallResult> {
  const generationConfig: Record<string, unknown> = {
    responseMimeType: 'application/json',
    responseJsonSchema: responseSchema,
    maxOutputTokens,
    temperature: 0,
  };
  const wireLevel = buildThinkingLevelForWire(thinkingLevel);
  if (wireLevel !== undefined) {
    generationConfig.thinkingConfig = { thinkingLevel: wireLevel };
  }
  const payload = JSON.stringify({
    contents: [{ role: 'user', parts: [{ text: USER_MESSAGE }] }],
    systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
    generationConfig,
  });

  return new Promise((resolve) => {
    const startedAt = Date.now();
    let headersAt: number | undefined;
    let settled = false;

    const finish = (result: GenerateCallResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const req = httpsRequest(
      {
        hostname: 'generativelanguage.googleapis.com',
        path: `/v1beta/models/${encodeURIComponent(model)}:generateContent`,
        method: 'POST',
        headers: {
          'x-goog-api-key': apiKey,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
        agent,
        timeout: timeoutMs,
      },
      (res) => {
        headersAt = Date.now();
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const bodyAt = Date.now();
          const timeToHeadersMs = headersAt! - startedAt;
          const timeToBodyMs = bodyAt - headersAt!;
          const statusOk = (res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300;
          if (!statusOk) {
            finish({
              outcomeCode: `HTTP_${res.statusCode ?? 'UNKNOWN'}`,
              latencyMs: bodyAt - startedAt,
              timeToHeadersMs,
              timeToBodyMs,
              inputTokens: 0,
              outputTokens: 0,
              finishReason: 'n/a',
            });
            return;
          }
          let parsed: {
            candidates?: Array<{ finishReason?: string }>;
            usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
          } = {};
          try {
            parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          } catch {
            finish({
              outcomeCode: 'INVALID_OUTPUT',
              latencyMs: bodyAt - startedAt,
              timeToHeadersMs,
              timeToBodyMs,
              inputTokens: 0,
              outputTokens: 0,
              finishReason: 'n/a',
            });
            return;
          }
          finish({
            outcomeCode: 'OK',
            latencyMs: bodyAt - startedAt,
            timeToHeadersMs,
            timeToBodyMs,
            inputTokens: parsed.usageMetadata?.promptTokenCount ?? 0,
            outputTokens: parsed.usageMetadata?.candidatesTokenCount ?? 0,
            finishReason: parsed.candidates?.[0]?.finishReason ?? 'unknown',
          });
        });
      },
    );

    req.on('timeout', () => {
      req.destroy();
      finish({ outcomeCode: 'TIMEOUT', latencyMs: Date.now() - startedAt, timeToHeadersMs: headersAt !== undefined ? headersAt - startedAt : undefined, inputTokens: 0, outputTokens: 0, finishReason: 'n/a' });
    });
    req.on('error', () => {
      // Never print the raw error message - it can echo back request details (e.g. a malformed URL including the key) depending on the underlying error type.
      finish({ outcomeCode: 'TRANSPORT_ERROR', latencyMs: Date.now() - startedAt, timeToHeadersMs: headersAt !== undefined ? headersAt - startedAt : undefined, inputTokens: 0, outputTokens: 0, finishReason: 'n/a' });
    });

    req.end(payload);
  });
}

// --- sdk transport (real SDK, no throttle) ----------------------------------

async function callSdk(ai: GoogleGenAI, model: string, responseSchema: Record<string, unknown>, maxOutputTokens: number, thinkingLevel: string | undefined, timeoutMs: number): Promise<GenerateCallResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  try {
    const sdkThinkingLevel = toSdkThinkingLevel(thinkingLevel);
    const response = await ai.models.generateContent({
      model,
      contents: [{ role: 'user', parts: [{ text: USER_MESSAGE }] }],
      config: {
        systemInstruction: SYSTEM_INSTRUCTION,
        responseMimeType: 'application/json',
        responseJsonSchema: responseSchema,
        maxOutputTokens,
        temperature: 0,
        ...(sdkThinkingLevel !== undefined ? { thinkingConfig: { thinkingLevel: sdkThinkingLevel } } : {}),
        abortSignal: controller.signal,
      },
    });
    return {
      outcomeCode: 'OK',
      latencyMs: Date.now() - startedAt,
      inputTokens: response.usageMetadata?.promptTokenCount ?? 0,
      outputTokens: response.usageMetadata?.candidatesTokenCount ?? 0,
      finishReason: response.candidates?.[0]?.finishReason ?? 'unknown',
    };
  } catch {
    const aborted = controller.signal.aborted;
    return {
      outcomeCode: aborted ? 'TIMEOUT' : 'SDK_ERROR',
      latencyMs: Date.now() - startedAt,
      inputTokens: 0,
      outputTokens: 0,
      finishReason: 'n/a',
    };
  } finally {
    clearTimeout(timer);
  }
}

// --- provider transport (our GeminiLlmProvider, as today) ------------------

async function callProvider(
  provider: GeminiLlmProvider,
  responseSchema: Record<string, unknown>,
  maxOutputTokens: number,
  thinkingLevel: 'minimal' | 'low' | 'medium' | 'high' | undefined,
  timeoutMs: number,
): Promise<GenerateCallResult> {
  const startedAt = Date.now();
  const outcome = await provider.generate({
    systemInstruction: SYSTEM_INSTRUCTION,
    messages: [{ role: 'user', text: USER_MESSAGE }],
    responseSchema,
    maxOutputTokens,
    temperature: 0,
    thinkingLevel,
    timeoutMs,
  });
  const latencyMs = Date.now() - startedAt;
  if (!outcome.ok) {
    return { outcomeCode: outcome.error.code, latencyMs, inputTokens: 0, outputTokens: 0, finishReason: 'n/a' };
  }
  return {
    outcomeCode: 'OK',
    latencyMs,
    inputTokens: outcome.result.usage.inputTokens,
    outputTokens: outcome.result.usage.outputTokens,
    finishReason: outcome.result.finishReason ?? 'unknown',
  };
}

// --- embedding ping (always via GeminiLlmProvider, regardless of transport) ---

async function embedPing(provider: GeminiLlmProvider): Promise<PingResult> {
  const startedAt = Date.now();
  const outcome = await provider.embed([EMBED_PING_TEXT], 'RETRIEVAL_QUERY');
  const latencyMs = Date.now() - startedAt;
  return { outcomeCode: outcome.ok ? 'OK' : outcome.error.code, latencyMs };
}

async function main(): Promise<void> {
  let transport: Transport;
  try {
    transport = parseTransport();
  } catch (err) {
    console.error((err as Error).message);
    process.exitCode = 1;
    return;
  }
  const noKeepalive = process.argv.includes('--no-keepalive');
  if (noKeepalive && transport !== 'raw') {
    console.log('--no-keepalive only applies to --transport raw; ignored for this run.');
  }
  let callCount: number;
  let spacingMs: number;
  try {
    callCount = parseIntFlag('--count', DEFAULT_CALL_COUNT);
    spacingMs = parseIntFlag('--spacing', DEFAULT_SPACING_MS);
  } catch (err) {
    console.error((err as Error).message);
    process.exitCode = 1;
    return;
  }

  const settings = loadLlmSettingsFromEnv(process.env);
  if (!settings.geminiApiKey) {
    console.error('GEMINI_API_KEY is not set.');
    process.exitCode = 1;
    return;
  }

  console.log(
    `Transport: "${transport}"${transport === 'raw' ? ` (keepalive: ${noKeepalive ? 'off' : 'on'})` : ''}, model: "${settings.generateModel}", thinking level: "${formatThinkingLevel(settings.generateThinkingLevel)}", timeout: ${settings.generateTimeoutMs}ms`,
  );
  console.log(
    `QUOTA WARNING: a failed call is not necessarily free - this project has circumstantial evidence (not proof) that even rejected/timed-out requests can count against a model's daily cap. Each of the ${callCount} calls below is a real request. See docs/learning-notes.md for the evidence.`,
  );
  console.log(`Running ${callCount} sequential calls, ${spacingMs}ms apart, each with a concurrent embedding ping...\n`);

  const provider = new GeminiLlmProvider(settings);
  const ai = transport === 'sdk' ? new GoogleGenAI({ apiKey: settings.geminiApiKey }) : undefined;
  const rawAgent: HttpsAgent | false = noKeepalive ? false : new HttpsAgent({ keepAlive: true, keepAliveMsecs: 1000 });
  const responseSchema = toGeminiResponseJsonSchema(PlannerOutputSchema);

  const results: Array<{ index: number; generate: GenerateCallResult; ping: PingResult }> = [];

  for (let i = 0; i < callCount; i++) {
    const [generateResult, pingResult] = await Promise.all([
      transport === 'raw'
        ? callRaw(settings.geminiApiKey, settings.generateModel, responseSchema, settings.generateMaxOutputTokens, settings.generateThinkingLevel, settings.generateTimeoutMs, rawAgent)
        : transport === 'sdk'
          ? callSdk(ai!, settings.generateModel, responseSchema, settings.generateMaxOutputTokens, settings.generateThinkingLevel, settings.generateTimeoutMs)
          : callProvider(provider, responseSchema, settings.generateMaxOutputTokens, settings.generateThinkingLevel, settings.generateTimeoutMs),
      embedPing(provider),
    ]);

    results.push({ index: i + 1, generate: generateResult, ping: pingResult });

    const g = generateResult;
    const headerSplit = g.timeToHeadersMs !== undefined ? `  headers=${String(g.timeToHeadersMs).padStart(6)}ms body=${String(g.timeToBodyMs ?? 0).padStart(6)}ms` : '';
    console.log(
      `#${String(i + 1).padStart(2)}  latency=${String(g.latencyMs).padStart(6)}ms  outcome=${g.outcomeCode.padEnd(16)}  tokens(in/out)=${g.inputTokens}/${g.outputTokens}  finishReason=${g.finishReason}${headerSplit}  |  embedPing=${String(pingResult.latencyMs).padStart(6)}ms(${pingResult.outcomeCode})`,
    );

    if (i < callCount - 1) {
      await sleep(spacingMs);
    }
  }

  if (rawAgent !== false) {
    rawAgent.destroy();
  }

  const ok = results.filter((r) => r.generate.outcomeCode === 'OK');
  const pingOk = results.filter((r) => r.ping.outcomeCode === 'OK');
  console.log(`\n=== SUMMARY (transport: "${transport}") ===`);
  console.log(`Generate: ${ok.length}/${results.length} succeeded. Embedding ping: ${pingOk.length}/${results.length} succeeded.`);
  if (ok.length > 0) {
    const latencies = ok.map((r) => r.generate.latencyMs).sort((a, b) => a - b);
    const mean = latencies.reduce((acc, v) => acc + v, 0) / latencies.length;
    console.log(`Generate latency (ms) - min: ${latencies[0]}, median: ${latencies[Math.floor(latencies.length / 2)]}, mean: ${mean.toFixed(0)}, max: ${latencies[latencies.length - 1]}`);
  }
  const failed = results.filter((r) => r.generate.outcomeCode !== 'OK');
  if (failed.length > 0) {
    console.log(`Generate failures: ${failed.map((r) => `#${r.index}=${r.generate.outcomeCode}`).join(', ')}`);
    process.exitCode = 1;
  }
  const pingFailed = results.filter((r) => r.ping.outcomeCode !== 'OK');
  if (pingFailed.length > 0) {
    console.log(`Embedding ping failures (general connectivity, not generation-specific): ${pingFailed.map((r) => `#${r.index}=${r.ping.outcomeCode}`).join(', ')}`);
  }
}

main().catch((err: unknown) => {
  console.error('latency-probe failed:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
