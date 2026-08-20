import { convexTest } from "convex-test";
import { describe, expect, test, vi } from "vitest";

import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

const AUTH_USER_ID = "test-auth-user";

// Sign-in is the ONE thing faked here (same stub as sales.test.ts): the
// better-auth Convex component has no in-memory equivalent, so it always
// returns the same signed-in identity. Everything below stays real —
// requireUser still looks the staff row up by authUserId.
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

/** A shop with "Basic Tee" (hasColors: M/Black, M/White, L/Black), a received
 * purchase "P-001" that put 10 × M/Black on the shelf, a customer + channel to
 * run a real checkout, and a second product that never moved any stock. */
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
    const productId = await ctx.db.insert("products", {
      name: "Basic Tee",
      nameLower: "basic tee",
      defaultPrice: 1000,
      defaultCost: 400,
      hasColors: true,
      sizes: ["M", "L"],
      colors: ["Black", "White"],
      active: true,
    });
    const variantMB = await ctx.db.insert("productVariants", {
      productId,
      size: "M",
      color: "Black",
      active: true,
    });
    const variantMW = await ctx.db.insert("productVariants", {
      productId,
      size: "M",
      color: "White",
      active: true,
    });
    const variantLB = await ctx.db.insert("productVariants", {
      productId,
      size: "L",
      color: "Black",
      active: true,
    });

    // A product that never moved — its variants carry no lastMovementTs.
    const quietProductId = await ctx.db.insert("products", {
      name: "Never Moved",
      nameLower: "never moved",
      defaultPrice: 500,
      defaultCost: 200,
      hasColors: false,
      sizes: ["M"],
      colors: [],
      active: true,
    });
    const quietVariant = await ctx.db.insert("productVariants", {
      productId: quietProductId,
      size: "M",
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
    const purchaseItemId = await ctx.db.insert("purchaseItems", {
      purchaseId,
      variantId: variantMB,
      qty: 10,
      unitCost: 400,
    });
    await ctx.db.insert("stockLedger", {
      variantId: variantMB,
      delta: 10,
      reason: "purchase" as const,
      purchaseItemId,
      userId,
      ts: now,
    });

    return {
      userId,
      customerId,
      channelId,
      productId,
      variantMB,
      variantMW,
      variantLB,
      quietProductId,
      quietVariant,
      purchaseId,
      purchaseItemId,
      now,
    };
  });
}

/** A direct ledger insert — the test authors movement history by hand. */
async function insertMovement(
  t: ReturnType<typeof convexTest>,
  ids: Awaited<ReturnType<typeof seed>>,
  fields: {
    variantId: Id<"productVariants">;
    delta: number;
    reason: "purchase" | "sale" | "return" | "adjustment";
    ts: number;
    purchaseItemId?: Id<"purchaseItems">;
  }
) {
  return await t.run(async (ctx) => {
    return await ctx.db.insert("stockLedger", {
      variantId: fields.variantId,
      delta: fields.delta,
      reason: fields.reason,
      userId: ids.userId,
      ts: fields.ts,
      ...(fields.purchaseItemId !== undefined
        ? { purchaseItemId: fields.purchaseItemId }
        : {}),
    });
  });
}

describe("stock.list / stock.getProduct — lastMovementTs", () => {
  test("exposes the newest movement time and omits it for never-moved variants", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);

    const list = await t.query(api.stock.list, {
      paginationOpts: { numItems: 10, cursor: null },
    });
    const tee = list.page.find((p) => p.product._id === ids.productId)!;
    expect(tee).toBeDefined();

    const mb = tee.variants.find((v) => v.variant._id === ids.variantMB)!;
    expect(mb.qty).toBe(10);
    expect(mb.lastMovementTs).toBe(ids.now); // the purchase movement time
    // Never-moved variants have no movement time at all (absent, not null).
    const mw = tee.variants.find((v) => v.variant._id === ids.variantMW)!;
    expect(mw.qty).toBe(0);
    expect(mw.lastMovementTs).toBeUndefined();
    const lb = tee.variants.find((v) => v.variant._id === ids.variantLB)!;
    expect(lb.lastMovementTs).toBeUndefined();

    const quiet = await t.query(api.stock.getProduct, {
      productId: ids.quietProductId,
    });
    expect(quiet).not.toBeNull();
    expect(quiet!.variants).toHaveLength(1);
    expect(quiet!.variants[0].lastMovementTs).toBeUndefined();
  });
});

