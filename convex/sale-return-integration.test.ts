import { convexTest } from "convex-test";
import { describe, expect, test, vi } from "vitest";

import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import schema from "./schema";

// Integrated return/correction workflow (T12+): the Edit Sale page and the
// guided cancel review resolve held pieces INSIDE the same saveEdit / setStatus
// call — one transaction. This suite verifies the 15 required scenarios:
// direct removal still works, returns (sellable / damaged / still-with /
// delivery-correction) apply atomically with the edit, refunds stay clamped,
// delivered cancellation is guided, retries are idempotent, failures roll
// everything back, and the integrated path writes EXACTLY the same rows as
// the standalone returnItems + payments.refund flow.
//
// Same harness as the other suites: auth is stubbed, everything below
// requireUser runs for real against an in-memory backend.

const AUTH_USER_ID = "test-auth-user";
const STAFF_AUTH_ID = "test-staff-user";

// The signed-in identity is swappable per test (role checks run for real).
const mockAuth = { current: AUTH_USER_ID };

vi.mock("./auth", () => ({
  authComponent: {
    safeGetAuthUser: vi.fn(async () => ({
      _id: mockAuth.current,
      name: mockAuth.current === AUTH_USER_ID ? "Test Owner" : "Test Staff",
      email: mockAuth.current === AUTH_USER_ID ? "owner@test.local" : "staff@test.local",
    })),
  },
}));

const modules = import.meta.glob("./**/*.ts");

type SeedIds = Awaited<ReturnType<typeof seed>>;

/** Same shop/catalog as sale-edit.test.ts (teeM $10.00, 10 on shelf) plus a
 * STAFF user so owner-only corrections can be tested with a real role. */
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
    const staffId = await ctx.db.insert("users", {
      authUserId: STAFF_AUTH_ID,
      name: "Test Staff",
      email: "staff@test.local",
      role: "staff" as const,
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
      code: "P-001",
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
    return { userId, staffId, customerId, channelId, teeM, teeL };
  });
}

async function ledgerRows(
  t: ReturnType<typeof convexTest>,
  variantId: Id<"productVariants">
) {
  return await t.run(async (ctx: MutationCtx) =>
    ctx.db
      .query("stockLedger")
      .withIndex("by_variant_ts", (q) => q.eq("variantId", variantId))
      .collect()
  );
}

async function stockOf(
  t: ReturnType<typeof convexTest>,
  variantId: Id<"productVariants">
) {
  const rows = await ledgerRows(t, variantId);
  return rows.reduce((sum, row) => sum + row.delta, 0);
}

async function ledgerSummary(
  t: ReturnType<typeof convexTest>,
  variantId: Id<"productVariants">
): Promise<string> {
  const rows = await ledgerRows(t, variantId);
  return rows
    .map((r) => `${r.reason} ${r.delta > 0 ? "+" : ""}${r.delta}`)
    .join(", ");
}

async function errorCodeOf(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
    return undefined;
  } catch (err) {
    return (err as { data?: { code?: string } }).data?.code;
  }
}

/** A confirmed order through the real checkout. */
async function checkout(
  t: ReturnType<typeof convexTest>,
  ids: SeedIds,
  lines: { variantId: Id<"productVariants">; qty: number }[],
  extra: { deliveryFee?: number } = {}
) {
  return await t.mutation(api.sales.checkout, {
    customerId: ids.customerId,
    salesChannelId: ids.channelId,
    discount: 0,
    deliveryFee: extra.deliveryFee ?? 0,
    items: lines,
  });
}

/** Record how many pieces the customer actually took (T13 mutation), then
 * mark the order delivered — the real path to a "delivered" order. */
async function deliver(
  t: ReturnType<typeof convexTest>,
  saleId: Id<"sales">,
  deliveredByLine: { saleItemId: Id<"saleItems">; qtyDelivered: number }[]
) {
  await t.mutation(api.sales.setLineDelivered, {
    saleId,
    adjustments: deliveredByLine,
  });
  await t.mutation(api.sales.setStatus, { saleId, status: "delivered" });
}

/** Save through the real sales.saveEdit with resolutions/refund. */
async function edit(
  t: ReturnType<typeof convexTest>,
  saleId: Id<"sales">,
  items: { saleItemId: Id<"saleItems">; qty: number }[],
  extra: {
    expectedVersion?: number;
    resolutions?: {
      saleItemId: Id<"saleItems">;
      outcome:
        | "returned_sellable"
        | "returned_damaged"
        | "still_with_customer"
        | "delivery_incorrect";
      qty: number;
      reason?: string;
    }[];
    refund?: { amount: number; note?: string };
  } = {}
) {
  return await t.mutation(api.sales.saveEdit, { saleId, items, ...extra });
}

