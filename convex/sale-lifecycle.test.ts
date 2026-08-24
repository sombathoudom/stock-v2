import { convexTest } from "convex-test";
import { describe, expect, test, vi } from "vitest";

import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import schema from "./schema";

// Sale lifecycle invariant regression suite — the audit of order 20260820-001
// (status "delivered", every line qtyDelivered = 0, one line Returned 1 while
// Delivered 0, two lines with no outcome) found two production behaviors that
// break the lifecycle invariants:
//
//   1. returnItems DECREMENTS qtyDelivered (conflating "delivered historically"
//      with "currently with the customer") — returning 1 of a delivered 1
//      stores Delivered 0 / Returned 1, erasing history.
//   2. saveEdit accepts structural changes (add lines / change qty) on a
//      DELIVERED sale, leaving new lines with no outcome.
//
// The invariants this suite enforces (server-side, once the fixes land):
//   1. 0 <= qtyReturned <= qtyDelivered
//   2. 0 <= qtyCancelled <= qtyOrdered
//   3. qtyDelivered + qtyCancelled <= qtyOrdered
//   4. a sale may be "delivered" only when every line has a final outcome
//   5. returning must not erase the historical delivered quantity
//   6. qty with the customer = qtyDelivered - qtyReturned (derived, explicit)
//   7. a refund cannot exceed the net positive payment balance
//
// The system under test is the REAL code path — checkout, setStatus,
// setLineDelivered, returnItems, saveEdit, payments.receive/refund and the
// daily cash-basis report all run for real (only better-auth is stubbed).

const AUTH_USER_ID = "test-auth-user";
let requestKeySequence = 0;

function requestKey(operation: string): string {
  requestKeySequence += 1;
  return `${operation}-${requestKeySequence}`;
}

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

/** One product, two sizes, 10 of each on the shelf via a received purchase. */
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
    const supplierId = await ctx.db.insert("suppliers", {
      name: "Supplier",
      nameLower: "supplier",
      active: true,
    });
    const purchaseId = await ctx.db.insert("purchases", {
      supplierId,
      code: "P1",
      status: "received" as const,
      purchasedAt: now,
      receivedAt: now,
      userId,
      createdAt: now,
    });
    for (const variantId of [teeM, teeL]) {
      const purchaseItemId = await ctx.db.insert("purchaseItems", {
        purchaseId,
        variantId,
        qty: 10,
        unitCost: 400,
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
    return { userId, customerId, channelId, teeM, teeL };
  });
}

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

async function stockOf(
  t: ReturnType<typeof convexTest>,
  variantId: Id<"productVariants">,
) {
  const rows = await ledgerRows(t, variantId);
  return rows.reduce((sum, row) => sum + row.delta, 0);
}

/** "purchase +10, sale -2, cancel +1" — the variant's full movement trail. */
async function ledgerSummary(
  t: ReturnType<typeof convexTest>,
  variantId: Id<"productVariants">,
): Promise<string> {
  const rows = await ledgerRows(t, variantId);
  return rows
    .map((r) => `${r.reason} ${r.delta > 0 ? "+" : ""}${r.delta}`)
    .join(", ");
}

/** Today as the shop's day string — payments land on it (cash-basis rule #2). */
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