describe("stock.variantHistory", () => {
  test("returns newest first with the balance after each movement", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    // M/White history (newest → oldest): −2 sale, +5 return, −3 adjustment,
    // and a +10 purchase behind them all → current stock 10.
    const purchaseItemId = await t.run(async (ctx) => {
      return await ctx.db.insert("purchaseItems", {
        purchaseId: ids.purchaseId,
        variantId: ids.variantMW,
        qty: 10,
        unitCost: 400,
      });
    });
    await insertMovement(t, ids, {
      variantId: ids.variantMW,
      delta: 10,
      reason: "purchase",
      ts: ids.now - 4000,
      purchaseItemId,
    });
    await insertMovement(t, ids, {
      variantId: ids.variantMW,
      delta: -3,
      reason: "adjustment",
      ts: ids.now - 3000,
    });
    await insertMovement(t, ids, {
      variantId: ids.variantMW,
      delta: 5,
      reason: "return",
      ts: ids.now - 2000,
    });
    await insertMovement(t, ids, {
      variantId: ids.variantMW,
      delta: -2,
      reason: "sale",
      ts: ids.now - 1000,
    });

    const history = await t.query(api.stock.variantHistory, {
      variantId: ids.variantMW,
      paginationOpts: { numItems: 10, cursor: null },
    });

    expect(history.total).toBe(4);
    expect(history.page.map((r) => r.row.delta)).toEqual([-2, 5, -3, 10]);
    // Balance AFTER each movement: current stock 10, then walking back.
    expect(history.page.map((r) => r.balance)).toEqual([10, 12, 7, 10]);
  });

  test("keeps balances exact when a reason filter hides rows", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    await insertMovement(t, ids, {
      variantId: ids.variantLB,
      delta: 3,
      reason: "adjustment",
      ts: ids.now - 3000,
    });
    await insertMovement(t, ids, {
      variantId: ids.variantLB,
      delta: 5,
      reason: "return",
      ts: ids.now - 2000,
    });
    await insertMovement(t, ids, {
      variantId: ids.variantLB,
      delta: -2,
      reason: "sale",
      ts: ids.now - 1000,
    });

    // Current stock 6; the return row's balance must be computed on the
    // UNFILTERED walk (6 − (−2) = 8), not from the visible rows alone.
    const filtered = await t.query(api.stock.variantHistory, {
      variantId: ids.variantLB,
      reason: "return",
      paginationOpts: { numItems: 10, cursor: null },
    });
    expect(filtered.total).toBe(1);
    expect(filtered.page[0].row.delta).toBe(5);
    expect(filtered.page[0].balance).toBe(8);
  });

  test("filters by shop-timezone day boundaries, inclusive", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    // Shop tz is Asia/Phnom_Penh (UTC+7). Aug 10 00:00 local = Aug 9 17:00 UTC.
    const localAug10Morning = Date.UTC(2026, 7, 10, 4, 0); // Aug 10 11:00 local
    const localAug10PastMidnight = Date.UTC(2026, 7, 9, 17, 30); // Aug 10 00:30 local
    const localAug9Evening = Date.UTC(2026, 7, 9, 16, 59); // Aug 9 23:59 local
    await insertMovement(t, ids, {
      variantId: ids.variantLB,
      delta: 1,
      reason: "sale",
      ts: localAug10Morning,
    });
    await insertMovement(t, ids, {
      variantId: ids.variantLB,
      delta: 2,
      reason: "sale",
      ts: localAug10PastMidnight,
    });
    await insertMovement(t, ids, {
      variantId: ids.variantLB,
      delta: 3,
      reason: "sale",
      ts: localAug9Evening,
    });

    const fromAug10 = await t.query(api.stock.variantHistory, {
      variantId: ids.variantLB,
      fromDay: "2026-08-10",
      paginationOpts: { numItems: 10, cursor: null },
    });
    // Both Aug 10 local rows; the 23:59 Aug 9 row is out (that boundary is
    // the shop's midnight, not UTC midnight).
    expect(fromAug10.total).toBe(2);

    const toAug9 = await t.query(api.stock.variantHistory, {
      variantId: ids.variantLB,
      toDay: "2026-08-09",
      paginationOpts: { numItems: 10, cursor: null },
    });
    expect(toAug9.total).toBe(1);
    expect(toAug9.page[0].row.ts).toBe(localAug9Evening);
  });

  test("rejects malformed day strings", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    await expect(
      t.query(api.stock.variantHistory, {
        variantId: ids.variantMB,
        fromDay: "10-08-2026",
        paginationOpts: { numItems: 10, cursor: null },
      })
    ).rejects.toThrow();
  });

  test("resolves order and purchase references; adjustments have none", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    // A real checkout writes the saleItemId → sale reference itself.
    const sale = await t.mutation(api.sales.checkout, {
      customerId: ids.customerId,
      salesChannelId: ids.channelId,
      discount: 0,
      deliveryFee: 0,
      items: [{ variantId: ids.variantMB, qty: 1 }],
    });
    await insertMovement(t, ids, {
      variantId: ids.variantMB,
      delta: 2,
      reason: "adjustment",
      ts: ids.now + 1000,
    });

    const history = await t.query(api.stock.variantHistory, {
      variantId: ids.variantMB,
      paginationOpts: { numItems: 10, cursor: null },
    });

    expect(history.total).toBe(3);
    const [adjustment, saleRow, purchase] = history.page;
    expect(adjustment.reference).toBeUndefined();
    // The reference now carries the linked ids + names for the viewer.
    expect(saleRow.reference).toEqual({
      kind: "order",
      code: sale.sale.code,
      saleId: sale.sale._id,
      customerName: "Dara",
      channelName: "Facebook",
    });
    expect(purchase.reference).toEqual({
      kind: "po",
      code: "P-001",
      purchaseId: expect.any(String),
      supplierName: "Supplier",
      unitCost: 400,
    });
  });

  test("pages by offset with an opaque cursor", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    for (let i = 0; i < 4; i++) {
      await insertMovement(t, ids, {
        variantId: ids.variantLB,
        delta: 1,
        reason: "sale",
        ts: ids.now - (i + 1) * 1000,
      });
    }

    const first = await t.query(api.stock.variantHistory, {
      variantId: ids.variantLB,
      paginationOpts: { numItems: 2, cursor: null },
    });
    expect(first.page).toHaveLength(2);
    expect(first.total).toBe(4);
    expect(first.continueCursor).toBe("offset:2");

    const second = await t.query(api.stock.variantHistory, {
      variantId: ids.variantLB,
      paginationOpts: { numItems: 2, cursor: first.continueCursor },
    });
    expect(second.page).toHaveLength(2);
    expect(second.continueCursor).toBe("");
    // No overlap: the two pages carry all four rows between them.
    const firstIds = new Set(first.page.map((r) => r.row._id));
    expect(second.page.every((r) => !firstIds.has(r.row._id))).toBe(true);
  });

  test("returns an empty page for a variant with no movements", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);

    const history = await t.query(api.stock.variantHistory, {
      variantId: ids.quietVariant,
      paginationOpts: { numItems: 10, cursor: null },
    });
    expect(history.page).toEqual([]);
    expect(history.total).toBe(0);
    expect(history.continueCursor).toBe("");
  });
});
