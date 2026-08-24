import { convexTest } from "convex-test";
import { describe, expect, test, vi } from "vitest";

import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import schema from "./schema";

// Consolidation regression suite (AGENTS.md T12) — the 17 scenarios the
// sale-adjustment consolidation must never break. Every scenario verifies
// the full matrix the spec asks for: opening stock / operation / expected
// ledger rows / actual ledger rows / expected + actual closing stock /
// expected + actual order total, payments and profit, plus sale events,
// cost snapshots, the edit-version guard and the daily cash-basis report.
//
// The system under test is the REAL code path: sales.saveEdit is the one
// adjustment workflow, and it must classify every movement correctly
// (added qty → stock out, reduced/removed undelivered → stock in, swap →
// exchange_out + exchange_in, fee change → no movement) while appending
// immutable ledger rows + saleEvents in ONE transaction.

const AUTH_USER_ID = "test-auth-user";
let requestKeySequence = 0;

function requestKey(operation: string): string {
  requestKeySequence += 1;
  return `${operation}-${requestKeySequence}`;
}

// Sign-in is the ONE thing faked here (same as sales.test.ts): the
// better-auth component has no in-memory equivalent, so it's stubbed with
// a signed-in identity and everything below it runs for real.
vi.mock("./auth", () => ({
  authComponent: {
    safeGetAuthUser: async () => ({
      _id: AUTH_USER_ID,
      name: "Test Owner",
      email: "owner@test.local",
    }),
  },
}));

const modules = import.meta.glob("./**/*.ts");

type SeedIds = Awaited<ReturnType<typeof seed>>;
type VariantKey = "teeM" | "teeL" | "shirtBlack" | "shirtWhite";

/**
 * A shop with two products — "Basic Tee" (no colors, M / L, $10.00 sell /
 * $4.00 cost) and "Shirt" (colors, M × Black / White, $15.00 sell / $5.00
 * default cost) — 10 of each on the shelf via a received purchase, and one
 * customer. The White batch cost $6.00 (≠ its $5.00 default), so a swap
 * Black → White must re-cost the line 500 → 600 — the assertion that cost
 * snapshots move to the NEW variant's weighted average.
 */
async function seed(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    await ctx.db.insert("shop", {
      name: "Test Shop",
      currency: "USD",
      exchangeRate: 4000,
      timezone: "Asia/Phnom_Penh",
      deliveryEnabled: true,
      language: "en" as const,
    });
    const userId = await ctx.db.insert("users", {
      authUserId: AUTH_USER_ID,
      name: "Test Owner",
      email: "owner@test.local",
      role: "owner" as const,
      active: true,
    });
    const customerId = await ctx.db.insert("customers", {
      name: "Dara",
      nameLower: "dara",
      phone: "010000001",
      active: true,
    });
    const channelId = await ctx.db.insert("salesChannels", {
      name: "Facebook",
      nameLower: "facebook",
      type: "facebook" as const,
      active: true,
    });
    const teeId = await ctx.db.insert("products", {
      name: "Basic Tee",
      nameLower: "basic tee",
      defaultPrice: 1000,
      defaultCost: 400,
      hasColors: false,
      sizes: ["M", "L"],
      colors: [],
      active: true,
    });
    const teeM = await ctx.db.insert("productVariants", {
      productId: teeId,
      size: "M",
      active: true,
    });
    const teeL = await ctx.db.insert("productVariants", {
      productId: teeId,
      size: "L",
      active: true,
    });
    const shirtId = await ctx.db.insert("products", {
      name: "Shirt",
      nameLower: "shirt",
      defaultPrice: 1500,
      defaultCost: 500,
      hasColors: true,
      sizes: ["M"],
      colors: ["Black", "White"],
      active: true,
    });
    const shirtBlack = await ctx.db.insert("productVariants", {
      productId: shirtId,
      size: "M",
      color: "Black",
      active: true,
    });
    const shirtWhite = await ctx.db.insert("productVariants", {
      productId: shirtId,
      size: "M",
      color: "White",
      active: true,
    });

    // Stock arrives the only way it can: a received purchase writing ledger
    // rows. Different batch costs give weighted-average costing real input.
    const supplierId = await ctx.db.insert("suppliers", {
      name: "Supplier",
      nameLower: "supplier",
      active: true,
    });
    const purchaseId = await ctx.db.insert("purchases", {
      supplierId,
      code: "P-001",
      status: "received" as const,
      purchasedAt: now,
      receivedAt: now,
      userId,
      createdAt: now,
    });
    const batches: [Id<"productVariants">, number][] = [
      [teeM, 400],
      [teeL, 400],
      [shirtBlack, 500],
      [shirtWhite, 600],
    ];
    for (const [variantId, unitCost] of batches) {
      const purchaseItemId = await ctx.db.insert("purchaseItems", {
        purchaseId,
        variantId,
        qty: 10,
        unitCost,
      });
      await ctx.db.insert("stockLedger", {
        variantId,
        delta: 10,
        reason: "purchase" as const,
        purchaseItemId,
        userId,
        ts: now,
      });
    }
    return {
      userId,
      customerId,
      channelId,
      teeM,
      teeL,
      shirtBlack,
      shirtWhite,
    };
  });
}

const variantOf = (ids: SeedIds, key: VariantKey) => ids[key];

/** Every ledger row for a variant, read the way the app reads it. */
async function ledgerRows(
  t: ReturnType<typeof convexTest>,
  variantId: Id<"productVariants">,
) {
  return await t.run(async (ctx: MutationCtx) =>
    ctx.db
      .query("stockLedger")
      .withIndex("by_variant_ts", (q) => q.eq("variantId", variantId))
      .collect(),
  );
}

/** Stock the way the app computes it: the sum of the variant's ledger deltas. */
async function stockOf(
  t: ReturnType<typeof convexTest>,
  variantId: Id<"productVariants">,
) {
  const rows = await ledgerRows(t, variantId);
  return rows.reduce((sum, row) => sum + row.delta, 0);
}

/** "purchase +10, sale -2, cancel +3" — every ledger row for a variant in
 * order, so the matrix shows the exact movement trail. */
async function ledgerSummary(
  t: ReturnType<typeof convexTest>,
  variantId: Id<"productVariants">,
): Promise<string> {
  const rows = await ledgerRows(t, variantId);
  return rows
    .map((r) => `${r.reason} ${r.delta > 0 ? "+" : ""}${r.delta}`)
    .join(", ");
}

/** Today as the shop's day string (Asia/Phnom_Penh) — payments land on this
 * day, so the daily report must too (cash-basis rule #2). */
function todayDay(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Phnom_Penh",
  }).format(new Date());
}

/** A confirmed order through the real checkout — no shortcuts. */
async function checkout(
  t: ReturnType<typeof convexTest>,
  ids: SeedIds,
  lines: { variantId: Id<"productVariants">; qty: number }[],
  extra: {
    deliveryFee?: number;
    discount?: number;
    idempotencyKey?: string;
  } = {},
) {
  return await t.mutation(api.sales.checkout, {
    idempotencyKey: extra.idempotencyKey ?? requestKey("checkout"),
    customerId: ids.customerId,
    salesChannelId: ids.channelId,
    discount: extra.discount ?? 0,
    deliveryFee: extra.deliveryFee ?? 0,
    items: lines,
  });
}

type EditItem = {
  saleItemId?: Id<"saleItems">;
  variantId?: Id<"productVariants">;
  qty: number;
};

/** A save through the real sales.saveEdit — the one adjustment workflow. */
async function edit(
  t: ReturnType<typeof convexTest>,
  saleId: Id<"sales">,
  items: EditItem[],
  fields: {
    expectedVersion?: number;
    deliveryFee?: number;
    idempotencyKey?: string;
  } = {},
) {
  const { idempotencyKey = requestKey("save-edit"), ...editFields } = fields;
  return await t.mutation(api.sales.saveEdit, {
    idempotencyKey,
    saleId,
    items,
    ...editFields,
  });
}

/** The Convex error code a mutation rejected with (undefined when it didn't). */
async function errorCodeOf(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
    return undefined;
  } catch (err) {
    return (err as { data?: { code?: string } }).data?.code;
  }
}

type MatrixExpectation = {
  operation: string;
  saleId: Id<"sales">;
  stock?: Partial<Record<VariantKey, number>>;
  ledger?: Partial<Record<VariantKey, string>>;
  detail?: { total: number; paid: number; remaining: number; profit: number };
  events?: string[];
  snapshots?: number[];
  report?: {
    moneyIn: number;
    refunds: number;
    cogs: number;
    profit: number;
    paymentsCount: number;
  };
  version?: number;
};

/**
 * Compare every required dimension against the DB and print the PASS/FAIL
 * matrix the consolidation spec asks for: opening stock / operation /
 * expected + actual ledger rows / expected + actual closing stock /
 * expected + actual order total, paid, profit — plus events, cost
 * snapshots, the edit-version guard and the daily report. All rows print
 * before the assertions run, so a failure shows the whole matrix.
 */
