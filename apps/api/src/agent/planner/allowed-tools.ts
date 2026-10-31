import { ConnectorConfig } from '@supportpilot/shared';

/** The only tools PlannerToolRequestSchema (packages/shared/src/agent-schemas.ts) can even express - kept here as the single source of truth for "tools the planner's allow-list is built from." */
export const PLANNER_ELIGIBLE_TOOLS = ['get_order', 'track_shipment'] as const;
export type PlannerEligibleTool = (typeof PLANNER_ELIGIBLE_TOOLS)[number];

/**
 * The tools a tenant's planner call is allowed to request: its configured
 * connectors, intersected with the read-only/riskLevel-low set - BOTH
 * conditions, not either. A connector whose `tool` happens to be
 * `issue_refund` or `escalate_to_human` is never eligible regardless of
 * its riskLevel (they're simply not in PLANNER_ELIGIBLE_TOOLS at all,
 * structurally excluded - the planner never even has an args shape for
 * them, see PlannerToolRequestSchema). And a connector for an eligible
 * tool (`get_order`/`track_shipment`) that a tenant has misconfigured as
 * `riskLevel: "high"` is ALSO excluded - the risk gate wins over the tool
 * name, so a bad tenant config can only ever narrow the planner's allow-list,
 * never widen it into a high-risk tool.
 *
 * A tenant that never configured a given tool (e.g. no get_order
 * connector at all) simply never has it in `configs` - there's nothing
 * special to check, the intersection already excludes it.
 */
export function allowedPlannerTools(configs: ConnectorConfig[]): Set<PlannerEligibleTool> {
  const eligible: ReadonlySet<string> = new Set(PLANNER_ELIGIBLE_TOOLS);
  const allowed = new Set<PlannerEligibleTool>();
  for (const config of configs) {
    if (config.riskLevel === 'low' && eligible.has(config.tool)) {
      allowed.add(config.tool as PlannerEligibleTool);
    }
  }
  return allowed;
}
