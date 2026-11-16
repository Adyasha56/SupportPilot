/**
 * Manually run only, demo-only - never shipped (lives under dev-scripts/,
 * compiled separately into dist-dev/ via `pnpm run build:dev-scripts`,
 * excluded from the production image entirely, same dividing line
 * mint-customer-token.ts's own doc comment explains).
 *
 *   pnpm run seed-demo-approval -- --tenantId=acme --customerRef=cust_1 --orderId=ORD-1001 --amount=49.99 --chunkKey=<a real chunkKey from an uploaded policy>
 *
 * Why this exists: practicing the admin decision flow (docs/manual-testing.md
 * section 8) needs a real `pending_approval` Approval row to decide on, which
 * normally only exists after a real chat turn through the model proposes a
 * refund. When the model is unavailable (no GEMINI_API_KEY, offline, out of
 * free-tier quota), this script creates that same real row WITHOUT the
 * model - by calling the exact same production code everything else calls,
 * never a shortcut that writes directly to the database:
 *
 *  1. Fetches the order through `ReadOnlyToolRunner` - the SAME risk-gated
 *     wrapper (and the SAME GetOrderOutput -> RefundVerifierOrderSnapshot
 *     mapping, via fetch-fresh-order-snapshot.ts's own
 *     fetchFreshOrderSnapshotViaReadOnlyToolRunner) the real admin decision
 *     route and run-agent.ts's own orderFacts construction both already use
 *     - never a second, hand-rolled mapping that could quietly drift from
 *     either one.
 *  2. Calls the REAL `ApprovalService.createFromProposal` - the refund
 *     verifier, the active-per-order unique index, and the real
 *     Approval+AgentRun transaction all run exactly as they would from a
 *     real chat turn. A tenant with auto-execute genuinely on WILL see a
 *     real refund issued by this script, through the real privileged
 *     runner - this is not a dry run, it is the real pipeline with a
 *     synthetic entry point.
 *  3. Writes a minimal, honest AgentRun alongside it (stepCount/llmCallCount/
 *     tokensIn/tokensOut all zero, steps: [] - there was no real agent run,
 *     and this script never pretends otherwise) with a `runId` prefixed
 *     `demo_seed_` specifically so it can never be mistaken for a real
 *     chat-generated run (`r_...`, see run-id.ts) in the database, in logs,
 *     or in the admin console once Milestone 5 ships.
 *
 * A citation chunkKey is a REQUIRED argument, never invented or guessed -
 * the verifier's own citation rule (MISSING_POLICY_CITATION) requires at
 * least one, and this script has no retrieval step to produce one itself
 * (that is the one piece of the real pipeline this tool deliberately does
 * not reimplement - copy a real chunkKey from an already-uploaded policy
 * document for this tenant, e.g. via the retrieve path or a database
 * lookup).
 *
 * Refuses to run against what looks like the shared test database unless
 * --allow-test-db is passed, same as every other script here - and, with NO
 * bypass flag at all, refuses outright if NODE_ENV=production (there is no
 * legitimate reason a demo-only data-seeding tool should ever run against a
 * production environment). Prints the real database name it is about to
 * seed into before connecting, so a developer gets one last visual
 * confirmation before anything is written.
 */
import { randomUUID } from 'node:crypto';
import mongoose, { ClientSession } from 'mongoose';
import { GENERIC_ID_PATTERN, TENANT_ID_PATTERN, toCents } from '@supportpilot/shared';
import { assertNotTestDatabase, getDatabaseNameFromUri } from '../src/db/database-name';
import { generateConversationId } from '../src/db/conversation-id';
import { TenantDocument, TenantSchema } from '../src/db/schemas/tenant.schema';
import { MongooseTenantRepository } from '../src/db/tenant.repository';
import { AgentRunDocument, AgentRunSchema } from '../src/db/schemas/agent-run.schema';
import { MongooseAgentRunRepository, NewAgentRun } from '../src/db/agent-run.repository';
import { ApprovalDocument, ApprovalSchema } from '../src/approvals/schemas/approval.schema';
import { MongooseApprovalRepository } from '../src/approvals/approval.repository';
import { ApprovalService, CreateFromProposalInput } from '../src/approvals/approval.service';
import { PersistAgentRunForProposal } from '../src/approvals/approval-proposal.port';
import { PrivilegedRefundRunner } from '../src/approvals/privileged-refund-runner';
import { ToolRunnerService } from '../src/agent/tool-runner/tool-runner.service';
import { loadToolRunnerSettingsFromEnv } from '../src/agent/tool-runner/tool-runner.settings';
import { ReadOnlyToolRunner } from '../src/agent/loop/read-only-tool-runner';
import { FileConnectorConfigRepository } from '../src/connectors/connector-config.repository';
import { fetchFreshOrderSnapshotViaReadOnlyToolRunner } from '../src/approvals/fetch-fresh-order-snapshot';
import { TransactionRunner } from '../src/db/transaction-runner';