async function verifyMatrix(
  t: ReturnType<typeof convexTest>,
  ids: SeedIds,
  title: string,
  opening: Partial<Record<VariantKey, number>>,
  e: MatrixExpectation,
): Promise<void> {
  console.log(`\n— ${title} —`);
  console.log(
    `opening stock: ${Object.entries(opening)
      .map(([k, v]) => `${k} ${v}`)
      .join(", ")}`,
  );
  console.log(`operation: ${e.operation}`);
  const matrix: [string, unknown, unknown][] = [];

  const detail = await t.query(api.sales.getDetail, { saleId: e.saleId });
  expect(detail).not.toBeNull();

  if (e.ledger) {
    for (const [key, expectedSummary] of Object.entries(e.ledger) as [
      VariantKey,
      string,
    ][]) {
      const actual = await ledgerSummary(t, variantOf(ids, key));
      matrix.push([`ledger ${key}`, expectedSummary, actual]);
    }
  }
  if (e.stock) {
    for (const [key, expectedStock] of Object.entries(e.stock) as [
      VariantKey,
      number,
    ][]) {
      const actual = await stockOf(t, variantOf(ids, key));
      matrix.push([`closing stock ${key}`, expectedStock, actual]);
    }
  }
  if (e.detail) {
    matrix.push(["order total", e.detail.total, detail!.total]);
    matrix.push(["paid", e.detail.paid, detail!.paid]);
    matrix.push(["remaining", e.detail.remaining, detail!.remaining]);
    matrix.push(["profit", e.detail.profit, detail!.profit]);
  }
  if (e.events) {
    // getDetail returns the history newest-first (the UI shows it that
    // way); the matrix asserts the chronological order the events really
    // happened in.
    const actual = detail!.events.map(({ event }) => event.type).reverse();
    matrix.push(["sale events", e.events.join(", "), actual.join(", ")]);
  }
  if (e.snapshots) {
    const actual = detail!.items.map(({ item }) => item.unitCostSnapshot);
    matrix.push(["cost snapshots", e.snapshots.join(", "), actual.join(", ")]);
  }
  if (e.version !== undefined) {
    const data = await t.query(api.sales.getEditData, { saleId: e.saleId });
    expect(data).not.toBeNull();
    matrix.push(["edit version", e.version, data!.version]);
  }
  if (e.report) {
    const day = todayDay();
    const pl = await t.query(api.reports.getPlReport, {
      period: { type: "day", value: day },
    });
    matrix.push([`report moneyIn (${day})`, e.report.moneyIn, pl.moneyIn]);
    matrix.push(["report refunds", e.report.refunds, pl.refunds]);
    matrix.push(["report cogs", e.report.cogs, pl.cogs]);
    matrix.push(["report profit", e.report.profit, pl.profit]);
    matrix.push([
      "report paymentsCount",
      e.report.paymentsCount,
      pl.paymentsCount,
    ]);
  }

  for (const [label, expectedValue, actualValue] of matrix) {
    const pass = expectedValue === actualValue;
    console.log(
      `${label}: expected ${String(expectedValue)} / actual ${String(
        actualValue,
      )} — ${pass ? "PASS" : "FAIL"}`,
    );
  }
  for (const [label, expectedValue, actualValue] of matrix) {
    expect(actualValue, label).toBe(expectedValue);
  }
}

/** Live opening stock for the four seeded variants (before the operation). */
async function opening(
  t: ReturnType<typeof convexTest>,
  ids: SeedIds,
): Promise<Record<VariantKey, number>> {
  return {
    teeM: await stockOf(t, ids.teeM),
    teeL: await stockOf(t, ids.teeL),
    shirtBlack: await stockOf(t, ids.shirtBlack),
    shirtWhite: await stockOf(t, ids.shirtWhite),
  };
}

