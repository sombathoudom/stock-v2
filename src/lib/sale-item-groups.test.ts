import { describe, expect, test } from "vitest";

import {
  groupSaleItems,
  projectLine,
  type LineSource,
} from "./sale-item-groups";

// UI projection tests: group totals must EXACTLY equal the sum of the
// underlying saleItems, per the spec's formulas:
//   withCustomer     = qtyDelivered − qtyReturned
//   awaitingDelivery = qtyOrdered − qtyCancelled − qtyDelivered
//   activeBilled     = qtyOrdered − qtyCancelled − qtyReturned
// Never below zero; invalid source data → integrity warning, not a silent
// clamp.

const tee = (patch: Partial<LineSource>): LineSource => ({
  saleItemId: `line-${Math.random()}`,
  variantId: "v-tee-2xl",
  productName: "Shirt 002",
  variantLabel: "2XL",
  sku: "SH002-2XL",
  unitPrice: 600,
  qtyOrdered: 1,
  qtyDelivered: 0,
  qtyCancelled: 0,
  qtyReturned: 0,
  ...patch,
});

describe("projectLine", () => {
  test("derives the spec's three display quantities", () => {
    // Ordered 3, delivered 0, cancelled 2 → awaiting 1, active billed 1.
    const p = projectLine(
      tee({ qtyOrdered: 3, qtyDelivered: 0, qtyCancelled: 2, qtyReturned: 0 })
    );
    expect(p.awaitingDelivery).toBe(1);
    expect(p.activeBilled).toBe(1);
    expect(p.withCustomer).toBe(0);
    // Delivered 1, returned 1 → held 0 (historical delivered is kept).
    const returned = projectLine(
      tee({ qtyOrdered: 1, qtyDelivered: 1, qtyReturned: 1 })
    );
    expect(returned.withCustomer).toBe(0);
    expect(returned.activeBilled).toBe(0);
  });

  test("invalid source data surfaces an integrity warning instead of clamping", () => {
    // Delivered more than ordered → awaiting would be negative.
    const p = projectLine(
      tee({ qtyOrdered: 1, qtyDelivered: 3, qtyCancelled: 0, qtyReturned: 0 })
    );
    expect(p.awaitingDelivery).toBe(0); // displayed never negative
    const group = groupSaleItems([
      tee({ saleItemId: "l1", qtyOrdered: 1, qtyDelivered: 3 }),
    ]);
    expect(group[0].integrity.map((i) => i.code)).toContain(
      "awaiting_below_zero"
    );
    expect(group[0].integrity[0].raw).toBe(-2);
  });

  test("subtotal is unitPrice × activeBilled − discount", () => {
    const p = projectLine(
      tee({
        qtyOrdered: 3,
        qtyCancelled: 2,
        unitPrice: 600,
        discount: 100,
      })
    );
    expect(p.subtotal).toBe(600 * 1 - 100);
  });
});

describe("groupSaleItems — the reported order example", () => {
  test("group totals equal the sum of the underlying lines", () => {
    const groups = groupSaleItems([
      // Line 1: ordered 3, cancelled 2, active 1, $6
      tee({
        saleItemId: "l1",
        qtyOrdered: 3,
        qtyCancelled: 2,
        unitPrice: 600,
      }),
      // Line 2: ordered 2, active 2, $12
      tee({ saleItemId: "l2", qtyOrdered: 2, unitPrice: 600 }),
    ]);

    expect(groups).toHaveLength(1); // same variantId → one group
    const g = groups[0];
    expect(g.lines).toHaveLength(2); // lines stay separate underneath
    expect(g.ordered).toBe(5);
    expect(g.cancelled).toBe(2);
    expect(g.awaitingDelivery).toBe(3); // 1 + 2
    expect(g.withCustomer).toBe(0);
    expect(g.returned).toBe(0);
    expect(g.activeBilled).toBe(3);
    expect(g.subtotal).toBe(1800); // $18
    expect(g.unitPrice).toBe(600);
    expect(g.multiplePrices).toBe(false);

    // Exact-equality invariant: group == Σ lines, field by field.
    expect(g.ordered).toBe(g.lines.reduce((s, l) => s + l.line.qtyOrdered, 0));
    expect(g.cancelled).toBe(
      g.lines.reduce((s, l) => s + l.line.qtyCancelled, 0)
    );
    expect(g.awaitingDelivery).toBe(
      g.lines.reduce((s, l) => s + l.awaitingDelivery, 0)
    );
    expect(g.withCustomer).toBe(
      g.lines.reduce((s, l) => s + l.withCustomer, 0)
    );
    expect(g.subtotal).toBe(g.lines.reduce((s, l) => s + l.subtotal, 0));
  });

  test("different variants stay separate groups", () => {
    const groups = groupSaleItems([
      tee({ saleItemId: "l1", variantId: "v-tee-2xl" }),
      tee({ saleItemId: "l2", variantId: "v-tee-xl", variantLabel: "XL" }),
    ]);
    expect(groups).toHaveLength(2);
  });

  test("differing unit prices show Multiple prices with the summed total", () => {
    const groups = groupSaleItems([
      tee({ saleItemId: "l1", qtyOrdered: 1, unitPrice: 600 }),
      tee({ saleItemId: "l2", qtyOrdered: 1, unitPrice: 700 }),
    ]);
    const g = groups[0];
    expect(g.multiplePrices).toBe(true);
    expect(g.unitPrice).toBeNull();
    expect(g.subtotal).toBe(1300); // only the summed total is shown
  });

  test("differing per-line discounts also mean Multiple prices", () => {
    const groups = groupSaleItems([
      tee({ saleItemId: "l1", qtyOrdered: 1, unitPrice: 600, discount: 0 }),
      tee({ saleItemId: "l2", qtyOrdered: 1, unitPrice: 600, discount: 100 }),
    ]);
    const g = groups[0];
    expect(g.multiplePrices).toBe(true);
    expect(g.unitPrice).toBeNull();
    expect(g.subtotal).toBe(600 + 600 - 100);
  });

  test("matching discounts keep a single price", () => {
    const groups = groupSaleItems([
      tee({ saleItemId: "l1", qtyOrdered: 1, unitPrice: 600, discount: 100 }),
      tee({ saleItemId: "l2", qtyOrdered: 1, unitPrice: 600, discount: 100 }),
    ]);
    expect(groups[0].multiplePrices).toBe(false);
    expect(groups[0].unitPrice).toBe(600);
    expect(groups[0].subtotal).toBe(2 * 600 - 2 * 100);
  });
});
