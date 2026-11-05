import { runTool, RunToolParams, ToolRunResult } from '../tool-runner/tool-runner';

export type ReadOnlyToolRunnerDeps = Omit<RunToolParams, 'tenantId' | 'toolName' | 'args'>;

/**
 * Defense in depth, independent of allowed-tools.ts's allow-list (which
 * keeps high-risk tools out of what the MODEL can even request in the
 * first place). This wrapper is the last line of defense in the actual
 * EXECUTION path: it looks up the connector's own riskLevel itself,
 * BEFORE ever calling the real runTool(), and refuses outright - never
 * sending a single upstream request - for anything that isn't
 * `riskLevel: "low"`. Even if every upstream check were somehow bypassed
 * (a bug in the planner's allow-list, a compose step that fabricates a
 * tool request, a test double standing in for the model), `issue_refund`
 * and any other high-risk tool are structurally unreachable through this
 * runner. PROJECT.md's one hard Milestone-3 rule: "the loop can never
 * execute a riskLevel: 'high' tool itself."
 */
export class ReadOnlyToolRunner {
  constructor(private readonly deps: ReadOnlyToolRunnerDeps) {}

  async run(tenantId: string, toolName: string, args: Record<string, unknown>): Promise<ToolRunResult> {
    let riskLevel: 'low' | 'high';
    try {
      riskLevel = this.deps.repository.findByTool(tenantId, toolName).riskLevel;
    } catch {
      return { ok: false, error: { code: 'CONFIG_ERROR', message: 'Connector is not configured correctly.' } };
    }

    if (riskLevel !== 'low') {
      return { ok: false, error: { code: 'BLOCKED_BY_POLICY', message: 'Request was blocked by security policy.' } };
    }

    return runTool({ tenantId, toolName, args, ...this.deps });
  }
}
