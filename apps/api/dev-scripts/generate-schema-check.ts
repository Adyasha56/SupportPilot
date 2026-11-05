/**
 * Manual only - calls the REAL Gemini API and spends real free-tier quota.
 * Never run in CI, never run automatically. Run it yourself:
 *
 *   pnpm run generate-schema-check
 *
 * Proves - against the real API, not just the SDK's own type declarations
 * or the local keyword-compatibility test - that the ACTUAL PlannerOutputSchema
 * and ComposeOutputSchema (packages/shared/src/agent-schemas.ts) round-trip
 * through `responseJsonSchema` for real. Two real calls, one fictional
 * example each. The ONLY things printed are whether each response parsed
 * and, if it did, the parsed value itself (a small, fixed, non-sensitive
 * JSON object): never a raw prompt, never a secret.
 *
 * Lives in apps/api/dev-scripts/, compiled by tsconfig.dev-scripts.json
 * into the gitignored dist-dev/ - see docs/learning-notes.md for why.
 */
import { ComposeOutputSchema, PlannerOutputSchema, toGeminiResponseJsonSchema } from '@supportpilot/shared';
import { GeminiLlmProvider } from '../src/llm/gemini-llm-provider';
import { GenerateErrorCode } from '../src/llm/llm-provider.interface';
import { loadLlmSettingsFromEnv } from '../src/llm/llm.settings';
import { formatThinkingLevel } from '../src/llm/thinking-level';

/**
 * Stage 4 finding 5 - a real generate() call that never produced a model
 * decision at all (quota, timeout, transient network/server issue) is NOT
 * the same thing as the model producing bad output. Lumping both under one
 * "FAIL" hides which one actually happened - see agent-pipeline-smoke-test.ts's
 * NOT_RUN verdict for the same distinction, applied here too.
 */
const INFRASTRUCTURE_FAILURE_CODES: ReadonlySet<GenerateErrorCode> = new Set([
  'NOT_CONFIGURED',
  'RATE_LIMITED',
  'UNAUTHORIZED',
  'TRANSIENT',
  'UNAVAILABLE',
  'TIMEOUT',
  'ABORTED',
]);

type Verdict = 'OK' | 'SCHEMA_MISMATCH' | 'NOT_RUN';

async function checkSchema(
  provider: GeminiLlmProvider,
  label: string,
  systemInstruction: string,
  userMessage: string,
  schema: typeof PlannerOutputSchema | typeof ComposeOutputSchema,
  timeoutMs: number,
  maxOutputTokens: number,
): Promise<Verdict> {
  const responseSchema = toGeminiResponseJsonSchema(schema);

  const result = await provider.generate({
    systemInstruction,
    messages: [{ role: 'user', text: userMessage }],
    responseSchema,
    maxOutputTokens,
    temperature: 0,
    timeoutMs,
  });

  if (!result.ok) {
    if (INFRASTRUCTURE_FAILURE_CODES.has(result.error.code)) {
      console.log(`${label}: NOT_RUN - the call itself never produced a model decision ([${result.error.code}] ${result.error.message})`);
      return 'NOT_RUN';
    }
    console.log(`${label}: FAIL - generate() returned [${result.error.code}] ${result.error.message}`);
    return 'SCHEMA_MISMATCH';
  }

  const parsed = schema.safeParse(JSON.parse(result.result.text));
  if (!parsed.success) {
    console.log(`${label}: FAIL - response was valid JSON but didn't match the schema: ${parsed.error.message}`);
    return 'SCHEMA_MISMATCH';
  }

  console.log(`${label}: OK`);
  console.log(JSON.stringify(parsed.data));
  return 'OK';
}

async function main(): Promise<void> {
  const settings = loadLlmSettingsFromEnv(process.env);
  if (!settings.geminiApiKey) {
    console.error('GEMINI_API_KEY is not set.');
    process.exitCode = 1;
    return;
  }

  console.log(`Generate model: "${settings.generateModel}", thinking level: "${formatThinkingLevel(settings.generateThinkingLevel)}"`);

  const provider = new GeminiLlmProvider(settings);

  const plannerVerdict = await checkSchema(
    provider,
    'PlannerOutputSchema',
    'You are a fictional test fixture for a support agent. A customer named Jamie Fictional asked: ' +
      '"Where is my order ORD-0001?" Respond with structured JSON only, per the provided schema. ' +
      'Request the get_order tool for ORD-0001.',
    'Where is my order ORD-0001?',
    PlannerOutputSchema,
    settings.generateTimeoutMs,
    settings.generateMaxOutputTokens,
  );

  const composeVerdict = await checkSchema(
    provider,
    'ComposeOutputSchema',
    'You are a fictional test fixture for a support agent composing a final reply. The fictional order ORD-0001 ' +
      'was delivered 2 fictional days ago and is within the fictional refund policy window. Respond with structured ' +
      'JSON only, per the provided schema, with outcome "reply" telling the fictional customer their order was delivered.',
    'Where is my order ORD-0001?',
    ComposeOutputSchema,
    settings.generateTimeoutMs,
    settings.generateMaxOutputTokens,
  );

  const verdicts = [plannerVerdict, composeVerdict];
  const notRunCount = verdicts.filter((v) => v === 'NOT_RUN').length;
  const failCount = verdicts.filter((v) => v === 'SCHEMA_MISMATCH').length;
  if (notRunCount > 0) {
    console.log(`\n${notRunCount} of ${verdicts.length} check(s) NOT_RUN (infrastructure failure, not a schema result) - rerun to get a real answer.`);
  }
  if (failCount > 0 || notRunCount > 0) {
    process.exitCode = 1;
  }
}

main().catch((err: unknown) => {
  console.error('generate-schema-check failed:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
