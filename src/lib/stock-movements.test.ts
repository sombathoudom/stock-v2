import { describe, expect, test } from "vitest";

import {
  beforeOf,
  chainOrder,
  chronological,
  isExpandable,
  flowContinuity,
  groupMovements,
  integrityMismatch,
  netDisplay,
  newestFirst,
  referenceHref,
  summaryCards,
  summaryIsConsistent,
  visibleUnitCost,
  type MovementRow,
} from "./stock-movements";

// The 14 required scenarios for the per-variant movement viewer.

let seq = 0;
const row = (
  patch: Partial<MovementRow> & { delta: number; balance: number }
): MovementRow => ({
  _id: `l${(seq++).toString(36)}`,
  ts: 1000,
  reason: "purchase",
  userName: "Owner",
  ...patch,
});

const ORDER_REF = {
  kind: "order" as const,
  code: "20260821-005",
  saleId: "sale-abc",
  customerName: "Walk-in Customer",
  channelName: "Walk-in",
};
const OTHER_REF = {
  kind: "order" as const,
  code: "20260821-006",
  saleId: "sale-other",
  customerName: "Dara",
  channelName: "Facebook",
};
const PO_REF = {
  kind: "po" as const,
  code: "PO-SEED-001",
  purchaseId: "po-xyz",
  supplierName: "Test Supplier",
  unitCost: 214,
};

