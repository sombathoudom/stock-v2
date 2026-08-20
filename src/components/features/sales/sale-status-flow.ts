import type { Doc } from "@convex/_generated/dataModel";

import { t } from "@/lib/utils";

// Shared order-status flow rules — used by the order detail page and the
// sales-list "Update status" action. The server enforces the same map
// (convex/sales.ts ALLOWED_TRANSITIONS); the UI only offers what the server
// will accept.

export type SaleStatus = Doc<"sales">["status"];

/** Status steps offered per current status (mirrors the server's
 * ALLOWED_TRANSITIONS). Stages may be SKIPPED forward — a self-delivered order
 * never needs a "delivering" stage — but a finished delivery never re-opens:
 * "delivered" only falls back to "partially_delivered" (a mistaken mark at the
 * door), never back to "delivering". "pending" is the one true regression:
 * reachable only from confirmed ("wait before processing"), and from pending
 * ANY later stage is offered, including back to confirmed. */
export const NEXT_STEPS: Record<SaleStatus, SaleStatus[]> = {
  // Drafts offer nothing: confirming one has to deduct stock too, which the
  // status mutation doesn't do (and checkout never writes a draft anyway).
  draft: [],
  pending: ["confirmed", "packed", "delivering", "delivered", "partially_delivered"],
  confirmed: ["pending", "packed", "delivering", "delivered", "partially_delivered"],
  packed: ["delivering", "delivered", "partially_delivered"],
  delivering: ["delivered", "partially_delivered"],
  delivered: ["partially_delivered"],
  partially_delivered: ["delivered", "delivering"],
  cancelled: [],
};

/** Every delivery stage the "Update status" dialog lists, in shop order. The
 * dialog shows them ALL so the owner sees where the order sits in the whole
 * journey; NEXT_STEPS decides which ones are actually pickable. "draft" is
 * internal and "cancelled" has its own action, so neither is listed. */
export const ALL_STATUSES: SaleStatus[] = [
  "pending",
  "confirmed",
  "packed",
  "delivering",
  "partially_delivered",
  "delivered",
];

/** Orders with stock already out — cancelling flows unsold pieces back.
 * Pending orders are stock-out too (reserved at checkout). */
export const CAN_CANCEL: SaleStatus[] = [
  "confirmed",
  "pending",
  "packed",
  "delivering",
  "partially_delivered",
];

/** Action label for a forward step ("Mark packed" vs the plain status word). */
export function markLabel(status: SaleStatus): string {
  switch (status) {
    case "pending":
      return t().sales.markPending;
    case "packed":
      return t().sales.markPacked;
    case "delivering":
      return t().sales.markDelivering;
    case "delivered":
      return t().sales.markDelivered;
    case "partially_delivered":
      return t().sales.markPartiallyDelivered;
    default:
      return t().status[status];
  }
}
