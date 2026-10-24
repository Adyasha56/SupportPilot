import { z } from 'zod';
import { idSchema } from './ids';
import { hasAtMostTwoDecimals } from './money';

const moneyAmountSchema = z
  .number()
  .positive()
  .refine(hasAtMostTwoDecimals, 'amount must have at most two decimal places');

export const GetOrderInputSchema = z.object({
  order_id: idSchema(),
});
export type GetOrderInput = z.infer<typeof GetOrderInputSchema>;

export const GetOrderOutputSchema = z.object({
  status: z.string(),
  total: moneyAmountSchema,
  placedAt: z.string(),
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