describe("sale-edit consolidation regression (the 17 scenarios)", () => {
  test("1. save without changes", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const sale = await checkout(t, ids, [{ variantId: ids.teeM, qty: 2 }]);
    const before = await opening(t, ids);

    const after = await edit(t, sale.sale._id, [
      { saleItemId: sale.items[0].item._id, qty: 2 },
    ]);

    expect(after.total).toBe(2000);
    await verifyMatrix(t, ids, "1. save without changes", before, {
      operation: "saveEdit with the same items — nothing changed",
      saleId: sale.sale._id,
      stock: { teeM: 8 },
      ledger: { teeM: "purchase +10, sale -2" }, // no movement, no new rows
      detail: { total: 2000, paid: 0, remaining: 2000, profit: 1200 },
      events: ["created"], // no-op save appends nothing
      snapshots: [400], // snapshot untouched
      report: { moneyIn: 0, refunds: 0, cogs: 0, profit: 0, paymentsCount: 0 },
      version: 1, // every save bumps the stale-edit counter
    });
  });

  test("2. add one item", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const sale = await checkout(t, ids, [{ variantId: ids.teeM, qty: 2 }]);
    const before = await opening(t, ids);

    await edit(t, sale.sale._id, [
      { saleItemId: sale.items[0].item._id, qty: 2 },
      { variantId: ids.teeL, qty: 3 },
    ]);

    await verifyMatrix(t, ids, "2. add one item", before, {
      operation: "saveEdit adds teeL ×3 — the new line deducts its stock",
      saleId: sale.sale._id,
      stock: { teeM: 8, teeL: 7 },
      ledger: {
        teeM: "purchase +10, sale -2", // untouched line, untouched stock
        teeL: "purchase +10, sale -3",
      },
      detail: { total: 5000, paid: 0, remaining: 5000, profit: 3000 },
      events: ["created", "item_added"],
      snapshots: [400, 400], // new line snapshots the current average cost
      report: { moneyIn: 0, refunds: 0, cogs: 0, profit: 0, paymentsCount: 0 },
      version: 1,
    });
  });

  test("3. add the same variant as a separate line", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const sale = await checkout(t, ids, [{ variantId: ids.teeM, qty: 2 }]);
    const before = await opening(t, ids);

    const after = await edit(t, sale.sale._id, [
      { saleItemId: sale.items[0].item._id, qty: 2 },
      { variantId: ids.teeM, qty: 1 },
    ]);

    // The same item added twice stays two lines (checkout rule) — the edit
    // page does not merge them either; both lines deduct stock.
    expect(after.items).toHaveLength(2);
    await verifyMatrix(
      t,
      ids,
      "3. add the same variant as a separate line",
      before,
      {
        operation: "saveEdit adds teeM ×1 on its own second line",
        saleId: sale.sale._id,
        stock: { teeM: 7 },
        ledger: { teeM: "purchase +10, sale -2, sale -1" },
        detail: { total: 3000, paid: 0, remaining: 3000, profit: 1800 },
        events: ["created", "item_added"],
        snapshots: [400, 400],
        report: {
          moneyIn: 0,
          refunds: 0,
          cogs: 0,
          profit: 0,
          paymentsCount: 0,
        },
        version: 1,
      },
    );
  });

  test("4. increase quantity", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const sale = await checkout(t, ids, [{ variantId: ids.teeM, qty: 2 }]);
    const before = await opening(t, ids);

    const after = await edit(t, sale.sale._id, [
      { saleItemId: sale.items[0].item._id, qty: 5 },
    ]);

    // The raise is an ADD-ON, never a rewrite: the original line keeps its
    // qtyOrdered, its price and its historical cost snapshot, and the extra
    // 3 pieces become their OWN internal saleItems row (splitFromItemId →
    // parent), priced and costed at the CURRENT server figures.
    expect(after.items).toHaveLength(2);
    expect(after.items[0].item.qtyOrdered).toBe(2);
    expect(after.items[0].item.unitPrice).toBe(1000);
    expect(after.items[0].item.unitCostSnapshot).toBe(400); // old snapshot kept
    const split = after.items[1].item;
    expect(split.splitFromItemId).toBe(sale.items[0].item._id);
    expect(split.qtyOrdered).toBe(3); // exactly the delta
    expect(split.unitPrice).toBe(1000); // the variant's CURRENT price
    expect(split.unitCostSnapshot).toBe(400); // the CURRENT weighted average
    expect(split.qtyDelivered).toBe(0); // confirmed order: not delivered yet
    await verifyMatrix(t, ids, "4. increase quantity", before, {
      operation: "saveEdit raises the line 2 → 5 — only the extra 3 leave",
      saleId: sale.sale._id,
      stock: { teeM: 5 },
      ledger: { teeM: "purchase +10, sale -2, sale -3" },
      detail: { total: 5000, paid: 0, remaining: 5000, profit: 3000 },
      events: ["created", "item_added"], // the raise writes its own event
      snapshots: [400, 400], // parent + the fresh split
      report: { moneyIn: 0, refunds: 0, cogs: 0, profit: 0, paymentsCount: 0 },
      version: 1,
    });
  });

  test("5. decrease undelivered quantity", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const sale = await checkout(t, ids, [{ variantId: ids.teeM, qty: 5 }]);
    const before = await opening(t, ids);

    await edit(t, sale.sale._id, [
      { saleItemId: sale.items[0].item._id, qty: 2 },
    ]);

    await verifyMatrix(t, ids, "5. decrease undelivered quantity", before, {
      operation: "saveEdit lowers the line 5 → 2 — the difference flows back",
      saleId: sale.sale._id,
      stock: { teeM: 8 },
      ledger: { teeM: "purchase +10, sale -5, cancel +3" },
      detail: { total: 2000, paid: 0, remaining: 2000, profit: 1200 },
      events: ["created", "item_qty_changed"],
      snapshots: [400],
      report: { moneyIn: 0, refunds: 0, cogs: 0, profit: 0, paymentsCount: 0 },
      version: 1,
    });
  });

  test("6. remove an undelivered line", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const sale = await checkout(t, ids, [
      { variantId: ids.teeM, qty: 2 },
      { variantId: ids.teeL, qty: 1 },
    ]);
    const before = await opening(t, ids);

    const after = await edit(t, sale.sale._id, [
      { saleItemId: sale.items[0].item._id, qty: 0 },
      { saleItemId: sale.items[1].item._id, qty: 1 },
    ]);

    expect(after.items).toHaveLength(2); // history row kept, never deleted
    await verifyMatrix(t, ids, "6. remove an undelivered line", before, {
      operation: "saveEdit sets teeM line qty 0 — its billed stock flows back",
      saleId: sale.sale._id,
      stock: { teeM: 10, teeL: 9 },
      ledger: {
        teeM: "purchase +10, sale -2, cancel +2",
        teeL: "purchase +10, sale -1",
      },
      detail: { total: 1000, paid: 0, remaining: 1000, profit: 600 },
      events: ["created", "item_removed"],
      snapshots: [400, 400],
      report: { moneyIn: 0, refunds: 0, cogs: 0, profit: 0, paymentsCount: 0 },
      version: 1,
    });
  });

  test("7. change variant (size × color swap)", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const sale = await checkout(t, ids, [
      { variantId: ids.shirtBlack, qty: 2 },
    ]);
    const before = await opening(t, ids);

    await edit(t, sale.sale._id, [
      {
        saleItemId: sale.items[0].item._id,
        variantId: ids.shirtWhite,
        qty: 2,
      },
    ]);

    await verifyMatrix(
      t,
      ids,
      "7. change variant (size × color swap)",
      before,
      {
        operation: "saveEdit swaps Black → White before delivery",
        saleId: sale.sale._id,
        stock: { shirtBlack: 10, shirtWhite: 8 },
        ledger: {
          shirtBlack: "purchase +10, sale -2, exchange_out +2",
          shirtWhite: "purchase +10, exchange_in -2",
        },
        // Re-costed to White's $6.00 average (batch cost), not the $5.00
        // default and not Black's $5.00 snapshot: 2 × ($15 − $6) = 1800.
        detail: { total: 3000, paid: 0, remaining: 3000, profit: 1800 },
        events: ["created", "item_swapped"],
        snapshots: [600],
        report: {
          moneyIn: 0,
          refunds: 0,
          cogs: 0,
          profit: 0,
          paymentsCount: 0,
        },
        version: 1,
      },
    );
  });

  test("8. change several lines in one save", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const sale = await checkout(t, ids, [
      { variantId: ids.teeM, qty: 2 },
      { variantId: ids.teeL, qty: 2 },
    ]);
    const before = await opening(t, ids);

    await edit(t, sale.sale._id, [
      { saleItemId: sale.items[0].item._id, qty: 3 }, // raise
      { saleItemId: sale.items[1].item._id, qty: 1 }, // lower
      { variantId: ids.shirtBlack, qty: 1 }, // add
    ]);

    await verifyMatrix(t, ids, "8. change several lines in one save", before, {
      operation:
        "one saveEdit raises teeM 2→3, lowers teeL 2→1, adds shirtBlack ×1",
      saleId: sale.sale._id,
      stock: { teeM: 7, teeL: 9, shirtBlack: 9 },
      ledger: {
        teeM: "purchase +10, sale -2, sale -1",
        teeL: "purchase +10, sale -2, cancel +1",
        shirtBlack: "purchase +10, sale -1",
      },
      detail: { total: 5500, paid: 0, remaining: 5500, profit: 3400 },
      // The raise (teeM) and the reduction (teeL) apply in plan order, then
      // the brand-new line is inserted — each writes its own event.
      events: [
        "created",
        "item_added", // teeM's raise — split into its own internal line
        "item_qty_changed", // teeL's reduction
        "item_added", // the brand-new shirtBlack line
      ],
      // getDetail lists split rows as separate lines: teeM parent, teeL,
      // teeM's split (fresh snapshot), shirtBlack.
      snapshots: [400, 400, 400, 500],
      report: { moneyIn: 0, refunds: 0, cogs: 0, profit: 0, paymentsCount: 0 },
      version: 1,
    });
  });

  test("9. change only the delivery fee", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const sale = await checkout(t, ids, [{ variantId: ids.teeM, qty: 2 }]);
    const before = await opening(t, ids);

    await edit(
      t,
      sale.sale._id,
      [{ saleItemId: sale.items[0].item._id, qty: 2 }],
      { deliveryFee: 500 },
    );

    await verifyMatrix(t, ids, "9. change only the delivery fee", before, {
      operation: "saveEdit sets the shipping fee — no pieces move",
      saleId: sale.sale._id,
      stock: { teeM: 8 },
      ledger: { teeM: "purchase +10, sale -2" }, // fee-only edit: zero movement
      detail: { total: 2500, paid: 0, remaining: 2500, profit: 1700 },
      events: ["created", "sale_edited"],
      snapshots: [400],
      report: { moneyIn: 0, refunds: 0, cogs: 0, profit: 0, paymentsCount: 0 },
      version: 1,
    });
  });

  test("10. reduce below the delivered quantity is rejected", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const sale = await checkout(t, ids, [{ variantId: ids.teeM, qty: 3 }]);
    await t.mutation(api.sales.setLineDelivered, {
      saleId: sale.sale._id,
      adjustments: [{ saleItemId: sale.items[0].item._id, qtyDelivered: 3 }],
    });
    const before = await opening(t, ids);

    const code = await errorCodeOf(
      edit(t, sale.sale._id, [{ saleItemId: sale.items[0].item._id, qty: 2 }]),
    );
    expect(code).toBe("INVALID_QTY");

    // The rejected save changed nothing — delivered pieces are never
    // silently removed by a normal edit (that's the return flow's job).
    await verifyMatrix(
      t,
      ids,
      "10. reduce below the delivered quantity",
      before,
      {
        operation: "saveEdit lowers the line below qtyDelivered 3 — rejected",
        saleId: sale.sale._id,
        stock: { teeM: 7 },
        ledger: { teeM: "purchase +10, sale -3" },
        detail: { total: 3000, paid: 0, remaining: 3000, profit: 1800 },
        events: ["created", "lines_adjusted"],
        snapshots: [400],
        report: {
          moneyIn: 0,
          refunds: 0,
          cogs: 0,
          profit: 0,
          paymentsCount: 0,
        },
        version: 0, // failed save does not bump the counter
      },
    );
  });

  test("11. add more than available stock is rejected", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const sale = await checkout(t, ids, [{ variantId: ids.teeM, qty: 2 }]);
    const before = await opening(t, ids);

    const code = await errorCodeOf(
      edit(t, sale.sale._id, [{ saleItemId: sale.items[0].item._id, qty: 99 }]),
    );
    expect(code).toBe("OUT_OF_STOCK");

    await verifyMatrix(t, ids, "11. add more than available stock", before, {
      operation: "saveEdit raises the line 2 → 99 (shelf holds 8) — rejected",
      saleId: sale.sale._id,
      stock: { teeM: 8 },
      ledger: { teeM: "purchase +10, sale -2" },
      detail: { total: 2000, paid: 0, remaining: 2000, profit: 1200 },
      events: ["created"],
      snapshots: [400],
      report: { moneyIn: 0, refunds: 0, cogs: 0, profit: 0, paymentsCount: 0 },
      version: 0,
    });
  });

  test("12. mid-save failure rolls the whole save back", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const sale = await checkout(t, ids, [{ variantId: ids.teeM, qty: 2 }]);
    const other = await checkout(t, ids, [{ variantId: ids.teeL, qty: 1 }]);
    const before = await opening(t, ids);

    // The first line plans fine (qty 2 → 5), then the second line fails —
    // it belongs to ANOTHER order. The whole transaction must roll back.
    const code = await errorCodeOf(
      edit(t, sale.sale._id, [
        { saleItemId: sale.items[0].item._id, qty: 5 },
        { saleItemId: other.items[0].item._id, qty: 2 },
      ]),
    );
    expect(code).toBe("NOT_FOUND");

    await verifyMatrix(
      t,
      ids,
      "12. mid-save failure rolls the whole save back",
      before,
      {
        operation:
          "saveEdit: valid line + a line from another order — NOTHING saves",
        saleId: sale.sale._id,
        stock: { teeM: 8, teeL: 9 }, // no trace of the planned -3
        ledger: {
          teeM: "purchase +10, sale -2",
          teeL: "purchase +10, sale -1",
        },
        detail: { total: 2000, paid: 0, remaining: 2000, profit: 1200 },
        events: ["created"],
        snapshots: [400],
        report: {
          moneyIn: 0,
          refunds: 0,
          cogs: 0,
          profit: 0,
          paymentsCount: 0,
        },
        version: 0,
      },
    );
  });

  test("13. retrying the same save is a clean no-op", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const sale = await checkout(t, ids, [{ variantId: ids.teeM, qty: 2 }]);
    const items = [{ saleItemId: sale.items[0].item._id, qty: 5 }];
    await edit(t, sale.sale._id, items); // first save splits the raise
    const before = await opening(t, ids);

    await edit(t, sale.sale._id, items); // the retry (double-click, retry)

    // The split row is invisible bookkeeping: the retry measures the line's
    // EFFECTIVE billed total (parent 2 + split 3 = 5) against the displayed
    // 5 → delta 0 → nothing changes and nothing duplicates.
    await verifyMatrix(
      t,
      ids,
      "13. retrying the same save is a clean no-op",
      before,
      {
        operation:
          "the identical saveEdit payload sent again (raise already split)",
        saleId: sale.sale._id,
        stock: { teeM: 5 },
        ledger: { teeM: "purchase +10, sale -2, sale -3" }, // no duplicated rows
        detail: { total: 5000, paid: 0, remaining: 5000, profit: 3000 },
        events: ["created", "item_added"], // no duplicated events either
        snapshots: [400, 400], // parent + the one split from the first save
        report: {
          moneyIn: 0,
          refunds: 0,
          cogs: 0,
          profit: 0,
          paymentsCount: 0,
        },
        version: 2, // every save bumps the counter, even a no-op one
      },
    );
  });

  test("14. two windows editing concurrently (stale-edit guard)", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const sale = await checkout(t, ids, [{ variantId: ids.teeM, qty: 2 }]);
    const before = await opening(t, ids);

    // Window A loads version 0 and saves first.
    await edit(
      t,
      sale.sale._id,
      [{ saleItemId: sale.items[0].item._id, qty: 5 }],
      { expectedVersion: 0 },
    );

    // Window B still holds version 0 — its save must be refused.
    const code = await errorCodeOf(
      edit(t, sale.sale._id, [{ saleItemId: sale.items[0].item._id, qty: 6 }], {
        expectedVersion: 0,
      }),
    );
    expect(code).toBe("STALE_EDIT");

    // Window B reloads (now version 1) and succeeds.
    await edit(
      t,
      sale.sale._id,
      [{ saleItemId: sale.items[0].item._id, qty: 6 }],
      { expectedVersion: 1 },
    );

    await verifyMatrix(t, ids, "14. two windows editing concurrently", before, {
      operation:
        "A saves (v0 → v1); B's v0 save is refused; B reloads and saves v1 → v2",
      saleId: sale.sale._id,
      stock: { teeM: 4 }, // 10 − 2 − 3 − 1
      ledger: { teeM: "purchase +10, sale -2, sale -3, sale -1" },
      detail: { total: 6000, paid: 0, remaining: 6000, profit: 3600 },
      events: ["created", "item_added", "item_added"], // one split per raise
      snapshots: [400, 400, 400], // parent + split #1 + split #2
      report: { moneyIn: 0, refunds: 0, cogs: 0, profit: 0, paymentsCount: 0 },
      version: 2,
    });
  });

  test("15. cancel after edit flows all stock back", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const sale = await checkout(t, ids, [{ variantId: ids.teeM, qty: 2 }]);
    await edit(t, sale.sale._id, [
      { saleItemId: sale.items[0].item._id, qty: 2 },
      { variantId: ids.teeL, qty: 1 },
    ]);
    const before = await opening(t, ids);

    await t.mutation(api.sales.setStatus, {
      saleId: sale.sale._id,
      status: "cancelled",
    });

    await verifyMatrix(
      t,
      ids,
      "15. cancel after edit flows all stock back",
      before,
      {
        operation: "the edited order is cancelled — every billed piece returns",
        saleId: sale.sale._id,
        stock: { teeM: 10, teeL: 10 },
        ledger: {
          teeM: "purchase +10, sale -2, cancel +2",
          teeL: "purchase +10, sale -1, cancel +1",
        },
        detail: { total: 0, paid: 0, remaining: 0, profit: 0 },
        events: ["created", "item_added", "status_changed"],
        snapshots: [400, 400],
        report: {
          moneyIn: 0,
          refunds: 0,
          cogs: 0,
          profit: 0,
          paymentsCount: 0,
        },
        version: 1, // the edit's counter stays — cancel doesn't rewrite history
      },
    );
  });

  test("16. return delivered pieces after edit", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const sale = await checkout(t, ids, [{ variantId: ids.teeM, qty: 3 }]);
    await t.mutation(api.sales.setLineDelivered, {
      saleId: sale.sale._id,
      adjustments: [{ saleItemId: sale.items[0].item._id, qtyDelivered: 3 }],
    });
    await edit(t, sale.sale._id, [
      { saleItemId: sale.items[0].item._id, qty: 3 },
      { variantId: ids.teeL, qty: 1 },
    ]);
    const before = await opening(t, ids);

    // The customer brings 1 tee back — the dedicated return flow (never a
    // silent edit) — then pays $20 and gets $5 refunded.
    await t.mutation(api.sales.returnItems, {
      saleId: sale.sale._id,
      returns: [{ saleItemId: sale.items[0].item._id, qty: 1 }],
    });
    // Each event rides its own mutation's timestamp; two mutations landing
    // in the same millisecond make the harness's index tie-break (reverse
    // insertion) disagree with production (insertion order) and the event
    // sequence flakes. A 2ms gap makes the order deterministic everywhere.
    await new Promise((resolve) => setTimeout(resolve, 2));
    await t.mutation(api.payments.receive, {
      idempotencyKey: requestKey("payment-receive"),
      saleId: sale.sale._id,
      amount: 2000,
      method: "cash",
    });
    await new Promise((resolve) => setTimeout(resolve, 2));
    await t.mutation(api.payments.refund, {
      idempotencyKey: requestKey("payment-refund"),
      saleId: sale.sale._id,
      amount: 500,
    });

    await verifyMatrix(
      t,
      ids,
      "16. return delivered pieces after edit",
      before,
      {
        operation:
          "return 1 delivered teeM + receive $20 + refund $5 — after the edit",
        saleId: sale.sale._id,
        stock: { teeM: 8, teeL: 9 }, // 10 − 3 + 1 returned; teeL − 1 from edit
        ledger: {
          teeM: "purchase +10, sale -3, return +1",
          teeL: "purchase +10, sale -1",
        },
        // Billed: teeM 3 − 1 returned = 2 × $10 + teeL 1 × $10 = $30.
        // Profit: (20 − 8) + (10 − 4) = 1800. Paid 2000 − 500 refund = 1500.
        detail: { total: 3000, paid: 1500, remaining: 1500, profit: 1800 },
        events: [
          "created",
          "lines_adjusted",
          "item_added",
          "items_returned",
          "payment_received", // payments append their own audit events
          "refund",
        ],
        snapshots: [400, 400],
        // Cash basis: moneyIn 2000 − 500 refund = 1500; COGS pro-rata on
        // $12 item cost: 2000/3000 → +800, −500/3000 → −200 ⇒ 600.
        report: {
          moneyIn: 1500,
          refunds: 500,
          cogs: 600,
          profit: 900,
          paymentsCount: 2,
        },
        version: 1,
      },
    );
  });

  test("17. ledger, events, balance, snapshot, profit and reports stay consistent", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const sale = await checkout(t, ids, [
      { variantId: ids.shirtBlack, qty: 2 },
    ]);
    const before = await opening(t, ids);

    // Chain: checkout → swap to White (re-cost 500 → 600) → pay $20 →
    // refund $5. Everything must agree end-to-end: the ledger trail, the
    // events, the payment balance, the re-derived cost snapshot, the
    // order profit AND the daily cash-basis report (which uses the new
    // snapshot, not the old one).
    await edit(t, sale.sale._id, [
      {
        saleItemId: sale.items[0].item._id,
        variantId: ids.shirtWhite,
        qty: 2,
      },
    ]);
    // Same 2ms gaps as above: each event rides its own mutation's
    // timestamp, and the edit's events sit on now+2..now+4, so a payment
    // starting in the same millisecond could sort before them.
    await new Promise((resolve) => setTimeout(resolve, 2));
    await t.mutation(api.payments.receive, {
      idempotencyKey: requestKey("payment-receive"),
      saleId: sale.sale._id,
      amount: 2000,
      method: "cash",
    });
    await new Promise((resolve) => setTimeout(resolve, 2));
    await t.mutation(api.payments.refund, {
      idempotencyKey: requestKey("payment-refund"),
      saleId: sale.sale._id,
      amount: 500,
    });

    await verifyMatrix(
      t,
      ids,
      "17. everything stays consistent end-to-end",
      before,
      {
        operation: "checkout → swap Black→White → receive $20 → refund $5",
        saleId: sale.sale._id,
        stock: { shirtBlack: 10, shirtWhite: 8 },
        ledger: {
          shirtBlack: "purchase +10, sale -2, exchange_out +2",
          shirtWhite: "purchase +10, exchange_in -2",
        },
        // Profit re-derived with White's $6 snapshot: 2 × (15 − 6) = 1800.
        detail: { total: 3000, paid: 1500, remaining: 1500, profit: 1800 },
        events: ["created", "item_swapped", "payment_received", "refund"],
        snapshots: [600],
        // The report's COGS follows the swapped snapshot: item cost 2 × $6
        // = 1200; +2000/3000 → +800, −500/3000 → −200 ⇒ 600.
        report: {
          moneyIn: 1500,
          refunds: 500,
          cogs: 600,
          profit: 900,
          paymentsCount: 2,
        },
        version: 1,
      },
    );
  });
});