describe("running balances (spec examples)", () => {
  test("1. purchase +10 displays 0 → 10", () => {
    const r = row({ delta: 10, balance: 10 });
    expect(beforeOf(r)).toBe(0);
    expect(r.balance).toBe(10);
  });

  test("2. sale -2 displays 10 → 8", () => {
    const r = row({ delta: -2, balance: 8, reason: "sale" });
    expect(beforeOf(r)).toBe(10);
    expect(r.balance).toBe(8);
  });

  test("3. cancel +1 displays 8 → 9", () => {
    const r = row({ delta: 1, balance: 9, reason: "cancel" });
    expect(beforeOf(r)).toBe(8);
    expect(r.balance).toBe(9);
  });

  test("4. return +1 displays the correct balance", () => {
    const r = row({ delta: 1, balance: 9, reason: "return" });
    expect(beforeOf(r)).toBe(8);
    expect(r.balance).toBe(9);
  });

  test("5. damaged return +1/-1: group net zero, both rows inspectable", () => {
    const groups = groupMovements([
      row({
        delta: 1,
        balance: 9,
        reason: "return",
        reference: ORDER_REF,
      }),
      row({
        delta: -1,
        balance: 8,
        reason: "adjustment",
        reference: ORDER_REF,
        note: "Damaged — removed from sellable stock (20260821-005)",
      }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].net).toBe(0);
    expect(groups[0].rows).toHaveLength(2); // both events remain inspectable
    expect(groups[0].reasons).toEqual(["return", "adjustment"]);
    expect(groups[0].opening).toBe(8);
    expect(groups[0].closing).toBe(8);
  });

  test("6. duplicate same-variant sale lines group correctly", () => {
    const groups = groupMovements([
      row({ delta: -1, balance: 9, reason: "sale", reference: ORDER_REF }),
      row({ delta: -1, balance: 8, reason: "sale", reference: ORDER_REF }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].net).toBe(-2);
    expect(groups[0].rows).toHaveLength(2);
    expect(groups[0].opening).toBe(10);
    expect(groups[0].closing).toBe(8);
  });
});

describe("grouping and summaries", () => {
  test("7. opening balance with a date-range filter comes from beforeOf", () => {
    // Three DISTINCT operations on one order (purchase, sale, cancel at
    // different times) — each is its own atomic group now.
    const groups = groupMovements([
      row({ delta: 10, balance: 10, ts: 100 }),
      row({
        delta: -2,
        balance: 8,
        ts: 200,
        reason: "sale",
        reference: ORDER_REF,
      }),
      row({
        delta: 1,
        balance: 9,
        ts: 300,
        reason: "cancel",
        reference: ORDER_REF,
      }),
    ]);
    expect(groups).toHaveLength(3);
    const saleOp = groups.find((g) => g.ts === 200)!;
    expect(saleOp.opening).toBe(10); // balance before the range's first row
    expect(saleOp.closing).toBe(8);
    const cancelOp = groups.find((g) => g.ts === 300)!;
    expect(cancelOp.opening).toBe(8);
    expect(cancelOp.closing).toBe(9);
  });

  test("8. newest-first display keeps true chronological balances", () => {
    const rows = [
      row({ delta: 10, balance: 10, ts: 100 }),
      row({ delta: -2, balance: 8, ts: 200, reason: "sale" }),
      row({ delta: 1, balance: 9, ts: 300, reason: "cancel" }),
    ];
    const displayed = newestFirst(rows);
    expect(displayed.map((r) => r.ts)).toEqual([300, 200, 100]);
    // before/after still chronological truth, not display order.
    expect(beforeOf(displayed[0])).toBe(8); // the newest cancel: 8 → 9
    expect(beforeOf(displayed[2])).toBe(0); // the oldest purchase: 0 → 10
  });

  test("9. same-timestamp movements have deterministic balance order", () => {
    const a = row({ delta: 10, balance: 10, ts: 500, _id: "z" });
    const b = row({ delta: -2, balance: 8, ts: 500, _id: "a", reason: "sale" });
    const sorted = chronological([a, b]);
    expect(sorted[0]._id).toBe("a"); // stable id tiebreak
    expect(sorted[1]._id).toBe("z");
    const again = chronological([a, b]);
    expect(again.map((r) => r._id)).toEqual(sorted.map((r) => r._id));
  });

  test("10. grouped net equals the sum of underlying ledger rows", () => {
    const rows = [
      row({ delta: -1, balance: 9, reason: "sale", reference: ORDER_REF }),
      row({ delta: -3, balance: 6, reason: "sale", reference: ORDER_REF }),
      row({ delta: 2, balance: 8, reason: "cancel", reference: ORDER_REF }),
    ];
    const [g] = groupMovements(rows);
    expect(g.net).toBe(rows.reduce((s, r) => s + r.delta, 0));
    expect(g.in).toBe(2);
    expect(g.out).toBe(4);
  });

  test("11. closing equals current ledger-derived stock (no date filter)", () => {
    const rows = [
      row({ delta: 10, balance: 10, ts: 100 }),
      row({ delta: -2, balance: 8, ts: 200, reason: "sale" }),
    ];
    expect(newestFirst(rows)[0].balance).toBe(8); // current stock
    expect(integrityMismatch(rows, 8, false)).toBeNull();
    expect(integrityMismatch(rows, 7, false)).toEqual({ expected: 7, actual: 8 });
  });

  test("12. pagination does not reset the running balance", () => {
    const all = [
      row({ delta: 10, balance: 10, ts: 100 }),
      row({ delta: -2, balance: 8, ts: 200, reason: "sale" }),
      row({ delta: 1, balance: 9, ts: 300, reason: "cancel" }),
      row({ delta: -4, balance: 5, ts: 400, reason: "sale" }),
    ];
    const page2 = all.slice(2); // a later page sees only newer rows
    expect(page2[0].balance).toBe(9); // server walk unchanged by paging
    expect(beforeOf(page2[0])).toBe(8);
    const groupsPage2 = groupMovements(page2);
    const saleGroup = groupsPage2.find((g) => g.reasons[0] === "sale")!;
    const cancelGroup = groupsPage2.find((g) => g.reasons[0] === "cancel")!;
    expect(saleGroup.opening).toBe(9); // 9 → 5, same as full-history math
    expect(saleGroup.closing).toBe(5);
    expect(cancelGroup.opening).toBe(8);
    expect(cancelGroup.closing).toBe(9);
  });

  test("13. reference links point to the correct sale/purchase", () => {
    expect(referenceHref(ORDER_REF)).toBe("/sales/sale-abc");
    expect(referenceHref(PO_REF)).toBe("/purchases/po-xyz");
    expect(referenceHref(undefined)).toBeNull();
    expect(referenceHref({ kind: "order", code: "X" })).toBeNull(); // no id
  });

  test("14. permission-restricted cost data is hidden from staff", () => {
    expect(visibleUnitCost(PO_REF, true)).toBe(214);
    expect(visibleUnitCost(PO_REF, false)).toBeUndefined();
  });

  test("range summary consistency guard", () => {
    expect(summaryIsConsistent({ opening: 0, in: 10, out: 2, closing: 8 })).toBe(true);
    expect(summaryIsConsistent({ opening: 0, in: 10, out: 2, closing: 7 })).toBe(false);
  });
});

describe("viewer refinement (signs, flow, labels)", () => {
  const flowRows = (): MovementRow[] => [
    row({ delta: 10, balance: 10, ts: 100 }),
    row({ delta: -2, balance: 8, ts: 200, reason: "sale" }),
    row({ delta: 1, balance: 9, ts: 300, reason: "cancel" }),
  ];

  test("1. opening 0, stock in +15, stock out −8, closing 7", () => {
    const { cards } = summaryCards({ opening: 0, in: 15, out: 8, closing: 7 }, false, 7);
    const by = (k: string) => cards.find((c) => c.key === k)!;
    expect(by("opening").value).toBe(0);
    expect(by("in").value).toBe(15);
    expect(by("out").value).toBe(-8);
    expect(by("closing").value).toBe(7);
    // magnitudes still satisfy the identity: opening + in − out = closing
    expect(0 + 15 - 8).toBe(7);
    expect(summaryIsConsistent({ opening: 0, in: 15, out: 8, closing: 7 })).toBe(true);
  });

  test("2. stock-out summary renders a negative sign", () => {
    const { cards } = summaryCards({ opening: 0, in: 15, out: 8, closing: 7 }, false, 7);
    const out = cards.find((c) => c.key === "out")!;
    expect(out.value).toBeLessThan(0);
    expect(out.tone).toBe("destructive");
    // in is positive + success; opening/closing carry no sign
    expect(cards.find((c) => c.key === "in")!.value).toBeGreaterThan(0);
    expect(cards.find((c) => c.key === "opening")!.tone).toBeUndefined();
    expect(cards.find((c) => c.key === "closing")!.tone).toBeUndefined();
  });

  test("3. net-zero group renders neutral 'No stock change'", () => {
    const d = netDisplay(0);
    expect(d.signed).toBe("0");
    expect(d.tone).toBe("neutral");
    // the sheet appends the label; the pure contract is the neutral tone
    expect(d.tone).not.toBe("success");
    expect(d.tone).not.toBe("destructive");
  });

  test("4. positive and negative groups use correct signs", () => {
    expect(netDisplay(5)).toEqual({ signed: "+5", tone: "success" });
    expect(netDisplay(-5)).toEqual({ signed: "−5", tone: "destructive" });
  });

  test("5. expanded children render oldest to newest", () => {
    // One atomic operation (same transaction ts): the chain 0 → 10 → 8 → 9
    // renders oldest first regardless of input order.
    const groups = groupMovements(
      [...flowRows()].reverse().map((r) => ({ ...r, ts: 500, reference: ORDER_REF }))
    );
    expect(groups).toHaveLength(1);
    const rows = groups[0].rows;
    expect(rows.map((r) => beforeOf(r))).toEqual([0, 10, 8]);
    expect(rows.map((r) => r.balance)).toEqual([10, 8, 9]);
  });

  test("6. every adjacent child has continuous before/after balances", () => {
    const rows = flowRows();
    expect(flowContinuity(rows)).toEqual([]);
    // break detection: next.balanceBefore must equal prev.balanceAfter
    const broken = [
      row({ delta: 10, balance: 10, ts: 100 }),
      row({ delta: -2, balance: 8, ts: 200, reason: "sale", _id: "x" }),
      row({ delta: 1, balance: 99, ts: 300, reason: "cancel" }), // non-continuous
    ];
    const breaks = flowContinuity(broken);
    expect(breaks).toHaveLength(1);
    expect(breaks[0].expected).toBe(8);
    expect(breaks[0].actual).toBe(98);
  });

  test("7. same-timestamp movements have deterministic order", () => {
    // The balance chain (9 → 10 → 8) is the true transaction order; the id
    // tiebreak is only the fallback when the chain can't decide.
    const a = row({ delta: 1, balance: 10, ts: 500, _id: "z", reference: ORDER_REF });
    const b = row({ delta: -2, balance: 8, ts: 500, _id: "a", reason: "sale", reference: ORDER_REF });
    const g = groupMovements([a, b]);
    expect(g).toHaveLength(1);
    expect(g[0].rows.map((r) => r._id)).toEqual(["z", "a"]);
    expect(g[0].rows.map((r) => beforeOf(r))).toEqual([9, 10]);
    expect(flowContinuity(g[0].rows)).toEqual([]);
  });

  test("8. outer groups remain newest first", () => {
    const groups = groupMovements([
      row({ delta: 10, balance: 10, ts: 100, note: "old", reason: "adjustment" }),
      row({ delta: 5, balance: 15, ts: 900, note: "new", reason: "adjustment" }),
    ]);
    expect(groups[0].rows[groups[0].rows.length - 1].ts).toBe(900);
  });

  test("9. no-filter summary treats closing as current stock", () => {
    const { currentStockToday } = summaryCards(
      { opening: 0, in: 15, out: 8, closing: 7 },
      false,
      7
    );
    expect(currentStockToday).toBeNull(); // closing == current → no extra line
  });

  test("10. date-filter summary distinguishes closing from current stock", () => {
    const { cards, currentStockToday } = summaryCards(
      { opening: 3, in: 15, out: 8, closing: 10 },
      true,
      7
    );
    expect(cards.find((c) => c.key === "closing")!.value).toBe(10);
    expect(currentStockToday).toBe(7); // filtered closing ≠ current → shown separately
    const equal = summaryCards({ opening: 3, in: 15, out: 8, closing: 10 }, true, 10);
    expect(equal.currentStockToday).toBeNull();
  });

  test("11. singular '1 movement' and plural '2 movements'", async () => {
    const { labels } = await import("../config/labels");
    const en = labels.en.stock;
    expect(en.showMovementsOne.replace("{n}", "1")).toBe("Show 1 movement");
    expect(en.showMovements.replace("{n}", "2")).toBe("Show 2 movements");
    // Khmer is not plural-grammar dependent — both keys exist and render.
    const km = labels.km.stock;
    expect(km.showMovementsOne.replace("{n}", "1")).toContain("1");
    expect(km.showMovements.replace("{n}", "2")).toContain("2");
  });
});

describe("English and Khmer labels exist for the refinement strings", () => {
  test("12. both languages carry every new stock-viewer label", async () => {
    const { labels } = await import("../config/labels");
    for (const lang of ["en", "km"] as const) {
      const stock = labels[lang].stock;
      const requiredKeys = [
        "openingStock",
        "stockIn",
        "stockOut",
        "openingAtRange",
        "stockInDuring",
        "stockOutDuring",
        "closingAtRange",
        "currentStockBare",
        "currentStockToday",
        "noStockChange",
        "movementFlow",
        "movementFlowOrder",
        "showMovementsOne",
        "showMovements",
      ] as const;
      for (const key of requiredKeys) {
        expect(stock[key], `${lang}.stock.${key}`).toBeTruthy();
      }
      expect(stock.combined.saleCancel).toBeTruthy();
      expect(stock.combined.returnAdjustment).toBeTruthy();
      expect(labels[lang].stock.actions.purchase).toBeTruthy();
      expect(labels[lang].stock.actions.cancel).toBeTruthy();
    }
  });
});

describe("atomic operation grouping (spec fix)", () => {
  test("sale and later cancellation on the same order form separate groups", () => {
    const groups = groupMovements([
      row({
        delta: -3,
        balance: 7,
        ts: 100,
        reason: "sale",
        reference: ORDER_REF,
      }),
      row({
        delta: 3,
        balance: 10,
        ts: 300,
        reason: "cancel",
        reference: ORDER_REF,
      }),
    ]);
    expect(groups).toHaveLength(2);
    const saleOp = groups.find((g) => g.ts === 100)!;
    const cancelOp = groups.find((g) => g.ts === 300)!;
    expect(saleOp.reasons).toEqual(["sale"]);
    expect(cancelOp.reasons).toEqual(["cancel"]);
    expect(saleOp.opening).toBe(10);
    expect(saleOp.closing).toBe(7);
    expect(cancelOp.opening).toBe(7);
    expect(cancelOp.closing).toBe(10);
  });

  test("another order's movement between the two operations does not merge or break them", () => {
    // Order A sells 3 (10 → 7); order B sells 2 (7 → 5); order A cancels 3 (5 → 8).
    const groups = groupMovements([
      row({ delta: -3, balance: 7, ts: 100, reason: "sale", reference: ORDER_REF }),
      row({ delta: -2, balance: 5, ts: 200, reason: "sale", reference: OTHER_REF }),
      row({ delta: 3, balance: 8, ts: 300, reason: "cancel", reference: ORDER_REF }),
    ]);
    expect(groups).toHaveLength(3); // three atomic operations, never merged by saleId
    const aSale = groups.find((g) => g.ts === 100)!;
    const bSale = groups.find((g) => g.ts === 200)!;
    const aCancel = groups.find((g) => g.ts === 300)!;
    // Each operation is internally continuous…
    expect(flowContinuity(aSale.rows)).toEqual([]);
    expect(flowContinuity(bSale.rows)).toEqual([]);
    expect(flowContinuity(aCancel.rows)).toEqual([]);
    // …but the two order-A operations are NOT continuous with each other
    // (order B's movement legitimately sits between them) — this is exactly
    // the case the old saleId-grouping continuity rule got wrong.
    expect(aSale.closing).toBe(7);
    expect(aCancel.opening).toBe(5); // ≠ aSale.closing, and that's correct
    expect(aCancel.closing).toBe(8);
  });

  test("same-timestamp rows order as a valid balance chain", () => {
    // A consistent chain: 10 → 9 → 8 → 7, rows supplied in scrambled order.
    const rows = [
      row({ delta: -1, balance: 9, ts: 500, reason: "sale", reference: ORDER_REF, _id: "c" }),
      row({ delta: -1, balance: 7, ts: 500, reason: "sale", reference: ORDER_REF, _id: "a" }),
      row({ delta: -1, balance: 8, ts: 500, reason: "sale", reference: ORDER_REF, _id: "b" }),
    ];
    const ordered = chainOrder(rows);
    expect(ordered.map((r) => r.balance)).toEqual([9, 8, 7]);
    expect(ordered.map((r) => beforeOf(r))).toEqual([10, 9, 8]);
    const [g] = groupMovements(rows);
    expect(g.opening).toBe(10);
    expect(g.closing).toBe(7);
    expect(flowContinuity(g.rows)).toEqual([]);
  });

  test("grouping by operation keeps each operation continuous", () => {
    const groups = groupMovements([
      row({ delta: -3, balance: 7, ts: 100, reason: "sale", reference: ORDER_REF }),
      row({ delta: 2, balance: 9, ts: 100, reason: "return", reference: ORDER_REF }),
    ]);
    expect(groups).toHaveLength(1); // same transaction -> one operation
    expect(groups[0].net).toBe(-1);
    expect(flowContinuity(groups[0].rows)).toEqual([]);
  });

  test("saleId is not used as a continuity boundary", () => {
    // The pure check only ever runs inside one operation's rows; cross-
    // operation gaps are the NORMAL state of the ledger and must not be
    // flagged. Verify by grouping two operations and checking each one.
    const groups = groupMovements([
      row({ delta: -1, balance: 9, ts: 100, reason: "sale", reference: ORDER_REF }),
      row({ delta: -1, balance: 8, ts: 200, reason: "sale", reference: ORDER_REF }),
    ]);
    expect(groups).toHaveLength(2);
    for (const g of groups) expect(flowContinuity(g.rows)).toEqual([]);
    // the two operations need NOT chain into each other:
    expect(groups.find((g) => g.ts === 200)!.opening).toBe(9);
  });

  test("global ledger sum still equals current stock (integrity check)", () => {
    const rows = [
      row({ delta: 10, balance: 10, ts: 100 }),
      row({ delta: -3, balance: 7, ts: 200, reason: "sale", reference: ORDER_REF }),
      row({ delta: -2, balance: 5, ts: 300, reason: "sale", reference: OTHER_REF }),
      row({ delta: 3, balance: 8, ts: 400, reason: "cancel", reference: ORDER_REF }),
    ];
    const sum = rows.reduce((s2, r) => s2 + r.delta, 0);
    expect(sum).toBe(8); // the ledger sum
    expect(integrityMismatch(rows, sum, false)).toBeNull(); // newest == current
    expect(integrityMismatch(rows, 7, false)).toEqual({ expected: 7, actual: 8 });
  });
});

describe("single-movement groups and sort labels", () => {
  test("a group with one movement is not expandable", () => {
    const [g] = groupMovements([
      row({ delta: 10, balance: 10, ts: 100, reference: ORDER_REF }),
    ]);
    expect(g.rows).toHaveLength(1);
    expect(isExpandable(g)).toBe(false);
  });

  test("only groups with two or more movements are expandable", () => {
    const [g] = groupMovements([
      row({ delta: 10, balance: 10, ts: 100, reference: ORDER_REF }),
      row({ delta: -3, balance: 7, ts: 100, reason: "sale", reference: ORDER_REF }),
    ]);
    expect(g.rows).toHaveLength(2);
    expect(isExpandable(g)).toBe(true);
  });

  test("outer groups default to newest first", () => {
    const groups = groupMovements([
      row({ delta: 1, balance: 9, ts: 300, reference: ORDER_REF }),
      row({ delta: 5, balance: 14, ts: 900, reference: ORDER_REF }),
      row({ delta: -2, balance: 12, ts: 600, reason: "sale", reference: ORDER_REF }),
    ]);
    expect(groups.map((g) => g.ts)).toEqual([900, 600, 300]); // newest first
    // oldest-first is the exact reverse (the toggle in the sheet)
    expect([...groups].reverse().map((g) => g.ts)).toEqual([300, 600, 900]);
  });

  test("sort labels exist in English and Khmer", async () => {
    const { labels } = await import("../config/labels");
    expect(labels.en.stock.sortNewestFirst).toBe("Newest first");
    expect(labels.en.stock.sortOldestFirst).toBe("Oldest first");
    expect(labels.km.stock.sortNewestFirst).toBeTruthy();
    expect(labels.km.stock.sortOldestFirst).toBeTruthy();
  });
});