const DEMO_RUN_ID_PREFIX = 'demo_seed_';

export function parseArgs(argv: string[]): Record<string, string | boolean> {
  const args: Record<string, string | boolean> = {};
  for (const arg of argv) {
    if (!arg.startsWith('--')) continue;
    const [key, value] = arg.slice(2).split('=');
    args[key] = value ?? true;
  }
  return args;
}

export function requireTenantId(args: Record<string, string | boolean>): string {
  const tenantId = args.tenantId;
  if (typeof tenantId !== 'string' || !TENANT_ID_PATTERN.test(tenantId)) {
    throw new Error('--tenantId is required and must match the shared tenant id pattern.');
  }
  return tenantId;
}

export function requireCustomerRef(args: Record<string, string | boolean>): string {
  const customerRef = args.customerRef;
  if (typeof customerRef !== 'string' || !GENERIC_ID_PATTERN.test(customerRef)) {
    throw new Error('--customerRef is required and must match the shared id pattern.');
  }
  return customerRef;
}

export function requireOrderId(args: Record<string, string | boolean>): string {
  const orderId = args.orderId;
  if (typeof orderId !== 'string' || !GENERIC_ID_PATTERN.test(orderId)) {
    throw new Error('--orderId is required and must match the shared id pattern.');
  }
  return orderId;
}

export function requireChunkKey(args: Record<string, string | boolean>): string {
  const chunkKey = args.chunkKey;
  if (typeof chunkKey !== 'string' || !GENERIC_ID_PATTERN.test(chunkKey)) {
    throw new Error(
      '--chunkKey is required and must match the shared id pattern - copy a real one from an already-uploaded policy document for this tenant.',
    );
  }
  return chunkKey;
}

/** Returns both forms - dollars for the AgentRun's own proposedAction field (which stores dollars, matching ProposedAction.args.amount's convention), cents for everything else (CreateFromProposalInput, the verifier). */
export function requireAmount(args: Record<string, string | boolean>): { dollars: number; cents: number } {
  const amount = args.amount;
  if (typeof amount !== 'string') {
    throw new Error('--amount is required - a positive number of dollars, e.g. --amount=49.99.');
  }
  const dollars = Number(amount);
  if (!Number.isFinite(dollars) || dollars <= 0) {
    throw new Error('--amount must be a positive number of dollars.');
  }
  return { dollars, cents: toCents(dollars) };
}

/** Prefixed so a synthetic, model-free run can never be mistaken for a real chat-generated one (`r_...`, see run-id.ts) in the database, in logs, or in a future admin console. */
export function generateDemoRunId(): string {
  return `${DEMO_RUN_ID_PREFIX}${randomUUID()}`;
}

/**
 * No bypass flag, unlike assertNotTestDatabase's --allow-test-db - there is no legitimate reason
 * a demo-only data-seeding tool should ever run against a production environment, so this check
 * gets no escape hatch at all. Checked against `env.NODE_ENV`, the same variable this project's
 * SSRF guard and Dockerfile already treat as the one authoritative production signal (see
 * PROJECT.md's own Docker/SSRF amendment G).
 */
export function refuseProductionEnv(env: NodeJS.ProcessEnv): void {
  if (env.NODE_ENV === 'production') {
    throw new Error('Refusing to run: NODE_ENV=production. This is a demo-only tool - it must never run against a production environment.');
  }
}

/** Same "same connection as the models" requirement MongooseTransactionRunner's own doc comment describes - this script uses the plain default mongoose connection consistently for every repository AND this session, so there is no connection mismatch to worry about. */
class DevMongooseTransactionRunner implements TransactionRunner {
  async withTransaction<T>(fn: (session: ClientSession) => Promise<T>): Promise<T> {
    const session = await mongoose.startSession();
    try {
      let result: T | undefined;
      await session.withTransaction(async () => {
        result = await fn(session);
      });
      return result as T;
    } finally {
      await session.endSession();
    }
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const tenantId = requireTenantId(args);
  const customerRef = requireCustomerRef(args);
  const orderId = requireOrderId(args);
  const chunkKey = requireChunkKey(args);
  const { dollars: amountDollars, cents: amountCents } = requireAmount(args);

  refuseProductionEnv(process.env);

  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error('MONGODB_URI must be set - this script needs a real database, the same one the API is pointed at.');
  }
  assertNotTestDatabase(uri, args['allow-test-db'] === true);
  console.log(`Seeding into database "${getDatabaseNameFromUri(uri)}" - confirm this is the right one before continuing.`);