// ---------------------------------------------------------------------------
// Delivered-order edit (the real shop scenario): an order is delivered; the
// customer comes back to change a shirt's size and buys more; staff does it
// ALL on the ONE Edit Sale page — return held pieces (resolution dialog) and
// add new items (the Add-an-item search), each new item with its fulfillment
// ("Handed to customer now" / "Deliver later"), reviewed and saved once.
// The 22 scenarios below pin the server contract of that single save.
// ---------------------------------------------------------------------------

/**
 * A delivered order through the real flows: checkout, then setStatus
 * (fillAllDelivered books every outstanding piece; the checkout already
 * deducted stock). A 2ms pause guarantees the deliver event lands on its own
 * millisecond — same-ms ties across transactions order arbitrarily in the
 * events index (the known race of the two pre-existing flaky tests).
 */
async function deliver(
  t: ReturnType<typeof convexTest>,
  ids: SeedIds,
  lines: { variantId: Id<"productVariants">; qty: number }[],
  extra: { deliveryFee?: number } = {},
) {
  const sale = await checkout(t, ids, lines, extra);
  await t.mutation(api.sales.setStatus, {
    saleId: sale.sale._id,
    status: "delivered",
  });
  await new Promise((resolve) => setTimeout(resolve, 2));
  return sale;
}

