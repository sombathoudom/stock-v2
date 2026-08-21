import { describe, expect, test } from "vitest";

import type { Id } from "@convex/_generated/dataModel";

import {
  availableForLine,
  lineBilledAfter,
  lineError,
  lineQty,
  lineSubtotal,
  projectAvailability,
  removedLineState,
  type EditLine,
} from "./sale-edit-items-table";

// The shared shelf projection + pending/persisted return state — pure
// functions, so they run without a browser or a Convex deployment. The
// regression this suite pins: the Available stock column and the quantity
// validation must read the SAME projection (one source), and a SAVED return
// is immutable history — never something Undo can bring back.
//
// Importers: the functions under test are exported from the edit-items-table
// component and imported by the edit page (sale-edit-form.tsx); this spec
// imports the same module and exercises only the pure helpers. No API
// signatures or data schemas change — EditLine/VariantAvailability are
// existing types. User instruction (verbatim): "Apply this consistently to:
// 1. client quantity validation 2. client projected-stock display 3. final
// Save summary 4. server aggregate-stock validation 5. server saveEdit
// behavior. … currentBilledQuantity = qtyOrdered - qtyCancelled - qtyReturned;
// positiveDelta = max(newDisplayedQuantity - currentBilledQuantity, 0) …
// maxDisplayedQuantity = currentBilledQuantity + stockAvailableForPositiveDeltas
// … 'Only 9 more available — maximum total quantity is 10.' Do not compare
// newDisplayedQuantity directly against stock, and do not use qtyDelivered as
// the maximum editable quantity. Add tests for partial returns and
// cancellations: ordered 3, cancelled 1 → current billed 2; ordered 3,
// returned 1 → current billed 2; increasing displayed 2 → 3 requires only 1
// stock; multiple lines of the same variant aggregate their positive deltas."
// (The earlier Undo/contradictory-stock suite 1-23 stays: its regression
// pins still hold under the delta-based rules.)

let seq = 0;
const variantId = "variant-tee-m" as Id<"productVariants">;
const line = (patch: Partial<EditLine>): EditLine => ({
  key: `k${(seq++).toString(36)}`,
  saleItemId: `saleitem-${seq}` as Id<"saleItems">,
  variantId,
  productName: "Basic Tee",
  variantLabel: "M",
  sku: "SH001-M",
  qty: "1",
  price: "6.00",
  discount: "",
  originalQty: 1,
  originalPrice: 600,
  originalDiscount: 0,
  qtyDelivered: 1,
  qtyReturned: 0,
  stock: 8,
  maxQty: 9,
  inputMax: 9,
  currentPrice: 600,
  removed: false,
  returnedOutcome: null,
  ...patch,
});

/** Project the whole line set with the given pending stock movements. */
function project(
  lines: EditLine[],
  returnIn: Record<string, number> = {},
  billCut: Record<string, number> = {}
) {
  return projectAvailability(
    lines,
    new Map(Object.entries(returnIn)),
    new Map(Object.entries(billCut))
  );
}

const afterOf = (
  lines: EditLine[],
  returnIn?: Record<string, number>,
  billCut?: Record<string, number>
) => {
  const v = project(lines, returnIn, billCut).get(variantId);
  expect(v).toBeDefined();
  return v!;
};