  const connectorConfigDir = process.env.CONNECTOR_CONFIG_DIR;
  if (!connectorConfigDir) {
    throw new Error('CONNECTOR_CONFIG_DIR must be set - this script fetches the order through the real get_order connector, same as the API.');
  }

  await mongoose.connect(uri);
  try {
    const tenantRepository = new MongooseTenantRepository(mongoose.model<TenantDocument>('Tenant', TenantSchema));
    const tenant = await tenantRepository.findById(tenantId);
    if (!tenant) {
      throw new Error(`Tenant "${tenantId}" does not exist - run create-api-key first to create it.`);
    }

    const connectorConfigRepository = new FileConnectorConfigRepository(connectorConfigDir);
    const toolRunnerSettings = loadToolRunnerSettingsFromEnv(process.env);
    const readOnlyToolRunner = new ReadOnlyToolRunner({
      repository: connectorConfigRepository,
      settings: toolRunnerSettings,
      logOutcome: () => {
        /* intentionally silent - this script's own output is deliberately minimal */
      },
    });

    const snapshotResult = await fetchFreshOrderSnapshotViaReadOnlyToolRunner(readOnlyToolRunner, tenantId, orderId);
    if (!snapshotResult.ok) {
      throw new Error(`Could not fetch order "${orderId}" for tenant "${tenantId}": ${snapshotResult.reason}.`);
    }

    const approvalRepository = new MongooseApprovalRepository(mongoose.model<ApprovalDocument>('Approval', ApprovalSchema));
    const agentRunRepository = new MongooseAgentRunRepository(mongoose.model<AgentRunDocument>('AgentRun', AgentRunSchema));
    const toolRunnerService = new ToolRunnerService(connectorConfigRepository, toolRunnerSettings);
    const privilegedRefundRunner = new PrivilegedRefundRunner(toolRunnerService);
    const transactionRunner = new DevMongooseTransactionRunner();
    const approvalService = new ApprovalService(approvalRepository, privilegedRefundRunner, undefined, transactionRunner);

    const runId = generateDemoRunId();
    const conversationId = generateConversationId();

    const persistAgentRun: PersistAgentRunForProposal = async (disposition, session) => {
      const outcome: NewAgentRun['outcome'] = disposition.kind === 'denied' || disposition.kind === 'already_pending' ? 'escalate' : 'pending_approval';
      await agentRunRepository.create(
        {
          tenantId,
          runId,
          conversationId,
          outcome,
          stepCount: 0,
          llmCallCount: 0,
          tokensIn: 0,
          tokensOut: 0,
          latencyMs: 0,
          steps: [],
          proposedAction: { tool: 'issue_refund', orderId, amount: amountDollars },
          refundDisposition: disposition,
        },
        session,
      );
    };

    const input: CreateFromProposalInput = {
      tenantId,
      runId,
      conversationId,
      orderId,
      verifiedCustomerRef: customerRef,
      amountCents,
      citations: [chunkKey],
      orderSnapshot: snapshotResult.snapshot,
      // toTenant() (db/tenant.repository.ts) always fills every one of these from
      // DEMO_TENANT_SETTINGS when a stored tenant document predates the field - the `?? 0`/`?? false`
      // fallbacks here are never actually exercised, just satisfying the type without a non-null assertion.
      tenantSettings: {
        refundCap: tenant.refundCap ?? 0,
        approvalThreshold: tenant.approvalThreshold ?? 0,
        refundWindowDays: tenant.refundWindowDays ?? 0,
        autoExecuteRefunds: tenant.autoExecuteRefunds ?? false,
        ...(tenant.dailyRefundCountLimit !== undefined ? { dailyRefundCountLimit: tenant.dailyRefundCountLimit } : {}),
      },
      approvalExpiryDays: tenant.approvalExpiryDays ?? 7,
      now: new Date(),
    };

    const result = await approvalService.createFromProposal(input, persistAgentRun);

    // Deliberately minimal - only these three facts, nothing else.
    console.log(`approvalId: ${'approvalId' in result ? result.approvalId : '(none - denied before an Approval row was ever created)'}`);
    console.log(`disposition: ${result.kind}`);
    console.log(`failedRuleCodes: ${result.kind === 'denied' ? result.failedRuleCodes.join(', ') : '(none)'}`);
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((err: unknown) => {
  console.error('seed-demo-approval failed:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
