import { z } from 'zod';
import { idSchema } from './ids';
import { hasAtMostTwoDecimals, moneyAmountSchema, toCents } from './money';

export const GetOrderInputSchema = z.object({
  order_id: idSchema(),
});
export type GetOrderInput = z.infer<typeof GetOrderInputSchema>;

/**
 * Money fields are converted to integer CENTS right here - the boundary
 * where a tool's raw upstream response becomes GetOrderOutput, the shape
 * the rest of the agent (derived-facts.ts, validate-proposed-refund.ts)
 * consumes. Downstream code never re-does a dollars-to-cents conversion
 * for `total`/`alreadyRefundedTotal` - it already received cents.
 */
export const GetOrderOutputSchema = z.object({
  status: z.string(),
  total: moneyAmountSchema.transform(toCents),
  placedAt: z.string(),
  /** Absent for an order not yet delivered - mirrors the mock store's own `Order.deliveredAt?: string`. */
  deliveredAt: z.string().optional(),
  /**
   * Defaults to 0 (then still converted to cents) when a connector's
   * responseMap doesn't map this field at all - keeps every
   * already-committed connector fixture and test fixture that predates
   * this field validating unchanged, reading as "nothing refunded yet."
   */
  alreadyRefundedTotal: z
    .number()
    .nonnegative()
    .refine(hasAtMostTwoDecimals, 'amount must have at most two decimal places')
    .default(0)
    .transform(toCents),
  customerRef: idSchema(),
});
export type GetOrderOutput = z.infer<typeof GetOrderOutputSchema>;

export const TrackShipmentInputSchema = z.object({
  order_id: idSchema(),
});
export type TrackShipmentInput = z.infer<typeof TrackShipmentInputSchema>;

export const TrackShipmentOutputSchema = z.object({
  status: z.string(),
  trackingNumber: z.string(),
  carrier: z.string(),
  estimatedDelivery: z.string().optional(),
});
export type TrackShipmentOutput = z.infer<typeof TrackShipmentOutputSchema>;

export const IssueRefundInputSchema = z.object({
  order_id: idSchema(),
  amount: moneyAmountSchema,
  idempotencyKey: idSchema().optional(),
});
export type IssueRefundInput = z.infer<typeof IssueRefundInputSchema>;

export const IssueRefundOutputSchema = z.object({
  refundId: idSchema(),
  orderId: idSchema(),
  amount: moneyAmountSchema,
  status: z.literal('refunded'),
});
export type IssueRefundOutput = z.infer<typeof IssueRefundOutputSchema>;

export const EscalateToHumanInputSchema = z.object({
  summary: z.string().min(1).max(2000),
});
export type EscalateToHumanInput = z.infer<typeof EscalateToHumanInputSchema>;

export const EscalateToHumanOutputSchema = z.object({
  escalationId: idSchema(),
  status: z.literal('created'),
});
export type EscalateToHumanOutput = z.infer<typeof EscalateToHumanOutputSchema>;

/** Used to cross-validate a connector's request.body mapping at config-load time. */
export const TOOL_INPUT_SCHEMAS = {
  get_order: GetOrderInputSchema,
  track_shipment: TrackShipmentInputSchema,
  issue_refund: IssueRefundInputSchema,
  escalate_to_human: EscalateToHumanInputSchema,
} as const;