/** The order's payment rows (receive + refund live in one table). */
async function paymentsOf(t: ReturnType<typeof convexTest>, saleId: Id<"sales">) {
  return await t.run(async (ctx: MutationCtx) =>
    ctx.db
      .query("payments")
      .withIndex("by_sale", (q) => q.eq("saleId", saleId))
      .collect()
  );
}

/** Chronological event types for the order. */
async function eventTypes(t: ReturnType<typeof convexTest>, saleId: Id<"sales">) {
  const detail = await t.query(api.sales.getDetail, { saleId });
  return detail!.events.map(({ event }) => event.type).reverse();
}

/** The order's edit-version counter (getEditData). */
async function versionOf(t: ReturnType<typeof convexTest>, saleId: Id<"sales">) {
  const data = await t.query(api.sales.getEditData, { saleId });
  return data!.version;
}

describe("integrated returns & corrections (saveEdit / setStatus resolutions)", () => {
  test("1. remove an undelivered line directly (regression)", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const sale = await checkout(t, ids, [{ variantId: ids.teeM, qty: 1 }]);

    const result = await edit(t, sale.sale._id, [{ saleItemId: sale.items[0].item._id, qty: 0 }]);

    expect(await ledgerSummary(t, ids.teeM)).toBe("purchase +10, sale -1, cancel +1");
    expect(await stockOf(t, ids.teeM)).toBe(10);
    expect(await eventTypes(t, sale.sale._id)).toEqual(["created", "item_removed"]);
    expect(result!.total).toBe(0);
  });

  test("2. remove a delivered line via returned_sellable from Edit Sale", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const sale = await checkout(t, ids, [{ variantId: ids.teeM, qty: 1 }]);
    await deliver(t, sale.sale._id, [{ saleItemId: sale.items[0].item._id, qtyDelivered: 1 }]);

    const result = await edit(
      t,
      sale.sale._id,
      [{ saleItemId: sale.items[0].item._id, qty: 0 }],
      {
        resolutions: [
          { saleItemId: sale.items[0].item._id, outcome: "returned_sellable", qty: 1 },
        ],
      }
    );

    // The return went through the shared engine: `return` row, qtyReturned
    // bumped, NO cancel row (the diff is a no-op after the resolution).
    expect(await ledgerSummary(t, ids.teeM)).toBe("purchase +10, sale -1, return +1");
    expect(await stockOf(t, ids.teeM)).toBe(10);
    expect(result!.items[0].item.qtyReturned).toBe(1);
    expect(result!.items[0].item.qtyDelivered).toBe(1); // historical, preserved
    expect(await eventTypes(t, sale.sale._id)).toEqual([
      "created",
      "lines_adjusted",
      "status_changed",
      "items_returned",
    ]);
    expect(result!.total).toBe(0);
  });

  test("3. partial return of a delivered line", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const sale = await checkout(t, ids, [{ variantId: ids.teeM, qty: 3 }]);
    await deliver(t, sale.sale._id, [{ saleItemId: sale.items[0].item._id, qtyDelivered: 3 }]);

    const result = await edit(
      t,
      sale.sale._id,
      [{ saleItemId: sale.items[0].item._id, qty: 2 }],
      {
        resolutions: [
          { saleItemId: sale.items[0].item._id, outcome: "returned_sellable", qty: 1 },
        ],
      }
    );

    expect(await ledgerSummary(t, ids.teeM)).toBe("purchase +10, sale -3, return +1");
    expect(await stockOf(t, ids.teeM)).toBe(8);
    const item = result!.items[0].item;
    expect(item.qtyOrdered).toBe(3); // ordered is never rewritten
    expect(item.qtyReturned).toBe(1);
    expect(result!.total).toBe(2000);
    expect(await eventTypes(t, sale.sale._id)).toEqual([
      "created",
      "lines_adjusted",
      "status_changed",
      "items_returned",
    ]);
  });

  test("4. returned damaged does not enter sellable stock", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const sale = await checkout(t, ids, [{ variantId: ids.teeM, qty: 1 }]);
    await deliver(t, sale.sale._id, [{ saleItemId: sale.items[0].item._id, qtyDelivered: 1 }]);

    const result = await edit(
      t,
      sale.sale._id,
      [{ saleItemId: sale.items[0].item._id, qty: 0 }],
      {
        resolutions: [
          { saleItemId: sale.items[0].item._id, outcome: "returned_damaged", qty: 1 },
        ],
      }
    );

    // return +1 then adjustment −1: the bill drops one piece, the shelf gets
    // nothing — but BOTH movements are recorded.
    expect(await ledgerSummary(t, ids.teeM)).toBe(
      "purchase +10, sale -1, return +1, adjustment -1"
    );
    expect(await stockOf(t, ids.teeM)).toBe(9);
    expect(result!.items[0].item.qtyReturned).toBe(1);
    expect(result!.total).toBe(0);
    const detail = await t.query(api.sales.getDetail, { saleId: sale.sale._id });
    const returned = detail!.events.find(({ event }) => event.type === "items_returned")!;
    expect(returned.event.summary).toContain("damaged");
  });

  test("5. still with customer leaves stock and bill unchanged", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const sale = await checkout(t, ids, [{ variantId: ids.teeM, qty: 2 }]);
    await deliver(t, sale.sale._id, [{ saleItemId: sale.items[0].item._id, qtyDelivered: 2 }]);

    const result = await edit(
      t,
      sale.sale._id,
      [{ saleItemId: sale.items[0].item._id, qty: 2 }],
      {
        resolutions: [
          { saleItemId: sale.items[0].item._id, outcome: "still_with_customer", qty: 2 },
        ],
      }
    );

    expect(await ledgerSummary(t, ids.teeM)).toBe("purchase +10, sale -2");
    expect(await stockOf(t, ids.teeM)).toBe(8);
    expect(result!.total).toBe(2000);
    expect(result!.items[0].item.qtyReturned).toBe(0);
    expect(await eventTypes(t, sale.sale._id)).toEqual([
      "created",
      "lines_adjusted",
      "status_changed",
    ]);
  });

  test("6. delivery_incorrect restores stock exactly once; owner-only", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const sale = await checkout(t, ids, [{ variantId: ids.teeM, qty: 2 }]);
    await deliver(t, sale.sale._id, [{ saleItemId: sale.items[0].item._id, qtyDelivered: 2 }]);
    const lineId = sale.items[0].item._id;
    const resolution = {
      saleItemId: lineId,
      outcome: "delivery_incorrect" as const,
      qty: 2,
      reason: "Door never opened — the door mark was wrong.",
    };

    const result = await edit(t, sale.sale._id, [{ saleItemId: lineId, qty: 0 }], {
      resolutions: [resolution],
    });

    // The correction lowered delivered: the pieces flow back via cancel rows.
    expect(await ledgerSummary(t, ids.teeM)).toBe("purchase +10, sale -2, cancel +2");
    expect(await stockOf(t, ids.teeM)).toBe(10);
    const item = result!.items[0].item;
    expect(item.qtyDelivered).toBe(0);
    expect(item.qtyCancelled).toBe(2);
    const detail = await t.query(api.sales.getDetail, { saleId: sale.sale._id });
    const adjusted = detail!.events.find(({ event }) => event.type === "lines_adjusted")!;
    expect(adjusted.event.payload?.note).toContain("wrong");

    // Stock was restored exactly once — a second identical correction is
    // refused (nothing is held anymore).
    const second = await errorCodeOf(
      edit(t, sale.sale._id, [{ saleItemId: lineId, qty: 0 }], { resolutions: [resolution] })
    );
    expect(second).toBe("RETURN_EXCEEDS_HELD");

    // Staff are forbidden from correcting a delivery mark (on a fresh held
    // order — the corrected one above has nothing held to resolve).
    const sale2 = await checkout(t, ids, [{ variantId: ids.teeM, qty: 2 }]);
    await deliver(t, sale2.sale._id, [
      { saleItemId: sale2.items[0].item._id, qtyDelivered: 2 },
    ]);
    mockAuth.current = STAFF_AUTH_ID;
    const asStaff = await errorCodeOf(
      edit(t, sale2.sale._id, [{ saleItemId: sale2.items[0].item._id, qty: 0 }], {
        resolutions: [{ saleItemId: sale2.items[0].item._id, outcome: "delivery_incorrect", qty: 2, reason: "x" }],
      })
    );
    expect(asStaff).toBe("FORBIDDEN");
    mockAuth.current = AUTH_USER_ID;
  });

  test("7. delivered cancellation with every item returned + full refund", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const sale = await checkout(t, ids, [
      { variantId: ids.teeM, qty: 1 },
      { variantId: ids.teeL, qty: 1 },
    ]);
    await deliver(t, sale.sale._id, [
      { saleItemId: sale.items[0].item._id, qtyDelivered: 1 },
      { saleItemId: sale.items[1].item._id, qtyDelivered: 1 },
    ]);
    await t.mutation(api.payments.receive, {
      saleId: sale.sale._id,
      amount: 2000,
      method: "cash",
    });

    const result = await t.mutation(api.sales.setStatus, {
      saleId: sale.sale._id,
      status: "cancelled",
      resolutions: [
        { saleItemId: sale.items[0].item._id, outcome: "returned_sellable", qty: 1 },
        { saleItemId: sale.items[1].item._id, outcome: "returned_sellable", qty: 1 },
      ],
      refund: { amount: 2000 },
    });

    expect(result!.sale.status).toBe("cancelled");
    expect(await stockOf(t, ids.teeM)).toBe(10);
    expect(await stockOf(t, ids.teeL)).toBe(10);
    const payments = await paymentsOf(t, sale.sale._id);
    expect(payments.map((p) => p.amount)).toEqual([2000, -2000]);
    expect(result!.paid).toBe(0);
    expect(await eventTypes(t, sale.sale._id)).toEqual([
      "created",
      "lines_adjusted",
      "lines_adjusted",
      "status_changed",
      "payment_received",
      "items_returned",
      "items_returned",
      "refund",
      "status_changed",
    ]);
  });

  test("8. delivered cancellation with one item still held is blocked", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const sale = await checkout(t, ids, [{ variantId: ids.teeM, qty: 2 }]);
    await deliver(t, sale.sale._id, [{ saleItemId: sale.items[0].item._id, qtyDelivered: 2 }]);

    const code = await errorCodeOf(
      t.mutation(api.sales.setStatus, {
        saleId: sale.sale._id,
        status: "cancelled",
        resolutions: [
          { saleItemId: sale.items[0].item._id, outcome: "returned_sellable", qty: 1 },
        ],
      })
    );
    expect(code).toBe("CANNOT_CANCEL_HELD");

    // Everything rolled back: the resolution never applied, status unchanged.
    const detail = await t.query(api.sales.getDetail, { saleId: sale.sale._id });
    expect(detail!.sale.status).toBe("delivered");
    expect(detail!.items[0].item.qtyReturned).toBe(0);
    expect(await ledgerSummary(t, ids.teeM)).toBe("purchase +10, sale -2");
    expect(await paymentsOf(t, sale.sale._id)).toHaveLength(0);
  });

  test("9. return with full refund", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const sale = await checkout(t, ids, [{ variantId: ids.teeM, qty: 1 }]);
    await deliver(t, sale.sale._id, [{ saleItemId: sale.items[0].item._id, qtyDelivered: 1 }]);
    await t.mutation(api.payments.receive, {
      saleId: sale.sale._id,
      amount: 1000,
      method: "cash",
    });

    const result = await edit(
      t,
      sale.sale._id,
      [{ saleItemId: sale.items[0].item._id, qty: 0 }],
      {
        resolutions: [
          { saleItemId: sale.items[0].item._id, outcome: "returned_sellable", qty: 1 },
        ],
        refund: { amount: 1000 },
      }
    );

    expect((await paymentsOf(t, sale.sale._id)).map((p) => p.amount)).toEqual([1000, -1000]);
    expect(result!.paid).toBe(0);
    expect(result!.total).toBe(0);
    expect(await eventTypes(t, sale.sale._id)).toEqual([
      "created",
      "lines_adjusted",
      "status_changed",
      "payment_received",
      "items_returned",
      "refund",
    ]);
  });

  test("10. return without refund", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const sale = await checkout(t, ids, [{ variantId: ids.teeM, qty: 1 }]);
    await deliver(t, sale.sale._id, [{ saleItemId: sale.items[0].item._id, qtyDelivered: 1 }]);

    await edit(t, sale.sale._id, [{ saleItemId: sale.items[0].item._id, qty: 0 }], {
      resolutions: [
        { saleItemId: sale.items[0].item._id, outcome: "returned_sellable", qty: 1 },
      ],
    });

    expect(await paymentsOf(t, sale.sale._id)).toHaveLength(0);
    expect(await eventTypes(t, sale.sale._id)).toEqual([
      "created",
      "lines_adjusted",
      "status_changed",
      "items_returned",
    ]);
  });

  test("11. refund greater than paid is rejected and rolls back", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const sale = await checkout(t, ids, [{ variantId: ids.teeM, qty: 1 }]);
    await deliver(t, sale.sale._id, [{ saleItemId: sale.items[0].item._id, qtyDelivered: 1 }]);
    await t.mutation(api.payments.receive, {
      saleId: sale.sale._id,
      amount: 1000,
      method: "cash",
    });

    const code = await errorCodeOf(
      edit(t, sale.sale._id, [{ saleItemId: sale.items[0].item._id, qty: 0 }], {
        resolutions: [
          { saleItemId: sale.items[0].item._id, outcome: "returned_sellable", qty: 1 },
        ],
        refund: { amount: 1001 },
      })
    );
    expect(code).toBe("INVALID_PAYMENT");

    // The whole save rolled back — resolution included.
    const detail = await t.query(api.sales.getDetail, { saleId: sale.sale._id });
    expect(detail!.items[0].item.qtyReturned).toBe(0);
    expect(await ledgerSummary(t, ids.teeM)).toBe("purchase +10, sale -1");
    expect((await paymentsOf(t, sale.sale._id)).map((p) => p.amount)).toEqual([1000]);
    expect(await versionOf(t, sale.sale._id)).toBe(0);
  });

  test("12. keep the delivery charge after cancellation", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const sale = await checkout(t, ids, [{ variantId: ids.teeM, qty: 1 }], {
      deliveryFee: 500,
    });
    await deliver(t, sale.sale._id, [{ saleItemId: sale.items[0].item._id, qtyDelivered: 1 }]);

    const result = await t.mutation(api.sales.setStatus, {
      saleId: sale.sale._id,
      status: "cancelled",
      resolutions: [
        { saleItemId: sale.items[0].item._id, outcome: "returned_sellable", qty: 1 },
      ],
      chargeDeliveryFee: true,
    });

    expect(result!.sale.status).toBe("cancelled");
    expect(result!.sale.chargeDeliveryOnCancel).toBe(true);
    // The trip is billed, the goods are not: total = shipping fee only.
    expect(result!.total).toBe(500);
    expect(result!.remaining).toBe(500);
    expect(await stockOf(t, ids.teeM)).toBe(10);
  });

  test("13. double-click / retry never duplicates rows", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const sale = await checkout(t, ids, [{ variantId: ids.teeM, qty: 1 }]);
    await deliver(t, sale.sale._id, [{ saleItemId: sale.items[0].item._id, qtyDelivered: 1 }]);
    await t.mutation(api.payments.receive, {
      saleId: sale.sale._id,
      amount: 1000,
      method: "cash",
    });
    const payload = {
      saleId: sale.sale._id,
      expectedVersion: 0,
      items: [{ saleItemId: sale.items[0].item._id, qty: 0 }],
      resolutions: [
        {
          saleItemId: sale.items[0].item._id,
          outcome: "returned_sellable" as const,
          qty: 1,
        },
      ],
      refund: { amount: 1000 },
    };

    await t.mutation(api.sales.saveEdit, payload);
    const second = await errorCodeOf(t.mutation(api.sales.saveEdit, payload));
    expect(second).toBe("STALE_EDIT");

    expect(await ledgerSummary(t, ids.teeM)).toBe("purchase +10, sale -1, return +1");
    expect((await paymentsOf(t, sale.sale._id)).map((p) => p.amount)).toEqual([1000, -1000]);
    expect(await eventTypes(t, sale.sale._id)).toEqual([
      "created",
      "lines_adjusted",
      "status_changed",
      "payment_received",
      "items_returned",
      "refund",
    ]);
  });

  test("14. failure halfway through rolls everything back", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const sale = await checkout(t, ids, [{ variantId: ids.teeM, qty: 1 }]);
    await deliver(t, sale.sale._id, [{ saleItemId: sale.items[0].item._id, qtyDelivered: 1 }]);
    const lineId = sale.items[0].item._id;

    // The resolutions apply first (writes!), then the diff breaks the
    // delivered-line lock — the single transaction must roll the returns
    // back with the failed edit.
    const code = await errorCodeOf(
      t.mutation(api.sales.saveEdit, {
        saleId: sale.sale._id,
        items: [{ saleItemId: lineId, qty: 3 }],
        resolutions: [{ saleItemId: lineId, outcome: "returned_sellable", qty: 1 }],
        refund: { amount: 1000 },
      })
    );
    // The refund is checked right after the resolutions (before the diff),
    // and nothing was paid yet — the whole save must roll back either way.
    expect(code).toBe("INVALID_PAYMENT");

    const detail = await t.query(api.sales.getDetail, { saleId: sale.sale._id });
    expect(detail!.items[0].item.qtyReturned).toBe(0);
    expect(await ledgerSummary(t, ids.teeM)).toBe("purchase +10, sale -1");
    expect(await paymentsOf(t, sale.sale._id)).toHaveLength(0);
    expect(await versionOf(t, sale.sale._id)).toBe(0);
  });

  test("15. integrated flow and standalone return flow produce identical rows", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);

    // Sale A: the Edit Sale page (saveEdit with resolutions + refund).
    const saleA = await checkout(t, ids, [{ variantId: ids.teeM, qty: 1 }]);
    await deliver(t, saleA.sale._id, [{ saleItemId: saleA.items[0].item._id, qtyDelivered: 1 }]);
    await t.mutation(api.payments.receive, {
      saleId: saleA.sale._id,
      amount: 1000,
      method: "cash",
    });
    await edit(t, saleA.sale._id, [{ saleItemId: saleA.items[0].item._id, qty: 0 }], {
      resolutions: [
        { saleItemId: saleA.items[0].item._id, outcome: "returned_sellable", qty: 1 },
      ],
      refund: { amount: 1000 },
    });

    // Sale B: the standalone flow (returnItems + payments.refund).
    const saleB = await checkout(t, ids, [{ variantId: ids.teeM, qty: 1 }]);
    await deliver(t, saleB.sale._id, [{ saleItemId: saleB.items[0].item._id, qtyDelivered: 1 }]);
    await t.mutation(api.payments.receive, {
      saleId: saleB.sale._id,
      amount: 1000,
      method: "cash",
    });
    await t.mutation(api.sales.returnItems, {
      saleId: saleB.sale._id,
      returns: [{ saleItemId: saleB.items[0].item._id, qty: 1 }],
    });
    await t.mutation(api.payments.refund, { saleId: saleB.sale._id, amount: 1000 });

    // Identical stock, ledger, payments, events, and money — the integrated
    // path reuses the exact same engine (version counters excluded).
    expect(await stockOf(t, ids.teeM)).toBe(10);
    expect(await ledgerSummary(t, ids.teeM)).toBe(
      "purchase +10, sale -1, return +1, sale -1, return +1"
    );
    expect((await paymentsOf(t, saleA.sale._id)).map((p) => p.amount)).toEqual([1000, -1000]);
    expect((await paymentsOf(t, saleB.sale._id)).map((p) => p.amount)).toEqual([1000, -1000]);
    expect(await eventTypes(t, saleA.sale._id)).toEqual(await eventTypes(t, saleB.sale._id));
    const detailA = await t.query(api.sales.getDetail, { saleId: saleA.sale._id });
    const detailB = await t.query(api.sales.getDetail, { saleId: saleB.sale._id });
    expect(detailA!.total).toBe(detailB!.total);
    expect(detailA!.paid).toBe(detailB!.paid);
    expect(detailA!.remaining).toBe(detailB!.remaining);
  });
});