describe("projectAvailability — one shared source for the column and the validation", () => {
  test("1. an unchanged line leaves the shelf exactly where it is", () => {
    const l = line({ qty: "1" });
    const v = afterOf([l]);
    expect(v.shelf).toBe(8);
    expect(v.after).toBe(8);
  });

  test("2. a new line draws its qty from the shelf", () => {
    const l = line({ key: "n1", saleItemId: undefined, originalQty: 0, qty: "2" });
    const v = afterOf([l]);
    expect(v.after).toBe(6);
  });

  test("3. duplicate new lines share ONE variant projection (never the full shelf twice)", () => {
    const a = line({ key: "n1", saleItemId: undefined, originalQty: 0, qty: "2" });
    const b = line({ key: "n2", saleItemId: undefined, originalQty: 0, qty: "3" });
    const v = afterOf([a, b]);
    expect(v.after).toBe(3); // 8 − 2 − 3
  });

  test("4. removing an undelivered line returns its whole billed qty", () => {
    const l = line({ qty: "3", originalQty: 3, removed: true });
    const v = afterOf([l]);
    expect(v.after).toBe(11); // 8 + 3
  });

  test("5. lowering an undelivered line returns only the difference", () => {
    const l = line({ qty: "2", originalQty: 3 });
    const v = afterOf([l]);
    expect(v.after).toBe(9); // 8 + 1
  });

  test("6. raising an undelivered line draws only the extra", () => {
    const l = line({ qty: "5", originalQty: 3 });
    const v = afterOf([l]);
    expect(v.after).toBe(6); // 8 − 2
  });

  test("7. a pending sellable return adds its qty back (line fully resolved)", () => {
    // Delivered 1, fully returned — the resolution removed the line.
    const l = line({ qty: "0", originalQty: 1, qtyDelivered: 1, removed: true });
    const v = afterOf([l], { [l.key]: 1 }, { [l.key]: 1 });
    expect(v.after).toBe(9); // 8 + 1
  });

  test("8. a pending PARTIAL sellable return adds the returned piece only", () => {
    // Delivered 2, one held piece still billed: the returned piece flows
    // back into stock, the held one stays out: 8 + 1 = 9.
    const l = line({ qty: "1", originalQty: 2, qtyDelivered: 2 });
    const v = afterOf([l], { [l.key]: 1 }, { [l.key]: 1 });
    expect(v.after).toBe(9); // 8 + returned 1; the held piece stays out
  });

  test("9. a pending damaged return adds NOTHING (return nets to zero)", () => {
    const l = line({ qty: "0", originalQty: 1, qtyDelivered: 1, removed: true });
    const v = afterOf([l], {}, { [l.key]: 1 });
    expect(v.after).toBe(8);
  });

  test("10. a PERSISTED return is already in the stock and adds nothing again", () => {
    // The saved-return row from the reported bug: it bills nothing and the
    // ledger already returned its piece (stock reads 8 here as the CURRENT
    // shelf — the returned piece is inside it).
    const l = line({
      qty: "0",
      originalQty: 0,
      qtyDelivered: 1,
      qtyReturned: 1,
      stock: 8,
      removed: true,
      returnedOutcome: "sellable",
    });
    const v = afterOf([l]);
    expect(v.shelf).toBe(8);
    expect(v.after).toBe(8); // never 9 — no double count
  });

  test("11. a persisted returned line contributes ZERO to the requested qty", () => {
    const persisted = line({
      qty: "0",
      originalQty: 0,
      qtyDelivered: 1,
      qtyReturned: 1,
      removed: true,
      returnedOutcome: "sellable",
    });
    const newLine = line({ key: "n1", saleItemId: undefined, originalQty: 0, qty: "2" });
    const v = afterOf([persisted, newLine]);
    expect(v.after).toBe(6); // 8 − 2, the history line asks for nothing
  });
});

describe("availableForLine — what THIS line can still draw", () => {
  test("12. includes its own pending qty (the projection excludes it)", () => {
    const l = line({ qty: "5", originalQty: 3 });
    const v = project([l]).get(variantId)!;
    expect(v.after).toBe(6);
    expect(availableForLine(l, project([l]))).toBe(11); // 6 + 5
  });

  test("13. clamps at zero — an oversold projection never shows negative", () => {
    const l = line({ qty: "9", originalQty: 1 });
    const v = project([l]).get(variantId)!;
    expect(v.after).toBe(0);
    expect(availableForLine(l, project([l]))).toBe(9);
  });

  test("14. falls back to the input cap when no projection exists", () => {
    const l = line({ inputMax: 4 });
    expect(availableForLine(l, new Map())).toBe(4);
  });
});