describe("delivered-order edit (returns + new items, one save)", () => {
  test("1. return the old size and add the new size in one save", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const sale = await deliver(t, ids, [{ variantId: ids.teeM, qty: 2 }]);
    const before = await opening(t, ids);
    const line = sale.items[0].item;

    const after = await t.mutation(api.sales.saveEdit, {
      idempotencyKey: requestKey("save-edit"),
      saleId: sale.sale._id,
      // The returned piece's line falls to its post-resolution billed qty;
      // the replacement is a NEW line — exactly what the page sends.
      items: [
        { saleItemId: line._id, qty: 1 },
        { variantId: ids.teeL, qty: 1, fulfillment: "handed_now" },
      ],
      resolutions: [
        { saleItemId: line._id, outcome: "returned_sellable", qty: 1 },
      ],
    });

    expect(after.sale.status).toBe("delivered"); // handed now → stays delivered
    expect(after.items).toHaveLength(2);
    const [oldLine, newLine] = after.items;
    expect(oldLine.item.qtyOrdered).toBe(2); // history never shrinks
    expect(oldLine.item.qtyDelivered).toBe(2);
    expect(oldLine.item.qtyReturned).toBe(1);
    expect(newLine.item.qtyOrdered).toBe(1); // the new line is fully handed over
    expect(newLine.item.qtyDelivered).toBe(1);
    await verifyMatrix(t, ids, "1. return old size + add new size", before, {
      operation:
        "delivered teeM ×2 → return 1 sellable + add teeL ×1 handed now",
      saleId: sale.sale._id,
      stock: { teeM: 9, teeL: 9 }, // 10−2+1; 10−1
      ledger: {
        teeM: "purchase +10, sale -2, return +1", // exactly ONE stock-in row
        teeL: "purchase +10, sale -1", // the new line deducts exactly once
      },
      detail: { total: 2000, paid: 0, remaining: 2000, profit: 1200 },
      events: ["created", "status_changed", "items_returned", "item_added"],
      snapshots: [400, 400],
      version: 1,
    });
  });

  test("2. return one shirt and add two more shirts", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const sale = await deliver(t, ids, [{ variantId: ids.teeM, qty: 2 }]);
    const before = await opening(t, ids);
    const line = sale.items[0].item;

    await t.mutation(api.sales.saveEdit, {
      idempotencyKey: requestKey("save-edit"),
      saleId: sale.sale._id,
      items: [
        { saleItemId: line._id, qty: 1 },
        { variantId: ids.teeL, qty: 1, fulfillment: "handed_now" },
        { variantId: ids.shirtBlack, qty: 1, fulfillment: "handed_now" },
      ],
      resolutions: [
        { saleItemId: line._id, outcome: "returned_sellable", qty: 1 },
      ],
    });

    await verifyMatrix(t, ids, "2. return + two extra shirts", before, {
      operation: "delivered teeM ×2 → return 1 + add teeL and shirtBlack",
      saleId: sale.sale._id,
      stock: { teeM: 9, teeL: 9, shirtBlack: 9 },
      ledger: {
        teeM: "purchase +10, sale -2, return +1",
        teeL: "purchase +10, sale -1",
        shirtBlack: "purchase +10, sale -1",
      },
      detail: { total: 3500, paid: 0, remaining: 3500, profit: 2200 },
      events: [
        "created",
        "status_changed",
        "items_returned",
        "item_added",
        "item_added",
      ],
      snapshots: [400, 400, 500],
      version: 1,
    });
  });

  test("3. the same replacement variant twice stays two separate lines", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const sale = await deliver(t, ids, [{ variantId: ids.teeM, qty: 2 }]);
    const before = await opening(t, ids);
    const line = sale.items[0].item;

    const after = await t.mutation(api.sales.saveEdit, {
      idempotencyKey: requestKey("save-edit"),
      saleId: sale.sale._id,
      items: [
        { saleItemId: line._id, qty: 1 },
        { variantId: ids.teeM, qty: 1, fulfillment: "handed_now" },
        { variantId: ids.teeM, qty: 1, fulfillment: "handed_now" },
      ],
      resolutions: [
        { saleItemId: line._id, outcome: "returned_sellable", qty: 1 },
      ],
    });

    expect(after.items).toHaveLength(3); // never merged
    await verifyMatrix(t, ids, "3. same variant twice", before, {
      operation: "two separate new teeM lines on the same delivered order",
      saleId: sale.sale._id,
      stock: { teeM: 7 }, // 10 − 2 + 1 − 1 − 1
      ledger: { teeM: "purchase +10, sale -2, return +1, sale -1, sale -1" },
      detail: { total: 3000, paid: 0, remaining: 3000, profit: 1800 },
      events: [
        "created",
        "status_changed",
        "items_returned",
        "item_added",
        "item_added",
      ],
      snapshots: [400, 400, 400],
      version: 1,
    });
  });

  test("4. a sellable return adds stock exactly once", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const sale = await deliver(t, ids, [{ variantId: ids.teeM, qty: 2 }]);
    const line = sale.items[0].item;

    await t.mutation(api.sales.saveEdit, {
      idempotencyKey: requestKey("save-edit"),
      saleId: sale.sale._id,
      items: [{ saleItemId: line._id, qty: 1 }],
      resolutions: [
        { saleItemId: line._id, outcome: "returned_sellable", qty: 1 },
      ],
    });

    const rows = await ledgerRows(t, ids.teeM);
    const returnRows = rows.filter((r) => r.reason === "return");
    expect(returnRows).toHaveLength(1); // one row, never two
    expect(returnRows[0].delta).toBe(1);
    expect(await stockOf(t, ids.teeM)).toBe(9);
  });

  test("5. a damaged return does not increase sellable stock", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const sale = await deliver(t, ids, [{ variantId: ids.teeM, qty: 2 }]);
    const before = await opening(t, ids);
    const line = sale.items[0].item;

    await t.mutation(api.sales.saveEdit, {
      idempotencyKey: requestKey("save-edit"),
      saleId: sale.sale._id,
      items: [{ saleItemId: line._id, qty: 1 }],
      resolutions: [
        { saleItemId: line._id, outcome: "returned_damaged", qty: 1 },
      ],
    });

    await verifyMatrix(t, ids, "5. damaged return", before, {
      operation: "1 piece returned damaged — return +1, adjustment −1, net 0",
      saleId: sale.sale._id,
      stock: { teeM: 8 },
      ledger: { teeM: "purchase +10, sale -2, return +1, adjustment -1" },
      detail: { total: 1000, paid: 0, remaining: 1000, profit: 600 },
      events: ["created", "status_changed", "items_returned"],
      snapshots: [400],
      version: 1,
    });
  });

  test("6. still-with-customer leaves stock and bill untouched", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const sale = await deliver(t, ids, [{ variantId: ids.teeM, qty: 2 }]);
    const before = await opening(t, ids);
    const line = sale.items[0].item;

    const after = await t.mutation(api.sales.saveEdit, {
      idempotencyKey: requestKey("save-edit"),
      saleId: sale.sale._id,
      items: [{ saleItemId: line._id, qty: 2 }], // nothing changed
      resolutions: [
        { saleItemId: line._id, outcome: "still_with_customer", qty: 1 },
      ],
    });

    expect(after.items[0].item.qtyReturned).toBe(0); // nothing happened
    await verifyMatrix(t, ids, "6. still with customer", before, {
      operation: "1 piece resolved still_with_customer — no rows at all",
      saleId: sale.sale._id,
      stock: { teeM: 8 },
      ledger: { teeM: "purchase +10, sale -2" },
      detail: { total: 2000, paid: 0, remaining: 2000, profit: 1200 },
      events: ["created", "status_changed"],
      snapshots: [400],
      version: 1, // every save still bumps the stale-edit counter
    });
  });

  test("7. an undone pending resolution changes nothing", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const sale = await deliver(t, ids, [{ variantId: ids.teeM, qty: 2 }]);
    const before = await opening(t, ids);
    const line = sale.items[0].item;

    // The resolution was collected, then UNDONE before Save — so the save
    // ships without it (Undo is client state; the server only ever sees what
    // the page sends).
    await t.mutation(api.sales.saveEdit, {
      idempotencyKey: requestKey("save-edit"),
      saleId: sale.sale._id,
      items: [{ saleItemId: line._id, qty: 2 }],
    });

    await verifyMatrix(t, ids, "7. undone resolution", before, {
      operation: "the same save WITHOUT the resolution — nothing moves",
      saleId: sale.sale._id,
      stock: { teeM: 8 },
      ledger: { teeM: "purchase +10, sale -2" },
      detail: { total: 2000, paid: 0, remaining: 2000, profit: 1200 },
      events: ["created", "status_changed"],
      snapshots: [400],
      version: 1,
    });
  });

  test("8. new items handed now: delivered, stock out once, status kept", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const sale = await deliver(t, ids, [{ variantId: ids.teeM, qty: 2 }]);

    // The fulfillment choice is REQUIRED on a delivered order — a new line
    // without it is refused and writes nothing.
    const missing = await errorCodeOf(
      t.mutation(api.sales.saveEdit, {
        idempotencyKey: requestKey("save-edit"),
        saleId: sale.sale._id,
        items: [{ variantId: ids.teeL, qty: 1 }],
      }),
    );
    expect(missing).toBe("INVALID_INPUT");

    const after = await t.mutation(api.sales.saveEdit, {
      idempotencyKey: requestKey("save-edit"),
      saleId: sale.sale._id,
      items: [{ variantId: ids.teeL, qty: 1, fulfillment: "handed_now" }],
    });

    expect(after.sale.status).toBe("delivered");
    expect(after.items).toHaveLength(2);
    expect(after.items[1].item.qtyOrdered).toBe(1);
    expect(after.items[1].item.qtyDelivered).toBe(1); // handed over now
    expect(after.items[1].item.qtyReturned).toBe(0);
    expect(await ledgerSummary(t, ids.teeL)).toBe("purchase +10, sale -1");
  });

  test("9. new items delivered later: waiting line, order partially delivered", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const sale = await deliver(t, ids, [{ variantId: ids.teeM, qty: 2 }]);
    const before = await opening(t, ids);

    const after = await t.mutation(api.sales.saveEdit, {
      idempotencyKey: requestKey("save-edit"),
      saleId: sale.sale._id,
      items: [{ variantId: ids.teeL, qty: 1, fulfillment: "deliver_later" }],
    });

    expect(after.sale.status).toBe("partially_delivered");
    expect(after.items[1].item.qtyOrdered).toBe(1);
    expect(after.items[1].item.qtyDelivered).toBe(0); // waits for the second trip
    await verifyMatrix(t, ids, "9. deliver later", before, {
      operation: "delivered order + new teeL ×1 going out later",
      saleId: sale.sale._id,
      stock: { teeL: 9 }, // reserved exactly once, like any confirmed-sale line
      ledger: { teeL: "purchase +10, sale -1" },
      detail: { total: 3000, paid: 0, remaining: 3000, profit: 1800 },
      events: [
        "created",
        "status_changed",
        "item_added",
        "status_changed", // delivered → partially_delivered
      ],
      snapshots: [400, 400],
      version: 1,
    });
  });

  test("10. handed-now keeps the order Delivered — status is never re-opened", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const sale = await deliver(t, ids, [{ variantId: ids.teeM, qty: 2 }]);
    const before = await opening(t, ids);

    const after = await t.mutation(api.sales.saveEdit, {
      idempotencyKey: requestKey("save-edit"),
      saleId: sale.sale._id,
      items: [{ variantId: ids.teeL, qty: 1, fulfillment: "handed_now" }],
    });

    expect(after.sale.status).toBe("delivered");
    await verifyMatrix(t, ids, "10. handed now keeps delivered", before, {
      operation: "delivered order + handed-now line — status untouched",
      saleId: sale.sale._id,
      stock: { teeL: 9 },
      ledger: { teeL: "purchase +10, sale -1" },
      detail: { total: 3000, paid: 0, remaining: 3000, profit: 1800 },
      events: ["created", "status_changed", "item_added"],
      version: 1,
    });
  });

  test("11. mixed outcomes: any deliver-later makes the order partially delivered", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const sale = await deliver(t, ids, [{ variantId: ids.teeM, qty: 2 }]);

    const after = await t.mutation(api.sales.saveEdit, {
      idempotencyKey: requestKey("save-edit"),
      saleId: sale.sale._id,
      items: [
        { variantId: ids.teeL, qty: 1, fulfillment: "handed_now" },
        { variantId: ids.shirtBlack, qty: 1, fulfillment: "deliver_later" },
      ],
    });

    expect(after.sale.status).toBe("partially_delivered");
    expect(after.items[1].item.qtyDelivered).toBe(1); // handed now: delivered
    expect(after.items[2].item.qtyDelivered).toBe(0); // later: waiting
  });

  test("12. equal-price replacement: total unchanged", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const sale = await deliver(t, ids, [{ variantId: ids.teeM, qty: 2 }]);
    const line = sale.items[0].item;

    const after = await t.mutation(api.sales.saveEdit, {
      idempotencyKey: requestKey("save-edit"),
      saleId: sale.sale._id,
      items: [
        { saleItemId: line._id, qty: 1 },
        { variantId: ids.teeL, qty: 1, fulfillment: "handed_now" },
      ],
      resolutions: [
        { saleItemId: line._id, outcome: "returned_sellable", qty: 1 },
      ],
    });

    expect(after.total).toBe(2000); // $10 removed, $10 added — same bill
  });

  test("13. more-expensive replacement: total and profit re-derive", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const sale = await deliver(t, ids, [{ variantId: ids.teeM, qty: 2 }]);
    const before = await opening(t, ids);
    const line = sale.items[0].item;

    await t.mutation(api.sales.saveEdit, {
      idempotencyKey: requestKey("save-edit"),
      saleId: sale.sale._id,
      items: [
        { saleItemId: line._id, qty: 1 },
        { variantId: ids.shirtBlack, qty: 1, fulfillment: "handed_now" },
      ],
      resolutions: [
        { saleItemId: line._id, outcome: "returned_sellable", qty: 1 },
      ],
    });

    await verifyMatrix(t, ids, "13. more-expensive replacement", before, {
      operation: "delivered teeM ×2 → return 1 + add shirtBlack ×1 ($15)",
      saleId: sale.sale._id,
      stock: { teeM: 9, shirtBlack: 9 },
      ledger: {
        teeM: "purchase +10, sale -2, return +1",
        shirtBlack: "purchase +10, sale -1",
      },
      detail: { total: 2500, paid: 0, remaining: 2500, profit: 1600 },
      events: ["created", "status_changed", "items_returned", "item_added"],
      snapshots: [400, 500],
      version: 1,
    });
  });

  test("14. cheaper replacement shows refund due but never refunds automatically", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const sale = await deliver(t, ids, [{ variantId: ids.teeM, qty: 2 }]);
    const line = sale.items[0].item;
    await t.mutation(api.payments.receive, {
      idempotencyKey: requestKey("payment-receive"),
      saleId: sale.sale._id,
      amount: 2000,
      method: "cash",
    });

    const after = await t.mutation(api.sales.saveEdit, {
      idempotencyKey: requestKey("save-edit"),
      saleId: sale.sale._id,
      items: [
        { saleItemId: line._id, qty: 0 },
        { variantId: ids.teeL, qty: 1, fulfillment: "handed_now" },
      ],
      resolutions: [
        { saleItemId: line._id, outcome: "returned_sellable", qty: 2 },
      ],
    });

    // The bill drops below what was paid — but no refund row is written;
    // the staff member refunds explicitly (or not). Money out is always a
    // conscious act (AGENTS.md rule #2).
    expect(after.total).toBe(1000);
    expect(after.paid).toBe(2000);
    expect(after.remaining).toBe(0); // overpaid $10, remaining clamps to 0
    const rows = await t.run(async (ctx) =>
      ctx.db
        .query("payments")
        .withIndex("by_sale", (q) => q.eq("saleId", sale.sale._id))
        .collect(),
    );
    expect(rows).toHaveLength(1); // only the original payment — no refund
    expect(rows.every((r) => r.amount > 0 && r.method !== "refund")).toBe(true);
  });

  test("15. a second trip can charge an extra shipping fee in the same save", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const sale = await deliver(t, ids, [{ variantId: ids.teeM, qty: 2 }]);
    const before = await opening(t, ids);

    const after = await t.mutation(api.sales.saveEdit, {
      idempotencyKey: requestKey("save-edit"),
      saleId: sale.sale._id,
      items: [{ variantId: ids.teeL, qty: 1, fulfillment: "deliver_later" }],
      deliveryFee: 300, // the extra trip bills the customer
    });

    expect(after.sale.deliveryFee).toBe(300);
    await verifyMatrix(
      t,
      ids,
      "15. extra shipping for the second trip",
      before,
      {
        operation: "deliver-later line + deliveryFee 0 → 300 in the SAME save",
        saleId: sale.sale._id,
        stock: { teeL: 9 },
        ledger: { teeL: "purchase +10, sale -1" }, // the fee moves no stock
        detail: { total: 3300, paid: 0, remaining: 3300, profit: 2100 },
        events: [
          "created",
          "status_changed",
          "item_added",
          "sale_edited", // the fee edit, audited
          "status_changed", // delivered → partially_delivered
        ],
        version: 1,
      },
    );
  });

  test("16. duplicate lines overselling together are rejected", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const sale = await deliver(t, ids, [{ variantId: ids.teeM, qty: 2 }]);
    const before = await opening(t, ids);

    // Each line alone fits (teeL shelf is 10), together they don't (net 12
    // > 10) — the aggregate stock check must catch the pair.
    const code = await errorCodeOf(
      t.mutation(api.sales.saveEdit, {
        idempotencyKey: requestKey("save-edit"),
        saleId: sale.sale._id,
        items: [
          { variantId: ids.teeL, qty: 6, fulfillment: "handed_now" },
          { variantId: ids.teeL, qty: 6, fulfillment: "handed_now" },
        ],
      }),
    );
    expect(code).toBe("OUT_OF_STOCK");

    await verifyMatrix(t, ids, "16. aggregate oversell", before, {
      operation: "two new teeL lines ×6 each — 12 > the 10 on the shelf",
      saleId: sale.sale._id,
      stock: { teeL: 10 }, // nothing moved
      ledger: { teeL: "purchase +10" },
      detail: { total: 2000, paid: 0, remaining: 2000, profit: 1200 },
      events: ["created", "status_changed"],
      version: 0,
    });
  });

  test("17. a fully paid delivered order becomes partially unpaid after adding items", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const sale = await deliver(t, ids, [{ variantId: ids.teeM, qty: 2 }]);
    await t.mutation(api.payments.receive, {
      idempotencyKey: requestKey("payment-receive"),
      saleId: sale.sale._id,
      amount: 2000,
      method: "cash",
    });

    const after = await t.mutation(api.sales.saveEdit, {
      idempotencyKey: requestKey("save-edit"),
      saleId: sale.sale._id,
      items: [{ variantId: ids.teeL, qty: 1, fulfillment: "handed_now" }],
    });

    expect(after.total).toBe(3000);
    expect(after.paid).toBe(2000);
    expect(after.remaining).toBe(1000); // the extra shirt is still owed
  });

  test("18. a double-click retry creates no duplicate line, row or event", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const sale = await deliver(t, ids, [{ variantId: ids.teeM, qty: 2 }]);
    const before = await opening(t, ids);

    const payload = {
      saleId: sale.sale._id,
      expectedVersion: 0,
      items: [
        { variantId: ids.teeL, qty: 1, fulfillment: "handed_now" as const },
      ],
    };
    await t.mutation(api.sales.saveEdit, {
      ...payload,
      idempotencyKey: requestKey("save-edit-window-a"),
    });
    // The page's saving guard stops a second click; if it still fires, the
    // stale guard (version now 1) refuses the retry — nothing duplicates.
    const code = await errorCodeOf(
      t.mutation(api.sales.saveEdit, {
        ...payload,
        idempotencyKey: requestKey("save-edit-window-b"),
      }),
    );
    expect(code).toBe("STALE_EDIT");

    await verifyMatrix(t, ids, "18. double-click retry", before, {
      operation: "the same delivered-edit payload sent twice",
      saleId: sale.sale._id,
      stock: { teeL: 9 },
      ledger: { teeL: "purchase +10, sale -1" }, // exactly one deduction
      detail: { total: 3000, paid: 0, remaining: 3000, profit: 1800 },
      events: ["created", "status_changed", "item_added"],
      snapshots: [400, 400],
      version: 1,
    });
  });

  test("19. a stale window's save writes nothing", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const sale = await deliver(t, ids, [{ variantId: ids.teeM, qty: 2 }]);
    const before = await opening(t, ids);
    const line = sale.items[0].item;

    const code = await errorCodeOf(
      t.mutation(api.sales.saveEdit, {
        idempotencyKey: requestKey("save-edit"),
        saleId: sale.sale._id,
        expectedVersion: 99, // another window saved since this page loaded
        items: [
          { saleItemId: line._id, qty: 1 },
          { variantId: ids.teeL, qty: 1, fulfillment: "handed_now" },
        ],
        resolutions: [
          { saleItemId: line._id, outcome: "returned_sellable", qty: 1 },
        ],
      }),
    );
    expect(code).toBe("STALE_EDIT");

    await verifyMatrix(t, ids, "19. stale edit writes nothing", before, {
      operation: "a save from a window that loaded an old version — refused",
      saleId: sale.sale._id,
      stock: { teeM: 8, teeL: 10 }, // no return, no deduction
      ledger: {
        teeM: "purchase +10, sale -2",
        teeL: "purchase +10",
      },
      detail: { total: 2000, paid: 0, remaining: 2000, profit: 1200 },
      events: ["created", "status_changed"],
      version: 0,
    });
  });

  test("20. a mid-save failure rolls the return and the new lines back", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const sale = await deliver(t, ids, [{ variantId: ids.teeM, qty: 2 }]);
    const before = await opening(t, ids);
    const line = sale.items[0].item;

    // The return resolution lands first (inside the transaction), then the
    // new line oversells — the stock check fails and EVERYTHING rolls back:
    // no return row, no qtyReturned patch, no new line, no version bump.
    const code = await errorCodeOf(
      t.mutation(api.sales.saveEdit, {
        idempotencyKey: requestKey("save-edit"),
        saleId: sale.sale._id,
        items: [
          { saleItemId: line._id, qty: 1 },
          { variantId: ids.teeM, qty: 99, fulfillment: "handed_now" },
        ],
        resolutions: [
          { saleItemId: line._id, outcome: "returned_sellable", qty: 1 },
        ],
      }),
    );
    expect(code).toBe("OUT_OF_STOCK");

    await verifyMatrix(t, ids, "20. mid-save rollback", before, {
      operation:
        "valid return resolution + overselling new line — NOTHING lands",
      saleId: sale.sale._id,
      stock: { teeM: 8 },
      ledger: { teeM: "purchase +10, sale -2" },
      detail: { total: 2000, paid: 0, remaining: 2000, profit: 1200 },
      events: ["created", "status_changed"],
      version: 0,
    });
  });

  test("21. existing delivered lines: raises split, structural changes refuse", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const sale = await deliver(t, ids, [{ variantId: ids.teeM, qty: 2 }]);
    const before = await opening(t, ids);
    const line = sale.items[0].item;

    // (a) lower the billed qty without a resolution → the held-floor check.
    const below = await errorCodeOf(
      t.mutation(api.sales.saveEdit, {
        idempotencyKey: requestKey("save-edit"),
        saleId: sale.sale._id,
        items: [{ saleItemId: line._id, qty: 1 }],
      }),
    );
    expect(below).toBe("INVALID_QTY");
    // (b) raise the billed qty → LEGAL on a delivered order: the extra piece
    //     goes over with the visit, split into its own delivered internal
    //     line (the same current-price/current-cost derivation new lines get).
    const raised = await t.mutation(api.sales.saveEdit, {
      idempotencyKey: requestKey("save-edit"),
      saleId: sale.sale._id,
      items: [{ saleItemId: line._id, qty: 3 }],
    });
    expect(raised.sale.status).toBe("delivered");
    const split = raised.items.find(
      (it) => it.item.splitFromItemId === line._id,
    )!;
    expect(split.item.qtyOrdered).toBe(1); // exactly the delta
    expect(split.item.qtyDelivered).toBe(1); // handed over with the visit
    // (c) swap a line the customer still holds → the held guard refuses
    //     before the swap can even be considered.
    const swap = await errorCodeOf(
      t.mutation(api.sales.saveEdit, {
        idempotencyKey: requestKey("save-edit"),
        saleId: sale.sale._id,
        items: [{ saleItemId: line._id, variantId: ids.teeL, qty: 2 }],
      }),
    );
    expect(swap).toBe("INVALID_INPUT");
    // (d) fulfillment is only for NEW lines on a DELIVERED order — a new
    //     line with fulfillment on an undelivered order is refused.
    const other = await checkout(t, ids, [
      { variantId: ids.shirtBlack, qty: 1 },
    ]);
    const elsewhere = await errorCodeOf(
      t.mutation(api.sales.saveEdit, {
        idempotencyKey: requestKey("save-edit"),
        saleId: other.sale._id,
        items: [{ variantId: ids.teeL, qty: 1, fulfillment: "handed_now" }],
      }),
    );
    expect(elsewhere).toBe("INVALID_INPUT");

    await verifyMatrix(
      t,
      ids,
      "21. delivered raise + refused structural edits",
      before,
      {
        operation:
          "raise 2→3 (split, delivered); lower / swap / fulfillment-outside refused",
        saleId: sale.sale._id,
        stock: { teeM: 7, teeL: 10 },
        ledger: {
          teeM: "purchase +10, sale -2, sale -1",
          teeL: "purchase +10",
        },
        detail: { total: 3000, paid: 0, remaining: 3000, profit: 1800 },
        events: ["created", "status_changed", "item_added"],
        version: 1,
      },
    );
  });

  test("21b. a returned-to-zero delivered line still cannot be swapped", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const sale = await deliver(t, ids, [{ variantId: ids.teeM, qty: 2 }]);
    const line = sale.items[0].item;

    // First save: everything comes back, a replacement line goes out.
    await t.mutation(api.sales.saveEdit, {
      idempotencyKey: requestKey("save-edit"),
      saleId: sale.sale._id,
      items: [
        { saleItemId: line._id, qty: 0 },
        { variantId: ids.teeL, qty: 1, fulfillment: "handed_now" },
      ],
      resolutions: [
        { saleItemId: line._id, outcome: "returned_sellable", qty: 2 },
      ],
    });

    // Second save: the old (now empty) line has no held pieces, so it would
    // pass the held guard — the DELIVERED lock itself must refuse it: no
    // silent re-labeling of a delivered order's history.
    const swap = await errorCodeOf(
      t.mutation(api.sales.saveEdit, {
        idempotencyKey: requestKey("save-edit"),
        saleId: sale.sale._id,
        expectedVersion: 1,
        items: [{ saleItemId: line._id, variantId: ids.shirtBlack, qty: 0 }],
      }),
    );
    expect(swap).toBe("DELIVERED_LOCKED_LINES");
  });

  test("22. no Exchange / Change Size / Add-on workflow exists on the edit page", async () => {
    // The strict-UX contract: the delivered-order edit runs entirely through
    // the ONE items table — return held pieces (the resolution dialog) and
    // add with the Add-an-item search. No separate exchange UI may ever
    // exist; this test fails the moment one is introduced.
    const fs = await import("node:fs");
    const path = await import("node:path");
    const componentsDir = path.resolve(
      path.dirname(new URL(import.meta.url).pathname),
      "../src/components/features/sales",
    );
    for (const file of [
      "sale-edit-form.tsx",
      "sale-edit-items-table.tsx",
      "resolution-dialog.tsx",
    ]) {
      const source = fs.readFileSync(path.join(componentsDir, file), "utf8");
      const found = /exchange|change size|add-on|add on/i.test(source);
      expect(
        found,
        `${file} must not offer an Exchange / Change Size / Add-on workflow`,
      ).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// The delta rules (user spec): a raise is measured against the line's CURRENT
// BILLED quantity (qtyOrdered − qtyCancelled − qtyReturned) — never against
// the shelf and never against qtyDelivered — and only the positive delta
// draws stock. The delta becomes its own internal saleItems row, priced and
// costed at the CURRENT server figures, so history never rewrites.
// ---------------------------------------------------------------------------
describe("raise-split mechanics — delta-based validation (the user spec)", () => {
  test("delivered line 1 → 2 consumes only delta 1 and keeps fresh split values", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const sale = await deliver(t, ids, [{ variantId: ids.teeM, qty: 1 }]);
    const line = sale.items[0].item;

    expect(await stockOf(t, ids.teeM)).toBe(9);
    const beforeRows = await ledgerRows(t, ids.teeM);
    expect(beforeRows.filter((row) => row.reason === "sale")).toHaveLength(1);

    // A raise must use today's server values without rewriting the delivered
    // parent's historical price or cost snapshot.
    await t.run(async (ctx) => {
      const variant = await ctx.db.get(ids.teeM);
      expect(variant).not.toBeNull();
      await ctx.db.patch(ids.teeM, { price: 1300 });

      const purchaseRow = beforeRows.find((row) => row.reason === "purchase");
      expect(purchaseRow?.purchaseItemId).toBeDefined();
      await ctx.db.patch(purchaseRow!.purchaseItemId!, { unitCost: 700 });
    });

    const beforeEdit = await t.query(api.sales.getEditData, {
      saleId: sale.sale._id,
    });
    expect(beforeEdit!.items[0].billedQty).toBe(1);
    expect(beforeEdit!.items[0].stock).toBe(9);
    expect(beforeEdit!.items[0].maxQty).toBe(10);

    const after = await edit(t, sale.sale._id, [
      { saleItemId: line._id, qty: 2 },
    ]);

    const parent = after.items.find(({ item }) => item._id === line._id)!.item;
    const splits = after.items.filter(
      ({ item }) => item.splitFromItemId === line._id,
    );
    expect(parent.qtyOrdered).toBe(1);
    expect(parent.qtyDelivered).toBe(1);
    expect(parent.unitPrice).toBe(1000);
    expect(parent.unitCostSnapshot).toBe(400);
    expect(splits).toHaveLength(1);
    expect(splits[0].item.qtyOrdered).toBe(1);
    expect(splits[0].item.qtyDelivered).toBe(1);
    expect(splits[0].item.splitFromItemId).toBe(line._id);
    expect(splits[0].item.unitPrice).toBe(1300);
    expect(splits[0].item.unitCostSnapshot).toBe(700);

    const editData = await t.query(api.sales.getEditData, {
      saleId: sale.sale._id,
    });
    expect(editData!.items).toHaveLength(1);
    expect(editData!.items[0].billedQty).toBe(2);
    expect(editData!.items[0].item.qtyOrdered).toBe(2);
    expect(editData!.items[0].item.qtyDelivered).toBe(2);

    const afterRows = await ledgerRows(t, ids.teeM);
    const beforeIds = new Set(beforeRows.map((row) => row._id));
    const additionalRows = afterRows.filter((row) => !beforeIds.has(row._id));
    expect(additionalRows).toHaveLength(1);
    expect(additionalRows[0].reason).toBe("sale");
    expect(additionalRows[0].delta).toBe(-1);
    expect(additionalRows[0].saleItemId).toBe(splits[0].item._id);
    expect(afterRows.filter((row) => row.reason === "sale")).toHaveLength(2);
    expect(await stockOf(t, ids.teeM)).toBe(8);
  });

  test("A. billed baselines: ordered 3, cancelled 1 → billed 2; ordered 3, returned 1 → billed 2", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);

    // Ordered 3, then 1 cancelled by an edit (undelivered line).
    const cancelled = await checkout(t, ids, [{ variantId: ids.teeM, qty: 3 }]);
    await edit(t, cancelled.sale._id, [
      { saleItemId: cancelled.items[0].item._id, qty: 2 },
    ]);

    // Ordered 3, delivered, then 1 returned.
    const returned = await checkout(t, ids, [{ variantId: ids.teeL, qty: 3 }]);
    await t.mutation(api.sales.setLineDelivered, {
      saleId: returned.sale._id,
      adjustments: [
        { saleItemId: returned.items[0].item._id, qtyDelivered: 3 },
      ],
    });
    await t.mutation(api.sales.returnItems, {
      saleId: returned.sale._id,
      returns: [{ saleItemId: returned.items[0].item._id, qty: 1 }],
    });

    const cancelledData = await t.query(api.sales.getEditData, {
      saleId: cancelled.sale._id,
    });
    const returnedData = await t.query(api.sales.getEditData, {
      saleId: returned.sale._id,
    });
    // Both partial histories land on the SAME billed baseline: 2.
    expect(cancelledData!.items[0].billedQty).toBe(2);
    expect(returnedData!.items[0].billedQty).toBe(2);
    // maxQty = current billed + shelf (both shelves are 8 here: 10 − 3 + 1).
    expect(cancelledData!.items[0].maxQty).toBe(10);
    expect(returnedData!.items[0].maxQty).toBe(10);
  });

  test("B. raising displayed 2 → 3 requires only 1 stock: split row, fresh price + cost, original untouched", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const sale = await checkout(t, ids, [{ variantId: ids.teeM, qty: 2 }]);
    const before = await opening(t, ids);

    const after = await edit(t, sale.sale._id, [
      { saleItemId: sale.items[0].item._id, qty: 3 },
    ]);

    const parent = after.items[0].item;
    const split = after.items[1].item;
    expect(after.items).toHaveLength(2);
    // The original line is untouched — its historical price and cost stay.
    expect(parent.qtyOrdered).toBe(2);
    expect(parent.qtyDelivered).toBe(0);
    expect(parent.qtyCancelled).toBe(0);
    expect(parent.qtyReturned).toBe(0);
    expect(parent.unitPrice).toBe(1000);
    expect(parent.unitCostSnapshot).toBe(400);
    // The delta is its OWN line, priced/costed at the CURRENT figures.
    expect(split.splitFromItemId).toBe(parent._id);
    expect(split.qtyOrdered).toBe(1);
    expect(split.unitPrice).toBe(1000);
    expect(split.unitCostSnapshot).toBe(400);
    // The edit page shows ONE line at the displayed quantity.
    const data = await t.query(api.sales.getEditData, {
      saleId: sale.sale._id,
    });
    expect(data!.items).toHaveLength(1);
    expect(data!.items[0].billedQty).toBe(3);
    expect(data!.items[0].maxQty).toBe(3 + 7); // billed + shelf

    await verifyMatrix(t, ids, "B. raise 2 → 3 draws exactly one", before, {
      operation: "saveEdit raises teeM 2 → 3 — one piece leaves the shelf",
      saleId: sale.sale._id,
      stock: { teeM: 7 },
      ledger: { teeM: "purchase +10, sale -2, sale -1" },
      detail: { total: 3000, paid: 0, remaining: 3000, profit: 1800 },
      events: ["created", "item_added"],
      snapshots: [400, 400],
      version: 1,
    });
  });

  test("C. a raise may use every piece the shelf still has — and no more", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const sale = await checkout(t, ids, [{ variantId: ids.teeM, qty: 2 }]);

    // Billed 2, shelf 8 → the max displayed quantity is 10 (delta 8 = shelf).
    const atLimit = await edit(t, sale.sale._id, [
      { saleItemId: sale.items[0].item._id, qty: 10 },
    ]);
    expect(atLimit.items).toHaveLength(2);
    expect(atLimit.items[1].item.qtyOrdered).toBe(8); // the whole shelf

    // One more piece than the shelf holds → refused, nothing written.
    const code = await errorCodeOf(
      edit(t, sale.sale._id, [{ saleItemId: sale.items[0].item._id, qty: 11 }]),
    );
    expect(code).toBe("OUT_OF_STOCK");
    const rows = await ledgerRows(t, ids.teeM);
    expect(rows).toHaveLength(3); // purchase, sale −2, sale −8 — no 4th row
  });

  test("D. multiple lines of the same variant aggregate their positive deltas", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    // Two separate lines, same variant (the POS keeps repeat lines separate).
    const sale = await checkout(t, ids, [
      { variantId: ids.teeM, qty: 2 },
      { variantId: ids.teeM, qty: 2 },
    ]);
    const before = await opening(t, ids);
    const [a, b] = sale.items;

    // Each delta alone fits (4 ≤ 6); together they don't (4 + 4 > 6) —
    // the aggregate stock check must catch the pair.
    const code = await errorCodeOf(
      edit(t, sale.sale._id, [
        { saleItemId: a.item._id, qty: 6 },
        { saleItemId: b.item._id, qty: 6 },
      ]),
    );
    expect(code).toBe("OUT_OF_STOCK");

    // The same deltas land one save at a time.
    await edit(t, sale.sale._id, [{ saleItemId: a.item._id, qty: 6 }]); // −4
    await edit(t, sale.sale._id, [
      { saleItemId: a.item._id, qty: 6 }, // already 6 — a clean no-op
      { saleItemId: b.item._id, qty: 4 }, // −2
    ]);

    await verifyMatrix(t, ids, "D. same-variant deltas aggregate", before, {
      operation: "the pair is rejected together; each delta alone passes",
      saleId: sale.sale._id,
      stock: { teeM: 0 }, // 10 − 2 − 2 − 4 − 2
      ledger: { teeM: "purchase +10, sale -2, sale -2, sale -4, sale -2" },
      detail: { total: 10000, paid: 0, remaining: 10000, profit: 6000 },
      events: ["created", "item_added", "item_added"],
      snapshots: [400, 400, 400, 400], // two parents + their two splits
      version: 2,
    });
  });

  test("E. a returned line can't be raised again on a delivered order", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const sale = await deliver(t, ids, [{ variantId: ids.teeM, qty: 2 }]);
    const line = sale.items[0].item;
    await t.mutation(api.sales.returnItems, {
      saleId: sale.sale._id,
      returns: [{ saleItemId: line._id, qty: 1 }],
    });

    // Billed 1, returned 1 — raising back to 2 would re-bill returned goods
    // without ever moving stock. INVALID_QTY (the returned-line guard), not
    // the delivered lock: the guard holds on every status now.
    const code = await errorCodeOf(
      edit(t, sale.sale._id, [{ saleItemId: line._id, qty: 2 }]),
    );
    expect(code).toBe("INVALID_QTY");
  });

  test("F. a return resolution on a raised line distributes across parent then splits", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const sale = await deliver(t, ids, [{ variantId: ids.teeM, qty: 2 }]);
    const line = sale.items[0].item;

    // Raise 2 → 3 on the delivered order: the extra piece is split, delivered.
    const raised = await edit(t, sale.sale._id, [
      { saleItemId: line._id, qty: 3 },
    ]);
    const split = raised.items.find(
      (it) => it.item.splitFromItemId === line._id,
    )!.item;

    // Resolution for 2 sent against the MERGED line: the parent's held 2
    // resolve first, the split keeps its piece.
    await t.mutation(api.sales.saveEdit, {
      idempotencyKey: requestKey("save-edit"),
      saleId: sale.sale._id,
      items: [{ saleItemId: line._id, qty: 1 }],
      resolutions: [
        { saleItemId: line._id, outcome: "returned_sellable", qty: 2 },
      ],
    });
    let parent = await t.run((ctx) => ctx.db.get(line._id));
    let splitRow = await t.run((ctx) => ctx.db.get(split._id));
    expect(parent!.qtyReturned).toBe(2);
    expect(splitRow!.qtyReturned).toBe(0);

    // One more: the parent holds nothing now, the split gives its piece.
    // Version trail: the raise bumped 0→1, the first resolution save 1→2.
    await t.mutation(api.sales.saveEdit, {
      idempotencyKey: requestKey("save-edit"),
      saleId: sale.sale._id,
      expectedVersion: 2,
      items: [{ saleItemId: line._id, qty: 0 }],
      resolutions: [
        { saleItemId: line._id, outcome: "returned_sellable", qty: 1 },
      ],
    });
    parent = await t.run((ctx) => ctx.db.get(line._id));
    splitRow = await t.run((ctx) => ctx.db.get(split._id));
    expect(parent!.qtyReturned).toBe(2);
    expect(splitRow!.qtyReturned).toBe(1);

    // Nothing is left with the customer — a further resolution is refused.
    const code = await errorCodeOf(
      t.mutation(api.sales.saveEdit, {
        idempotencyKey: requestKey("save-edit"),
        saleId: sale.sale._id,
        expectedVersion: 3,
        items: [{ saleItemId: line._id, qty: 0 }],
        resolutions: [
          { saleItemId: line._id, outcome: "returned_sellable", qty: 1 },
        ],
      }),
    );
    expect(code).toBe("RETURN_EXCEEDS_HELD");
  });

  test("G. lowering a raised line cancels the split rows first (newest pieces)", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const sale = await checkout(t, ids, [{ variantId: ids.teeM, qty: 2 }]);
    const line = sale.items[0].item;

    const raised = await edit(t, sale.sale._id, [
      { saleItemId: line._id, qty: 5 },
    ]);
    const split = raised.items[1].item; // qtyOrdered 3

    // Lower 5 → 3: the 2 cancelled pieces come out of the SPLIT first — no
    // row can ever go negative, and the parent's history stays untouched.
    await edit(t, sale.sale._id, [{ saleItemId: line._id, qty: 3 }]);

    const parent = await t.run((ctx) => ctx.db.get(line._id));
    const splitRow = await t.run((ctx) => ctx.db.get(split._id));
    expect(parent!.qtyOrdered).toBe(2);
    expect(parent!.qtyCancelled).toBe(0); // the parent keeps its history
    expect(splitRow!.qtyCancelled).toBe(2);
    expect(await stockOf(t, ids.teeM)).toBe(7); // 10 − 2 − 3 + 2
    expect(await ledgerSummary(t, ids.teeM)).toBe(
      "purchase +10, sale -2, sale -3, cancel +2",
    );
    // The edit page still shows one line at the displayed 3.
    const data = await t.query(api.sales.getEditData, {
      saleId: sale.sale._id,
    });
    expect(data!.items[0].billedQty).toBe(3);
  });
});