describe("persisted returns on the Edit Sale page (regression: undo reactivation + stock projection)", () => {
  /** Everything the edit page sees for the order's lines. */
  async function editDataOf(t: ReturnType<typeof convexTest>, saleId: Id<"sales">) {
    const data = await t.query(api.sales.getEditData, { saleId });
    expect(data).not.toBeNull();
    return data!;
  }

  test("16. a saved return reloads as immutable history (sellable)", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const sale = await checkout(t, ids, [{ variantId: ids.teeM, qty: 1 }]);
    await deliver(t, sale.sale._id, [{ saleItemId: sale.items[0].item._id, qtyDelivered: 1 }]);
    await edit(
      t,
      sale.sale._id,
      [{ saleItemId: sale.items[0].item._id, qty: 0 }],
      { resolutions: [{ saleItemId: sale.items[0].item._id, outcome: "returned_sellable", qty: 1 }] }
    );

    // The line opens as history: bills nothing, the ledger says it came back,
    // and the shelf projection starts from the CURRENT stock (10) — the
    // returned piece is already in it and is NEVER added a second time.
    const data = await editDataOf(t, sale.sale._id);
    expect(data.items[0].billedQty).toBe(0);
    expect(data.items[0].returnedOutcome).toBe("sellable");
    expect(data.items[0].stock).toBe(10);
    expect(data.items[0].maxQty).toBe(10);
    expect(data.items[0].item.qtyReturned).toBe(1);
    expect(data.items[0].item.qtyDelivered).toBe(1); // historical, preserved
  });

  test("17. resaving the page as-is is a clean no-op — no ledger rows, no events", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const sale = await checkout(t, ids, [{ variantId: ids.teeM, qty: 1 }]);
    await deliver(t, sale.sale._id, [{ saleItemId: sale.items[0].item._id, qtyDelivered: 1 }]);
    await edit(
      t,
      sale.sale._id,
      [{ saleItemId: sale.items[0].item._id, qty: 0 }],
      { resolutions: [{ saleItemId: sale.items[0].item._id, outcome: "returned_sellable", qty: 1 }] }
    );
    const version = await versionOf(t, sale.sale._id);
    const eventsBefore = await eventTypes(t, sale.sale._id);

    const result = await edit(
      t,
      sale.sale._id,
      [{ saleItemId: sale.items[0].item._id, qty: 0 }],
      { expectedVersion: version }
    );

    // Nothing moved: same ledger rows, same stock, same events, same line.
    expect(await ledgerSummary(t, ids.teeM)).toBe("purchase +10, sale -1, return +1");
    expect(await stockOf(t, ids.teeM)).toBe(10);
    expect(await eventTypes(t, sale.sale._id)).toEqual(eventsBefore);
    expect(result!.items[0].item.qtyReturned).toBe(1);
    expect(result!.items[0].item.qtyDelivered).toBe(1);
  });

  test("18. a persisted return cannot be reactivated on a delivered order", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const sale = await checkout(t, ids, [{ variantId: ids.teeM, qty: 1 }]);
    await deliver(t, sale.sale._id, [{ saleItemId: sale.items[0].item._id, qtyDelivered: 1 }]);
    await edit(
      t,
      sale.sale._id,
      [{ saleItemId: sale.items[0].item._id, qty: 0 }],
      { resolutions: [{ saleItemId: sale.items[0].item._id, outcome: "returned_sellable", qty: 1 }] }
    );

    // A stale/tampered client re-sends the returned line as an active line.
    const code = await errorCodeOf(
      edit(t, sale.sale._id, [{ saleItemId: sale.items[0].item._id, qty: 1 }])
    );
    expect(code).toBe("DELIVERED_LOCKED_LINES");
    // The refusal wrote nothing.
    expect(await ledgerSummary(t, ids.teeM)).toBe("purchase +10, sale -1, return +1");
    expect(await stockOf(t, ids.teeM)).toBe(10);
  });

  test("19. a persisted return cannot be reactivated after the delivered mark is corrected", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const sale = await checkout(t, ids, [{ variantId: ids.teeM, qty: 1 }]);
    await deliver(t, sale.sale._id, [{ saleItemId: sale.items[0].item._id, qtyDelivered: 1 }]);
    await edit(
      t,
      sale.sale._id,
      [{ saleItemId: sale.items[0].item._id, qty: 0 }],
      { resolutions: [{ saleItemId: sale.items[0].item._id, outcome: "returned_sellable", qty: 1 }] }
    );
    // The only way a delivered order re-opens: the mark was a mistake.
    await t.mutation(api.sales.setStatus, { saleId: sale.sale._id, status: "partially_delivered" });

    // On the now-unlocked order the returned line must still refuse to come
    // back — the guard lives on the RETURNED state, not the delivered lock.
    const code = await errorCodeOf(
      edit(t, sale.sale._id, [{ saleItemId: sale.items[0].item._id, qty: 1 }])
    );
    expect(code).toBe("INVALID_QTY");
    expect(await ledgerSummary(t, ids.teeM)).toBe("purchase +10, sale -1, return +1");
    expect(await stockOf(t, ids.teeM)).toBe(10);
  });

  test("20. a partially-returned line cannot be raised above its post-return billed qty", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const sale = await checkout(t, ids, [{ variantId: ids.teeM, qty: 2 }]);
    await deliver(t, sale.sale._id, [{ saleItemId: sale.items[0].item._id, qtyDelivered: 2 }]);
    await edit(
      t,
      sale.sale._id,
      [{ saleItemId: sale.items[0].item._id, qty: 1 }],
      { resolutions: [{ saleItemId: sale.items[0].item._id, outcome: "returned_sellable", qty: 1 }] }
    );
    expect(await stockOf(t, ids.teeM)).toBe(9); // 10 − 2 + 1
    await t.mutation(api.sales.setStatus, { saleId: sale.sale._id, status: "partially_delivered" });

    // One piece returned → billedOld is 1 → raising back to 2 is a second
    // billing of the returned piece (the ledger return row is immutable).
    const code = await errorCodeOf(
      edit(t, sale.sale._id, [{ saleItemId: sale.items[0].item._id, qty: 2 }])
    );
    expect(code).toBe("INVALID_QTY");
    expect(await ledgerSummary(t, ids.teeM)).toBe("purchase +10, sale -2, return +1");
    expect(await stockOf(t, ids.teeM)).toBe(9);
  });

  test("21. the customer gets the returned item again as a NEW line — one deduction, history intact", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const sale = await checkout(t, ids, [{ variantId: ids.teeM, qty: 1 }]);
    await deliver(t, sale.sale._id, [{ saleItemId: sale.items[0].item._id, qtyDelivered: 1 }]);
    await edit(
      t,
      sale.sale._id,
      [{ saleItemId: sale.items[0].item._id, qty: 0 }],
      { resolutions: [{ saleItemId: sale.items[0].item._id, outcome: "returned_sellable", qty: 1 }] }
    );
    const version = await versionOf(t, sale.sale._id);

    const result = await t.mutation(api.sales.saveEdit, {
      saleId: sale.sale._id,
      expectedVersion: version,
      items: [
        { saleItemId: sale.items[0].item._id, qty: 0 },
        { variantId: ids.teeM, qty: 1, fulfillment: "handed_now" },
      ],
    });

    // The new line deducts current stock EXACTLY once (the returned piece is
    // already back on the shelf, so stock goes 10 → 9 — never 8).
    expect(await ledgerSummary(t, ids.teeM)).toBe("purchase +10, sale -1, return +1, sale -1");
    expect(await stockOf(t, ids.teeM)).toBe(9);
    // A NEW saleItem identity — never a merge with the historical line.
    expect(result!.items).toHaveLength(2);
    const original = result!.items.find((i) => i.item._id === sale.items[0].item._id)!;
    const added = result!.items.find((i) => i.item._id !== sale.items[0].item._id)!;
    expect(original.item.qtyReturned).toBe(1); // history preserved, untouched
    expect(original.item.qtyDelivered).toBe(1);
    expect(original.item.qtyOrdered).toBe(1);
    expect(added.item.qtyOrdered).toBe(1);
    expect(added.item.variantId).toBe(ids.teeM);
    expect(added.item.unitCostSnapshot).toBe(400); // current weighted average
    // Event SET (not order): saleEvents sharing one millisecond tie-break by
    // random _id, so cross-mutation order within a ms is nondeterministic —
    // this test pins what matters: every event exists exactly once, including
    // the historical items_returned (nothing was rewritten) and item_added.
    expect((await eventTypes(t, sale.sale._id)).sort()).toEqual(
      ["created", "lines_adjusted", "status_changed", "items_returned", "item_added"].sort()
    );
  });

  test("22. a stale edit-window save is refused and duplicates nothing", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const sale = await checkout(t, ids, [{ variantId: ids.teeM, qty: 1 }]);
    await deliver(t, sale.sale._id, [{ saleItemId: sale.items[0].item._id, qtyDelivered: 1 }]);
    const version = await versionOf(t, sale.sale._id);

    await edit(
      t,
      sale.sale._id,
      [{ saleItemId: sale.items[0].item._id, qty: 0 }],
      {
        expectedVersion: version,
        resolutions: [{ saleItemId: sale.items[0].item._id, outcome: "returned_sellable", qty: 1 }],
      }
    );

    // The same save retried with the OLD version — the order moved on.
    const code = await errorCodeOf(
      edit(t, sale.sale._id, [{ saleItemId: sale.items[0].item._id, qty: 0 }], {
        expectedVersion: version,
        resolutions: [{ saleItemId: sale.items[0].item._id, outcome: "returned_sellable", qty: 1 }],
      })
    );
    expect(code).toBe("STALE_EDIT");
    // The retry wrote nothing: still exactly one return row, one item_returned.
    expect(await ledgerSummary(t, ids.teeM)).toBe("purchase +10, sale -1, return +1");
    expect((await eventTypes(t, sale.sale._id)).filter((e) => e === "items_returned")).toEqual([
      "items_returned",
    ]);
    expect(await stockOf(t, ids.teeM)).toBe(10);
  });

  test("23. edit data projects the shelf for a partially-returned line", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const sale = await checkout(t, ids, [{ variantId: ids.teeM, qty: 3 }]);
    await deliver(t, sale.sale._id, [{ saleItemId: sale.items[0].item._id, qtyDelivered: 3 }]);
    await edit(
      t,
      sale.sale._id,
      [{ saleItemId: sale.items[0].item._id, qty: 2 }],
      { resolutions: [{ saleItemId: sale.items[0].item._id, outcome: "returned_sellable", qty: 1 }] }
    );

    const data = await editDataOf(t, sale.sale._id);
    // 2 still billed, 1 returned: stock 8 already holds the returned piece.
    expect(data.items[0].billedQty).toBe(2);
    expect(data.items[0].stock).toBe(8);
    expect(data.items[0].maxQty).toBe(10);
    expect(data.items[0].returnedOutcome).toBe("sellable");
  });

  test("24. a damaged persisted return reads as Damaged and nets stock to zero", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const sale = await checkout(t, ids, [{ variantId: ids.teeM, qty: 1 }]);
    await deliver(t, sale.sale._id, [{ saleItemId: sale.items[0].item._id, qtyDelivered: 1 }]);
    await edit(
      t,
      sale.sale._id,
      [{ saleItemId: sale.items[0].item._id, qty: 0 }],
      { resolutions: [{ saleItemId: sale.items[0].item._id, outcome: "returned_damaged", qty: 1 }] }
    );

    const data = await editDataOf(t, sale.sale._id);
    expect(data.items[0].billedQty).toBe(0);
    expect(data.items[0].returnedOutcome).toBe("damaged"); // damaged wins
    expect(data.items[0].stock).toBe(9); // 10 − 1 + 1 − 1 — the shelf got nothing
  });

  test("25. raising an undelivered line beyond the shelf is refused by the aggregate check", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const sale = await checkout(t, ids, [{ variantId: ids.teeM, qty: 8 }]);

    // 2 on the shelf (10 − 8); asking for 5 more must fail — even though no
    // single line's input cap catches it, the variant-level check does.
    const code = await errorCodeOf(
      edit(t, sale.sale._id, [{ saleItemId: sale.items[0].item._id, qty: 13 }])
    );
    expect(code).toBe("OUT_OF_STOCK");
    expect(await ledgerSummary(t, ids.teeM)).toBe("purchase +10, sale -8");
    expect(await stockOf(t, ids.teeM)).toBe(2);
  });
});