describe("lineError — validation reads the SAME projection the column shows", () => {
  test("15. qty within the projection → no error, even near the cap", () => {
    const l = line({ qty: "8" });
    expect(lineError(l, 0, project([l]))).toBeNull();
  });

  test("16. the reported bug: 8 available can never say 'Only 0 available'", () => {
    // A persisted returned line (billed 0) beside a healthy shelf of 8 —
    // the pre-fix code checked a stale input cap and showed the contradiction.
    const persisted = line({
      qty: "0",
      originalQty: 0,
      qtyDelivered: 1,
      qtyReturned: 1,
      removed: true,
      returnedOutcome: "sellable",
    });
    expect(lineError(persisted, 0, project([persisted]))).toBeNull();
    const healthy = line({ key: "h1", qty: "1" });
    expect(lineError(healthy, 0, project([persisted, healthy]))).toBeNull();
  });

  test("17. exceeding the shared projection names the real available count", () => {
    // Undelivered line billed 1 raised to 10: draws 9, shelf holds 8 —
    // max legal qty = billed 1 + shelf 8 = 9.
    const l = line({ qty: "10", originalQty: 1, qtyDelivered: 0 });
    const err = lineError(l, 0, project([l]));
    expect(err).not.toBeNull();
    expect(err).toContain("9"); // "Only 9 available." — the projection's own number
  });

  test("18. a duplicate line sees the shelf MINUS the other line's request", () => {
    // a draws 5 (6 − billed 1), b draws 4 (5 − billed 1): 9 > shelf 8 —
    // b's max = billed 1 + remaining 3 = 4.
    const a = line({ key: "a", qty: "6" });
    const b = line({ key: "b", qty: "5" });
    const err = lineError(b, 0, project([a, b]));
    expect(err).not.toBeNull();
    expect(err).toContain("4"); // 8 − a's 5 + b's billed 1
  });

  test("19. without a projection the floor check still holds (inputMax fallback)", () => {
    const l = line({ qty: "1", qtyDelivered: 2, qtyReturned: 0 });
    expect(lineError(l)).not.toBeNull(); // below held
  });
});

describe("removedLineState — pending vs persisted, derived not styled", () => {
  const persisted = (outcome: "sellable" | "damaged") =>
    line({
      qty: "0",
      originalQty: 0,
      qtyDelivered: 1,
      qtyReturned: 1,
      removed: true,
      returnedOutcome: outcome,
    });
  // The pending outcome is passed to removedLineState separately (as the
  // component does with pending?.outcome), not baked into the line.
  const pending = () =>
    line({ qty: "0", originalQty: 1, qtyDelivered: 1, removed: true });
  const plainRemoved = () =>
    line({ qty: "0", originalQty: 1, removed: true });

  test("20. a persisted return is READONLY — no Undo, never restored, even with a pending outcome", () => {
    // History wins: a pending outcome can't re-open a SAVED return.
    expect(removedLineState(persisted("sellable"))).toBe("readonly");
    expect(removedLineState(persisted("sellable"), "sellable")).toBe("readonly");
    expect(removedLineState(persisted("damaged"))).toBe("readonly");
    expect(removedLineState(persisted("damaged"), "incorrect")).toBe("readonly");
  });

  test("21. a pending return offers undo-resolution — the only undoable state", () => {
    expect(removedLineState(pending(), "sellable")).toBe("undo-resolution");
    expect(removedLineState(pending(), "damaged")).toBe("undo-resolution");
    expect(removedLineState(pending(), "incorrect")).toBe("undo-resolution");
  });

  test("22. plain cancelled-history lines are always undoable — no delivered lock", () => {
    // The delivered flag is gone: a raise is legal on a delivered order, so
    // nothing about delivery status can lock a removed line either.
    expect(removedLineState(plainRemoved())).toBe("undo");
    expect(removedLineState(plainRemoved(), "sellable")).toBe("undo-resolution");
  });

  test("23. lineQty parses whole quantities only", () => {
    expect(lineQty(line({ qty: "3" }))).toBe(3);
    expect(lineQty(line({ qty: "" }))).toBeNull();
    expect(lineQty(line({ qty: "1.5" }))).toBeNull();
  });
});

