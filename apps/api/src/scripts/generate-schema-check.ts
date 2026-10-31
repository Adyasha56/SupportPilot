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
 */
import { ComposeOutputSchema, PlannerOutputSchema, toGeminiResponseJsonSchema } from '@supportpilot/shared';
import { GeminiLlmProvider } from '../llm/gemini-llm-provider';
import { loadLlmSettingsFromEnv } from '../llm/llm.settings';

async function checkSchema(
  provider: GeminiLlmProvider,
  label: string,
  systemInstruction: string,
  userMessage: string,
  schema: typeof PlannerOutputSchema | typeof ComposeOutputSchema,
  timeoutMs: number,
  maxOutputTokens: number,
): Promise<boolean> {
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
    console.log(`${label}: FAIL - generate() returned [${result.error.code}] ${result.error.message}`);
    return false;
  }

  const parsed = schema.safeParse(JSON.parse(result.result.text));
  if (!parsed.success) {
    console.log(`${label}: FAIL - response was valid JSON but didn't match the schema: ${parsed.error.message}`);
    return false;
  }

  console.log(`${label}: OK`);
  console.log(JSON.stringify(parsed.data));
  return true;
}

async function main(): Promise<void> {
  const settings = loadLlmSettingsFromEnv(process.env);
  if (!settings.geminiApiKey) {
    console.error('GEMINI_API_KEY is not set.');
    process.exitCode = 1;
    return;
  }

  const provider = new GeminiLlmProvider(settings);

  const plannerOk = await checkSchema(
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

  const composeOk = await checkSchema(
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

  if (!plannerOk || !composeOk) {
    process.exitCode = 1;
  }
}

main().catch((err: unknown) => {
  console.error('generate-schema-check failed:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
