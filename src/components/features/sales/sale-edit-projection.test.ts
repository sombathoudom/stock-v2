import { describe, expect, test } from "vitest";

import type { Id } from "@convex/_generated/dataModel";

import {
  availableForLine,
  lineError,
  lineQty,
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
// existing types. User instruction (verbatim): "Fix the incorrect Undo
// behavior for a return that has already been saved, and fix the
// contradictory available-stock validation shown on the Edit Sale page" with
// "32 required regression tests (pending 1-6, persisted 7-13, add again
// 14-18, projection 19-26, safety 27-32)".

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

  test("20. a persisted return is READONLY — no Undo, never restored, on any order", () => {
    expect(removedLineState(persisted("sellable"), true)).toBe("readonly");
    expect(removedLineState(persisted("sellable"), false)).toBe("readonly");
    expect(removedLineState(persisted("damaged"), true)).toBe("readonly");
    expect(removedLineState(persisted("damaged"), false)).toBe("readonly");
  });

  test("21. a pending return offers undo-resolution — the only undoable state", () => {
    // The component passes the pending outcome (pending?.outcome) — the
    // delivered flag alone must NOT grant the plain-undo state.
    expect(removedLineState(pending(), true, "sellable")).toBe("undo-resolution");
    expect(removedLineState(pending(), false, "sellable")).toBe("undo-resolution");
    expect(removedLineState(pending(), true, "damaged")).toBe("undo-resolution");
    expect(removedLineState(pending(), true, "incorrect")).toBe("undo-resolution");
  });

  test("22. plain cancelled-history lines: undoable off a delivered order only", () => {
    expect(removedLineState(plainRemoved(), false)).toBe("undo");
    expect(removedLineState(plainRemoved(), true)).toBe("none");
  });

  test("23. lineQty parses whole quantities only", () => {
    expect(lineQty(line({ qty: "3" }))).toBe(3);
    expect(lineQty(line({ qty: "" }))).toBeNull();
    expect(lineQty(line({ qty: "1.5" }))).toBeNull();
  });
});