/** Invariant 6, written out: what the customer currently holds. */
function held(item: { qtyDelivered: number; qtyReturned: number }): number {
  return item.qtyDelivered - item.qtyReturned;
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

/** Log + assert one value, so a failing run prints exactly what broke. */
function check(label: string, expectedValue: unknown, actualValue: unknown) {
  const pass = expectedValue === actualValue;
  console.log(
    `${label}: expected ${String(expectedValue)} / actual ${String(actualValue)} — ${
      pass ? "PASS" : "FAIL"
    }`,
  );
  expect(actualValue, label).toBe(expectedValue);
}

const SALE_PRICE = 1000; // $10.00 — Basic Tee default

describe("sale lifecycle invariants", () => {
  test("S1 — delivered 1 then returned 1: history kept, second return rejected", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const order = await checkout(t, ids, [{ variantId: ids.teeM, qty: 1 }]);
    const lineId = order.items[0].item._id;

    await t.mutation(api.sales.setStatus, {
      saleId: order.sale._id,
      status: "delivered",
    });

    const returned = await t.mutation(api.sales.returnItems, {
      saleId: order.sale._id,
      returns: [{ saleItemId: lineId, qty: 1 }],
    });
    const item = returned.items[0].item;
    check("S1 qtyDelivered stays 1 (historical)", 1, item.qtyDelivered);
    check("S1 qtyReturned is 1", 1, item.qtyReturned);
    check("S1 held by customer = delivered − returned", 0, held(item));
    check("S1 server-derived withCustomer", 0, returned.items[0].withCustomer);
    check(
      "S1 ledger trail",
      "purchase +10, sale -1, return +1",
      await ledgerSummary(t, ids.teeM),
    );
    check("S1 stock", 10, await stockOf(t, ids.teeM));
    check("S1 order total (returned piece is off the bill)", 0, returned.total);
    check("S1 remaining", 0, returned.remaining);

    // Invariant 1: nothing is left with the customer, so a second return is
    // impossible — the guard must be against held, not raw delivered.
    const code = await errorCodeOf(
      t.mutation(api.sales.returnItems, {
        saleId: order.sale._id,
        returns: [{ saleItemId: lineId, qty: 1 }],
      }),
    );
    check(
      "S1 second return rejected with RETURN_EXCEEDS_HELD",
      "RETURN_EXCEEDS_HELD",
      code,
    );
  });

  test("S2 — partially delivered, return, then mark delivered: no erasure, door adjust bounded", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const order = await checkout(t, ids, [{ variantId: ids.teeM, qty: 2 }]);
    const saleId = order.sale._id;
    const lineId = order.items[0].item._id;

    await t.mutation(api.sales.setStatus, { saleId, status: "delivering" });
    const door = await t.mutation(api.sales.setLineDelivered, {
      saleId,
      adjustments: [{ saleItemId: lineId, qtyDelivered: 1 }],
    });
    const doorItem = door.items[0].item;
    check("S2 door: delivered 1", 1, doorItem.qtyDelivered);
    check("S2 door: cancelled 1", 1, doorItem.qtyCancelled);
    check("S2 door: held 1", 1, held(doorItem));
    check(
      "S2 door ledger",
      "purchase +10, sale -2, cancel +1",
      await ledgerSummary(t, ids.teeM),
    );
    check("S2 door stock", 9, await stockOf(t, ids.teeM));

    await t.mutation(api.sales.setStatus, {
      saleId,
      status: "partially_delivered",
    });
    const returned = await t.mutation(api.sales.returnItems, {
      saleId,
      returns: [{ saleItemId: lineId, qty: 1 }],
    });
    const retItem = returned.items[0].item;
    check("S2 return: qtyDelivered stays 1", 1, retItem.qtyDelivered);
    check("S2 return: qtyReturned 1", 1, retItem.qtyReturned);
    check("S2 return: held 0", 0, held(retItem));

    // Invariant 1 at the door: delivered can never be marked below returned.
    const doorCode = await errorCodeOf(
      t.mutation(api.sales.setLineDelivered, {
        saleId,
        adjustments: [{ saleItemId: lineId, qtyDelivered: 0 }],
      }),
    );
    check(
      "S2 door below returned rejected with DELIVERED_BELOW_RETURNED",
      "DELIVERED_BELOW_RETURNED",
      doorCode,
    );

    // Marking the order delivered fills only the pieces still outstanding —
    // the cancelled piece went back to the shelf and STAYS cancelled (it was
    // never handed over, so it never becomes "with the customer"). The
    // returned piece stays returned: nothing is held, nothing bills.
    const done = await t.mutation(api.sales.setStatus, {
      saleId,
      status: "delivered",
    });
    const doneItem = done.items[0].item;
    check(
      "S2 delivered: qtyDelivered stays 1 (cancelled stays cancelled)",
      1,
      doneItem.qtyDelivered,
    );
    check("S2 delivered: qtyCancelled stays 1", 1, doneItem.qtyCancelled);
    check("S2 delivered: qtyReturned still 1", 1, doneItem.qtyReturned);
    check("S2 delivered: held 0", 0, held(doneItem));
    check("S2 server-derived withCustomer", 0, done.items[0].withCustomer);
    check(
      "S2 delivered ledger",
      "purchase +10, sale -2, cancel +1, return +1",
      await ledgerSummary(t, ids.teeM),
    );
    check("S2 delivered stock", 10, await stockOf(t, ids.teeM));
    check("S2 delivered order total (0 billed pieces)", 0, done.total);
  });

  test("S8 — door adjust after a partial return: re-deliverable, cancelled never double-counts returns", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const order = await checkout(t, ids, [{ variantId: ids.teeM, qty: 2 }]);
    const saleId = order.sale._id;
    const lineId = order.items[0].item._id;

    await t.mutation(api.sales.setStatus, { saleId, status: "delivering" });
    await t.mutation(api.sales.setLineDelivered, {
      saleId,
      adjustments: [{ saleItemId: lineId, qtyDelivered: 1 }],
    });
    // The customer brought their piece back — stock 10, nothing held.
    await t.mutation(api.sales.returnItems, {
      saleId,
      returns: [{ saleItemId: lineId, qty: 1 }],
    });

    // They then took the remaining piece: delivered is historical and can
    // still climb to ordered (the old `ordered − returned` ceiling blocked
    // this), and cancelled recomputes as ordered − delivered — subtracting
    // returned again would leave the returned piece counted as out of stock.
    const door = await t.mutation(api.sales.setLineDelivered, {
      saleId,
      adjustments: [{ saleItemId: lineId, qtyDelivered: 2 }],
    });
    const item = door.items[0].item;
    check("S8 door: delivered 2 (historical)", 2, item.qtyDelivered);
    check("S8 door: returned still 1", 1, item.qtyReturned);
    check("S8 door: cancelled 0", 0, item.qtyCancelled);
    check("S8 door: held 1", 1, held(item));
    check(
      "S8 door ledger",
      "purchase +10, sale -2, cancel +1, return +1, sale -1",
      await ledgerSummary(t, ids.teeM),
    );
    check("S8 door stock", 9, await stockOf(t, ids.teeM));
  });

  test("S3 — delivered status with unresolved lines: structural edits rejected, fee edits allowed", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const order = await checkout(t, ids, [{ variantId: ids.teeM, qty: 1 }]);
    const saleId = order.sale._id;
    const lineId = order.items[0].item._id;

    await t.mutation(api.sales.setStatus, { saleId, status: "delivered" });

    // Invariant 4: a delivered sale may never gain a line with no outcome.
    // New lines ARE allowed (returns + extra items on the Edit Sale page),
    // but each one must carry its fulfillment choice — without it the save
    // is refused before anything is written.
    const addCode = await errorCodeOf(
      t.mutation(api.sales.saveEdit, {
        idempotencyKey: requestKey("save-edit"),
        saleId,
        items: [
          { saleItemId: lineId, qty: 1 },
          { variantId: ids.teeL, qty: 1 },
        ],
      }),
    );
    check(
      "S3 new line on delivered without outcome rejected with INVALID_INPUT",
      "INVALID_INPUT",
      addCode,
    );

    // Raises ARE legal on a delivered order: the extra piece goes over with
    // the visit, split into its own delivered internal line (the delta rule:
    // only the positive delta draws stock, priced/costed at today's figures).
    const raised = await t.mutation(api.sales.saveEdit, {
      idempotencyKey: requestKey("save-edit"),
      saleId,
      items: [{ saleItemId: lineId, qty: 2 }],
    });
    check("S3 raise on delivered allowed", "delivered", raised.sale.status);
    const split = raised.items.find((i) => i.item.splitFromItemId === lineId)!;
    check(
      "S3 raise splits into a delivered internal line",
      1,
      split.item.qtyDelivered,
    );
    check("S3 raise bumps the version", 1, raised.sale.editedVersion ?? 0);

    // A fee-only edit stays legal (T14: the second-trip shipping charge) —
    // the line now bills 2 (parent + split), so the no-op qty is 2.
    const fee = await t.mutation(api.sales.saveEdit, {
      idempotencyKey: requestKey("save-edit"),
      saleId,
      items: [{ saleItemId: lineId, qty: 2 }],
      deliveryFee: 500,
    });
    check("S3 fee-only edit on delivered allowed", 500, fee.sale.deliveryFee);
    check("S3 fee-only edit bumps the version", 2, fee.sale.editedVersion ?? 0);
  });

  test("S4 — cancelled line: quantities stay in bounds, stock flows back", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const order = await checkout(t, ids, [{ variantId: ids.teeM, qty: 2 }]);
    const saleId = order.sale._id;
    const lineId = order.items[0].item._id;

    const edited = await t.mutation(api.sales.saveEdit, {
      idempotencyKey: requestKey("save-edit"),
      saleId,
      items: [{ saleItemId: lineId, qty: 1 }],
    });
    const item = edited.items[0].item;
    check("S4 cancelled 1", 1, item.qtyCancelled);
    check("S4 ordered stays 2", 2, item.qtyOrdered);
    check(
      "S4 delivered + cancelled <= ordered (1 <= 2)",
      true,
      item.qtyDelivered + item.qtyCancelled <= item.qtyOrdered,
    );
    check(
      "S4 cancelled <= ordered (2)",
      true,
      item.qtyCancelled <= item.qtyOrdered,
    );
    check(
      "S4 ledger",
      "purchase +10, sale -2, cancel +1",
      await ledgerSummary(t, ids.teeM),
    );
    check("S4 stock", 9, await stockOf(t, ids.teeM));
    check("S4 billed total", SALE_PRICE, edited.total);

    // Delivering fills only the still-OUTSTANDING piece (the customer took
    // it) — the cancelled piece stays cancelled and never becomes "with the
    // customer" (the reported bug). Bookkeeping only: the outstanding piece
    // was already deducted at checkout, so no new ledger row.
    const done = await t.mutation(api.sales.setStatus, {
      saleId,
      status: "delivered",
    });
    const doneItem = done.items[0].item;
    check(
      "S4 delivered: delivered 1 (only the outstanding piece)",
      1,
      doneItem.qtyDelivered,
    );
    check("S4 delivered: cancelled stays 1", 1, doneItem.qtyCancelled);
    check(
      "S4 delivered: held 1 (the piece the customer took)",
      1,
      held(doneItem),
    );
    check(
      "S4 delivered ledger",
      "purchase +10, sale -2, cancel +1",
      await ledgerSummary(t, ids.teeM),
    );
    check("S4 delivered stock", 9, await stockOf(t, ids.teeM));
    check("S4 delivered total (1 billed piece)", SALE_PRICE, done.total);
  });

  test("S5 — payment +$6 then refund −$6: paid nets to zero", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const order = await checkout(t, ids, [{ variantId: ids.teeM, qty: 1 }]);
    const saleId = order.sale._id;

    await t.mutation(api.payments.receive, {
      idempotencyKey: requestKey("payment-receive"),
      saleId,
      amount: 600,
      method: "cash",
    });
    await t.mutation(api.payments.refund, {
      idempotencyKey: requestKey("payment-refund"),
      saleId,
      amount: 600,
    });
    const detail = await t.query(api.sales.getDetail, { saleId });
    check("S5 paid nets to 0", 0, detail!.paid);
    check("S5 remaining back to the full total", SALE_PRICE, detail!.remaining);
    check("S5 two payment rows", 2, detail!.payments.length);
    check(
      "S5 amounts +600 / -600",
      "600,-600",
      detail!.payments.map((p) => p.amount).join(","),
    );
  });

  test("S6 — refund again: cannot exceed the net positive balance", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const order = await checkout(t, ids, [{ variantId: ids.teeM, qty: 1 }]);
    const saleId = order.sale._id;

    await t.mutation(api.payments.receive, {
      idempotencyKey: requestKey("payment-receive"),
      saleId,
      amount: 600,
      method: "cash",
    });
    await t.mutation(api.payments.refund, {
      idempotencyKey: requestKey("payment-refund"),
      saleId,
      amount: 600,
    });
    // Invariant 7: the net balance is zero — nothing left to refund.
    const code = await errorCodeOf(
      t.mutation(api.payments.refund, {
        idempotencyKey: requestKey("payment-refund"),
        saleId,
        amount: 600,
      }),
    );
    check(
      "S6 second refund rejected with INVALID_PAYMENT",
      "INVALID_PAYMENT",
      code,
    );
  });

  test("S7 — profit and cash-basis report after return/refund", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const order = await checkout(t, ids, [{ variantId: ids.teeM, qty: 1 }]);
    const saleId = order.sale._id;
    const lineId = order.items[0].item._id;

    await t.mutation(api.sales.setStatus, { saleId, status: "delivered" });
    await t.mutation(api.payments.receive, {
      idempotencyKey: requestKey("payment-receive"),
      saleId,
      amount: SALE_PRICE,
      method: "cash",
    });
    await t.mutation(api.sales.returnItems, {
      saleId,
      returns: [{ saleItemId: lineId, qty: 1 }],
    });
    await t.mutation(api.payments.refund, {
      idempotencyKey: requestKey("payment-refund"),
      saleId,
      amount: SALE_PRICE,
    });

    const detail = (await t.query(api.sales.getDetail, { saleId }))!;
    check("S7 order total 0 (piece returned)", 0, detail.total);
    check("S7 order profit 0 (nothing billed)", 0, detail.profit);
    check("S7 paid 0", 0, detail.paid);

    const day = todayDay();
    const pl = await t.query(api.reports.getPlReport, {
      period: { type: "day", value: day },
    });
    check(`S7 report moneyIn (${day})`, 0, pl.moneyIn);
    check("S7 report refunds", SALE_PRICE, pl.refunds);
    check("S7 report cogs", 0, pl.cogs);
    check("S7 report profit", 0, pl.profit);
    check("S7 report paymentsCount", 2, pl.paymentsCount);
  });
});
