// Pure UI projection for the Sale Detail item list — groups saleItems that
// share a variantId for readability WITHOUT touching the database, the
// totals, or the Edit Sale page (lines stay separate everywhere else).
//
// Derived display quantities (AGENTS.md invariants 5–6):
//   withCustomer     = qtyDelivered − qtyReturned
//   awaitingDelivery = qtyOrdered − qtyCancelled − qtyDelivered
//   activeBilled     = qtyOrdered − qtyCancelled − qtyReturned
// A displayed derived quantity is never negative: invalid source data
// surfaces an integrity warning instead of a silent clamp.

export type LineSource = {
  saleItemId: string;
  variantId: string;
  productName: string;
  variantLabel: string; // "2XL" or "M · Black"
  sku?: string;
  imageStorageId?: string;
  unitPrice: number; // integer cents
  discount?: number; // integer cents, per line
  qtyOrdered: number;
  qtyDelivered: number;
  qtyCancelled: number;
  qtyReturned: number;
};

/** Which derived quantity went below zero, for the integrity warning. */
export type IntegrityIssue = {
  code:
    | "with_customer_below_zero"
    | "awaiting_below_zero"
    | "active_billed_below_zero";
  lineSaleItemId: string;
  raw: number;
};

export type LineProjection = {
  line: LineSource;
  withCustomer: number; // displayed, never negative
  awaitingDelivery: number; // displayed, never negative
  activeBilled: number; // displayed, never negative
  subtotal: number; // unitPrice × activeBilled − discount
};

export type SaleItemGroup = {
  variantId: string;
  productName: string;
  variantLabel: string;
  sku?: string;
  imageStorageId?: string;
  lines: LineProjection[];
  /** The shared unit price when every line agrees on price AND discount,
   * null when they differ (UI shows "Multiple prices"). */
  unitPrice: number | null;
  multiplePrices: boolean;
  ordered: number;
  cancelled: number;
  returned: number;
  delivered: number;
  withCustomer: number;
  awaitingDelivery: number;
  activeBilled: number;
  subtotal: number;
  integrity: IntegrityIssue[];
};

/** Per-line derived quantities with the below-zero guard. */
export function projectLine(line: LineSource): LineProjection {
  const withCustomer = line.qtyDelivered - line.qtyReturned;
  const awaitingDelivery = line.qtyOrdered - line.qtyCancelled - line.qtyDelivered;
  const activeBilled = line.qtyOrdered - line.qtyCancelled - line.qtyReturned;
  return {
    line,
    withCustomer: Math.max(0, withCustomer),
    awaitingDelivery: Math.max(0, awaitingDelivery),
    activeBilled: Math.max(0, activeBilled),
    subtotal: line.unitPrice * Math.max(0, activeBilled) - (line.discount ?? 0),
  };
}

/** Group the detail page's lines by variantId, preserving line order.
 * Group totals are EXACTLY the sum of the underlying lines' displayed
 * values — a group can never disagree with its own lines. */
export function groupSaleItems(items: LineSource[]): SaleItemGroup[] {
  const byVariant = new Map<string, SaleItemGroup>();
  for (const item of items) {
    let group = byVariant.get(item.variantId);
    if (!group) {
      group = {
        variantId: item.variantId,
        productName: item.productName,
        variantLabel: item.variantLabel,
        sku: item.sku,
        imageStorageId: item.imageStorageId,
        lines: [],
        unitPrice: item.unitPrice,
        multiplePrices: false,
        ordered: 0,
        cancelled: 0,
        returned: 0,
        delivered: 0,
        withCustomer: 0,
        awaitingDelivery: 0,
        activeBilled: 0,
        subtotal: 0,
        integrity: [],
      };
      byVariant.set(item.variantId, group);
    }
    const projected = projectLine(item);
    group.lines.push(projected);
    group.ordered += item.qtyOrdered;
    group.cancelled += item.qtyCancelled;
    group.returned += item.qtyReturned;
    group.delivered += item.qtyDelivered;
    group.withCustomer += projected.withCustomer;
    group.awaitingDelivery += projected.awaitingDelivery;
    group.activeBilled += projected.activeBilled;
    group.subtotal += projected.subtotal;
    for (const issue of integrityIssuesOf(item)) {
      group.integrity.push(issue);
    }
  }
  for (const group of byVariant.values()) {
    // "Multiple prices" when the lines don't agree on price or carry
    // different per-line discounts — only the summed group total is shown.
    const first = group.lines[0]?.line;
    group.multiplePrices =
      first == null ||
      group.lines.some(
        (l) =>
          l.line.unitPrice !== first.unitPrice ||
          (l.line.discount ?? 0) !== (first.discount ?? 0)
      );
    group.unitPrice = group.multiplePrices ? null : first.unitPrice;
  }
  return [...byVariant.values()];
}

function integrityIssuesOf(line: LineSource): IntegrityIssue[] {
  const issues: IntegrityIssue[] = [];
  const withCustomer = line.qtyDelivered - line.qtyReturned;
  const awaitingDelivery = line.qtyOrdered - line.qtyCancelled - line.qtyDelivered;
  const activeBilled = line.qtyOrdered - line.qtyCancelled - line.qtyReturned;
  if (withCustomer < 0)
    issues.push({
      code: "with_customer_below_zero",
      lineSaleItemId: line.saleItemId,
      raw: withCustomer,
    });
  if (awaitingDelivery < 0)
    issues.push({
      code: "awaiting_below_zero",
      lineSaleItemId: line.saleItemId,
      raw: awaitingDelivery,
    });
  if (activeBilled < 0)
    issues.push({
      code: "active_billed_below_zero",
      lineSaleItemId: line.saleItemId,
      raw: activeBilled,
    });
  return issues;
}