describe("delta-based raises — the billed baseline, never the shelf, is the measuring point", () => {
  // The user's spec: currentBilledQuantity = qtyOrdered − qtyCancelled −
  // qtyReturned (the server sends it as billedQty → line.originalQty);
  // positiveDelta = max(displayed − currentBilled, 0); the max is
  // billed + shelf, and the qty is NEVER compared directly against stock.
  test("24. ordered 3, cancelled 1 → billed baseline 2; ordered 3, returned 1 → billed 2", () => {
    // The client receives the server's billedQty (already reduced) as
    // originalQty — so both partial histories land on the same baseline.
    const cancelled = line({ originalQty: 2 });
    const returned = line({ originalQty: 2 });
    expect(lineBilledAfter(cancelled)).toBe(2);
    expect(lineBilledAfter(returned)).toBe(2);
  });

  test("25. a pending return shrinks the billed baseline by its pieces", () => {
    const l = line({ originalQty: 2 });
    expect(lineBilledAfter(l, 1)).toBe(1);
    expect(lineBilledAfter(l, 3)).toBe(0); // never negative
  });

  test("26. raising displayed 2 → 3 requires only 1 from the shelf", () => {
    // Shelf 3, billed 2: max = 2 + 3 = 5. The raise to 4 (delta 2 ≤ 3) is
    // legal even though 4 > 3 — direct qty-vs-stock comparison is banned.
    const ok = line({ qty: "4", originalQty: 2, stock: 3, maxQty: 5, qtyDelivered: 0 });
    expect(lineError(ok, 0, project([ok]))).toBeNull();
    // Delta 4 > 3 → rejected, naming the real numbers.
    const bad = line({ qty: "6", originalQty: 2, stock: 3, maxQty: 5, qtyDelivered: 0 });
    const err = lineError(bad, 0, project([bad]));
    expect(err).not.toBeNull();
    expect(err).toContain("Only 3 more available");
    expect(err).toContain("maximum total quantity is 5");
  });

  test("27. the user's example: billed 1, shelf 9 → max 10, 'Only 9 more available'", () => {
    const l = line({ qty: "11", originalQty: 1, stock: 9, maxQty: 10, qtyDelivered: 0 });
    const err = lineError(l, 0, project([l]));
    expect(err).not.toBeNull();
    expect(err).toContain("Only 9 more available — maximum total quantity is 10");
    const atMax = line({ qty: "10", originalQty: 1, stock: 9, maxQty: 10, qtyDelivered: 0 });
    expect(lineError(atMax, 0, project([atMax]))).toBeNull();
  });

  test("28. multiple lines of one variant share the shelf — deltas aggregate", () => {
    // Shelf 8: a's raise draws 5, b's would draw 5 more → 10 > 8. Each
    // delta alone fits; together they don't, and b is told the real max.
    const a = line({ key: "a", qty: "6", originalQty: 1, qtyDelivered: 0 });
    const b = line({ key: "b", qty: "6", originalQty: 1, qtyDelivered: 0 });
    const err = lineError(b, 0, project([a, b]));
    expect(err).not.toBeNull();
    // b's max = billed 1 + 3 remaining on the shelf = 4; the message's
    // {qty} is the DELTA still allowed (3), its {max} the absolute ceiling.
    expect(err).toContain("Only 3 more available");
    expect(err).toContain("maximum total quantity is 4");
    // Drop b back to qty 4 (delta 3 ≤ 3 left) → both lines legal.
    const b2 = { ...b, qty: "4" };
    expect(lineError(a, 0, project([a, b2]))).toBeNull();
    expect(lineError(b2, 0, project([a, b2]))).toBeNull();
  });
});

describe("lineSubtotal — a raise's extra pieces are priced at today's price", () => {
  // Mirrors saveEdit: billed pieces keep the line's own price and discount;
  // the raised delta bills at the variant's CURRENT price. The number shown
  // and the number enforced on save can never disagree.
  test("29. raised pieces leave the line's price and take currentPrice", () => {
    // Billed 1 at $5.00, raised 2 at today's $6.00 → 500 + 1200 = 1700.
    const l = line({ qty: "3", originalQty: 1, price: "5.00", currentPrice: 600, qtyDelivered: 0 });
    expect(lineSubtotal(l)).toBe(1700);
  });

  test("30. billCut drops the billed baseline — more of the qty becomes a raise", () => {
    // Billed 2, one piece returns (billCut 1) → billed 1 at $5 + 2 at $6.
    const l = line({ qty: "3", originalQty: 2, price: "5.00", currentPrice: 600, qtyDelivered: 0 });
    expect(lineSubtotal(l, 1)).toBe(1700);
    // No billCut: 2 billed at $5 + 1 raised at $6 = 1600.
    expect(lineSubtotal(l)).toBe(1600);
  });

  test("31. discount applies to the billed pieces only — the server bills it that way", () => {
    const l = line({ qty: "1", originalQty: 1, price: "5.00", discount: "1.00" });
    expect(lineSubtotal(l)).toBe(400);
  });
});
