import { convexTest } from "convex-test";
import { describe, expect, test, vi } from "vitest";

import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { dayString } from "./helpers";
import schema from "./schema";

const AUTH_USER_ID = "purchase-test-owner";
let requestSequence = 0;

function requestKey(operation: string) {
  requestSequence += 1;
  return `${operation}-${requestSequence}`;
}

vi.mock("./auth", () => ({
  authComponent: {
    safeGetAuthUser: async () => ({
      _id: AUTH_USER_ID,
      name: "Purchase Test Owner",
      email: "purchases@test.local",
    }),
  },
}));

const modules = import.meta.glob("./**/*.ts");

async function seed(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx: MutationCtx) => {
    await ctx.db.insert("shop", {
      name: "Purchase Test Shop",
      currency: "USD",
      exchangeRate: 4000,
      timezone: "Asia/Phnom_Penh",
      deliveryEnabled: false,
      language: "en" as const,
    });
    const userId = await ctx.db.insert("users", {
      authUserId: AUTH_USER_ID,
      name: "Purchase Test Owner",
      email: "purchases@test.local",
      role: "owner" as const,
      active: true,
    });
    const supplierId = await ctx.db.insert("suppliers", {
      name: "Active Supplier",
      nameLower: "active supplier",
      active: true,
    });
    const inactiveSupplierId = await ctx.db.insert("suppliers", {
      name: "Inactive Supplier",
      nameLower: "inactive supplier",
      active: false,
    });
    const productId = await ctx.db.insert("products", {
      name: "Test Shirt",
      nameLower: "test shirt",
      defaultPrice: 1500,
      defaultCost: 600,
      hasColors: false,
      sizes: ["M", "L", "XL"],
      colors: [],
      active: true,
    });
    const variantM = await ctx.db.insert("productVariants", {
      productId,
      size: "M",
      active: true,
    });
    const variantL = await ctx.db.insert("productVariants", {
      productId,
      size: "L",
      active: true,
    });
    const inactiveVariant = await ctx.db.insert("productVariants", {
      productId,
      size: "XL",
      active: false,
    });
    return {
      userId,
      supplierId,
      inactiveSupplierId,
      productId,
      variantM,
      variantL,
      inactiveVariant,
    };
  });
}

const purchaseDay = () => Date.now() - 3 * 24 * 60 * 60 * 1000;

type Seed = Awaited<ReturnType<typeof seed>>;

async function createPurchase(
  t: ReturnType<typeof convexTest>,
  ids: Seed,
  options: {
    receivedAt?: number;
    deliveryCost?: number;
    otherCost?: number;
    lines?: { variantId: Id<"productVariants">; qty: number; unitCost: number }[];
  } = {}
) {
  const purchasedAt = purchaseDay();
  const purchase = await t.mutation(api.purchases.create, {
    idempotencyKey: requestKey("purchase-create"),
    supplierId: ids.supplierId,
    purchasedAt,
    ...(options.receivedAt !== undefined ? { receivedAt: options.receivedAt } : {}),
    ...(options.deliveryCost !== undefined ? { deliveryCost: options.deliveryCost } : {}),
    ...(options.otherCost !== undefined ? { otherCost: options.otherCost } : {}),
    lines: options.lines ?? [{ variantId: ids.variantM, qty: 5, unitCost: 600 }],
  });
  return { purchase, purchasedAt };
}

/** Stock is independently re-derived from the source-of-truth ledger. */
async function deriveStockFromLedger(
  t: ReturnType<typeof convexTest>,
  variantId: Id<"productVariants">
) {
  return await t.run(async (ctx: MutationCtx) => {
    const movements = await ctx.db
      .query("stockLedger")
      .withIndex("by_variant_ts", (q) => q.eq("variantId", variantId))
      .collect();
    return movements.reduce((stock, movement) => stock + movement.delta, 0);
  });
}

async function purchaseState(
  t: ReturnType<typeof convexTest>,
  purchaseId: Id<"purchases">
) {
  return await t.run(async (ctx: MutationCtx) => {
    const purchase = await ctx.db.get(purchaseId);
    const items = await ctx.db
      .query("purchaseItems")
      .withIndex("by_purchase", (q) => q.eq("purchaseId", purchaseId))
      .collect();
    const movements = (
      await Promise.all(
        items.map((item) =>
          ctx.db
            .query("stockLedger")
            .withIndex("by_purchaseItem", (q) => q.eq("purchaseItemId", item._id))
            .collect()
        )
      )
    ).flat();
    return { purchase, items, movements };
  });
}

async function consumeStock(
  t: ReturnType<typeof convexTest>,
  variantId: Id<"productVariants">,
  qty: number
) {
  await t.mutation(api.adjustments.adjustStock, {
    idempotencyKey: requestKey("stock-adjustment"),
    variantId,
    delta: -qty,
    note: "Downstream stock use",
  });
}

describe("purchases.create", () => {
  test("a draft creates items but no stock movements", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const { purchase } = await createPurchase(t, ids);
    const state = await purchaseState(t, purchase._id);

    expect(purchase.status).toBe("draft");
    expect(state.items).toHaveLength(1);
    expect(state.movements).toEqual([]);
    expect(await deriveStockFromLedger(t, ids.variantM)).toBe(0);
  });

  test("a received purchase writes one exact linked movement per item", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const receivedAt = purchaseDay() + 1000;
    const { purchase } = await createPurchase(t, ids, {
      receivedAt,
      lines: [
        { variantId: ids.variantM, qty: 5, unitCost: 600 },
        { variantId: ids.variantL, qty: 3, unitCost: 700 },
      ],
    });
    const state = await purchaseState(t, purchase._id);

    expect(purchase.status).toBe("received");
    expect(state.movements).toHaveLength(2);
    for (const item of state.items) {
      expect(state.movements).toContainEqual(
        expect.objectContaining({
          variantId: item.variantId,
          delta: item.qty,
          reason: "purchase",
          purchaseItemId: item._id,
          userId: ids.userId,
          ts: receivedAt,
          note: `Purchase ${purchase.code}`,
        })
      );
    }
    expect(await deriveStockFromLedger(t, ids.variantM)).toBe(5);
    expect(await deriveStockFromLedger(t, ids.variantL)).toBe(3);
  });

  test("duplicate variants reject without creating any purchase state", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);

    await expect(
      createPurchase(t, ids, {
        receivedAt: purchaseDay() + 1000,
        lines: [
          { variantId: ids.variantM, qty: 2, unitCost: 600 },
          { variantId: ids.variantM, qty: 3, unitCost: 650 },
        ],
      })
    ).rejects.toThrow();

    const counts = await t.run(async (ctx) => ({
      purchases: (await ctx.db.query("purchases").collect()).length,
      items: (await ctx.db.query("purchaseItems").collect()).length,
      movements: (await ctx.db.query("stockLedger").collect()).length,
    }));
    expect(counts).toEqual({ purchases: 0, items: 0, movements: 0 });
  });

  test("uses the highest daily code suffix when earlier codes have gaps", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const purchasedAt = purchaseDay();
    const prefix = `PO-${dayString(purchasedAt, "Asia/Phnom_Penh").replace(/-/g, "")}-`;
    await t.run(async (ctx) => {
      for (const suffix of [1, 3]) {
        await ctx.db.insert("purchases", {
          supplierId: ids.supplierId,
          code: `${prefix}${String(suffix).padStart(3, "0")}`,
          status: "draft",
          purchasedAt,
          userId: ids.userId,
          createdAt: purchasedAt,
        });
      }
    });

    const created = await t.mutation(api.purchases.create, {
      idempotencyKey: requestKey("purchase-create"),
      supplierId: ids.supplierId,
      purchasedAt,
      lines: [{ variantId: ids.variantM, qty: 1, unitCost: 600 }],
    });
    expect(created.code).toBe(`${prefix}004`);
  });

  test("persists additional costs and includes them in the list total", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const { purchase } = await createPurchase(t, ids, {
      deliveryCost: 125,
      otherCost: 75,
      lines: [{ variantId: ids.variantM, qty: 2, unitCost: 600 }],
    });

    expect(purchase.deliveryCost).toBe(125);
    expect(purchase.otherCost).toBe(75);
    const list = await t.query(api.purchases.list, {
      paginationOpts: { numItems: 20, cursor: null },
    });
    const row = list.page.find((entry) => entry.purchase._id === purchase._id);
    expect(row?.totalCost).toBe(2 * 600 + 125 + 75);
  });

  test("different receipt costs never change the catalog sale price", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    await t.run(async (ctx) => {
      await ctx.db.patch(ids.variantM, { price: 600 });
    });

    await createPurchase(t, ids, {
      lines: [{ variantId: ids.variantM, qty: 5, unitCost: 400 }],
    });
    await createPurchase(t, ids, {
      lines: [{ variantId: ids.variantM, qty: 5, unitCost: 650 }],
    });

    const catalog = await t.run(async (ctx) => ({
      product: await ctx.db.get(ids.productId),
      variant: await ctx.db.get(ids.variantM),
    }));
    expect(catalog.product?.defaultPrice).toBe(1500);
    expect(catalog.variant?.price).toBe(600);
  });

  test("rejects inactive suppliers and inactive variants", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);

    await expect(
      t.mutation(api.purchases.create, {
        idempotencyKey: requestKey("purchase-create"),
        supplierId: ids.inactiveSupplierId,
        purchasedAt: purchaseDay(),
        lines: [{ variantId: ids.variantM, qty: 1, unitCost: 600 }],
      })
    ).rejects.toThrow();
    await expect(
      createPurchase(t, ids, {
        lines: [{ variantId: ids.inactiveVariant, qty: 1, unitCost: 600 }],
      })
    ).rejects.toThrow();
    expect((await t.run(async (ctx) => ctx.db.query("purchases").collect()))).toEqual([]);
  });
});

describe("purchases.update", () => {
  test("receives a draft once and an identical retry does not duplicate movements", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const { purchase, purchasedAt } = await createPurchase(t, ids);
    const before = await purchaseState(t, purchase._id);
    const receivedAt = purchasedAt + 1000;
    const args = {
      purchaseId: purchase._id,
      supplierId: ids.supplierId,
      receivedAt,
      lines: before.items.map((item) => ({
        purchaseItemId: item._id,
        variantId: item.variantId,
        qty: item.qty,
        unitCost: item.unitCost,
      })),
    };

    await t.mutation(api.purchases.update, args);
    const received = await purchaseState(t, purchase._id);
    await t.mutation(api.purchases.update, args);
    const retried = await purchaseState(t, purchase._id);

    expect(received.movements).toHaveLength(1);
    expect(retried.movements.map((row) => row._id)).toEqual(
      received.movements.map((row) => row._id)
    );
    expect(await deriveStockFromLedger(t, ids.variantM)).toBe(5);
  });

  test("edits quantity while draft and receives only the edited quantity", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const { purchase, purchasedAt } = await createPurchase(t, ids);
    const item = (await purchaseState(t, purchase._id)).items[0];

    await t.mutation(api.purchases.update, {
      purchaseId: purchase._id,
      supplierId: ids.supplierId,
      lines: [
        {
          purchaseItemId: item._id,
          variantId: item.variantId,
          qty: 8,
          unitCost: item.unitCost,
        },
      ],
    });
    expect((await purchaseState(t, purchase._id)).movements).toEqual([]);

    await t.mutation(api.purchases.update, {
      purchaseId: purchase._id,
      supplierId: ids.supplierId,
      receivedAt: purchasedAt + 1000,
      lines: [
        {
          purchaseItemId: item._id,
          variantId: item.variantId,
          qty: 8,
          unitCost: item.unitCost,
        },
      ],
    });
    const received = await purchaseState(t, purchase._id);
    expect(received.movements.map((row) => row.delta)).toEqual([8]);
    expect(await deriveStockFromLedger(t, ids.variantM)).toBe(8);
  });

  test("a cost-only edit preserves the movement row and count", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const receivedAt = purchaseDay() + 1000;
    const { purchase } = await createPurchase(t, ids, { receivedAt });
    const before = await purchaseState(t, purchase._id);
    const item = before.items[0];

    await t.mutation(api.purchases.update, {
      purchaseId: purchase._id,
      supplierId: ids.supplierId,
      lines: [
        {
          purchaseItemId: item._id,
          variantId: item.variantId,
          qty: item.qty,
          unitCost: 725,
        },
      ],
    });
    const after = await purchaseState(t, purchase._id);

    expect(after.items[0].unitCost).toBe(725);
    expect(after.movements.map((row) => row._id)).toEqual(
      before.movements.map((row) => row._id)
    );
    expect(await deriveStockFromLedger(t, ids.variantM)).toBe(5);
  });

  test.each(["reduce quantity", "remove line", "unreceive"] as const)(
    "rejects %s atomically when consumed stock would become negative",
    async (operation) => {
      const t = convexTest(schema, modules);
      const ids = await seed(t);
      const receivedAt = purchaseDay() + 1000;
      const { purchase } = await createPurchase(t, ids, {
        receivedAt,
        lines: [
          { variantId: ids.variantM, qty: 5, unitCost: 600 },
          { variantId: ids.variantL, qty: 2, unitCost: 700 },
        ],
      });
      await consumeStock(t, ids.variantM, 4);
      const before = await purchaseState(t, purchase._id);
      const m = before.items.find((item) => item.variantId === ids.variantM)!;
      const l = before.items.find((item) => item.variantId === ids.variantL)!;
      const lines =
        operation === "reduce quantity"
          ? [
              { purchaseItemId: m._id, variantId: m.variantId, qty: 3, unitCost: m.unitCost },
              { purchaseItemId: l._id, variantId: l.variantId, qty: l.qty, unitCost: l.unitCost },
            ]
          : operation === "remove line"
            ? [
                {
                  purchaseItemId: l._id,
                  variantId: l.variantId,
                  qty: l.qty,
                  unitCost: l.unitCost,
                },
              ]
            : before.items.map((item) => ({
                purchaseItemId: item._id,
                variantId: item.variantId,
                qty: item.qty,
                unitCost: item.unitCost,
              }));

      await expect(
        t.mutation(api.purchases.update, {
          purchaseId: purchase._id,
          supplierId: ids.supplierId,
          ...(operation === "unreceive" ? { receivedAt: null } : {}),
          lines,
        })
      ).rejects.toThrow();

      const after = await purchaseState(t, purchase._id);
      expect(after.purchase).toEqual(before.purchase);
      expect(after.items).toEqual(before.items);
      expect(after.movements).toEqual(before.movements);
      expect(await deriveStockFromLedger(t, ids.variantM)).toBe(1);
      expect(await deriveStockFromLedger(t, ids.variantL)).toBe(2);
    }
  );

  test("a valid received quantity reduction rewrites one exact delta", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const receivedAt = purchaseDay() + 1000;
    const { purchase } = await createPurchase(t, ids, { receivedAt });
    await consumeStock(t, ids.variantM, 2);
    const before = await purchaseState(t, purchase._id);
    const item = before.items[0];

    await t.mutation(api.purchases.update, {
      purchaseId: purchase._id,
      supplierId: ids.supplierId,
      lines: [
        {
          purchaseItemId: item._id,
          variantId: item.variantId,
          qty: 3,
          unitCost: item.unitCost,
        },
      ],
    });
    const after = await purchaseState(t, purchase._id);

    expect(after.movements).toHaveLength(1);
    expect(after.movements[0]).toEqual(
      expect.objectContaining({
        variantId: ids.variantM,
        purchaseItemId: item._id,
        reason: "purchase",
        delta: 3,
        ts: receivedAt,
      })
    );
    expect(after.movements[0]._id).not.toBe(before.movements[0]._id);
    expect(await deriveStockFromLedger(t, ids.variantM)).toBe(1);
  });

  test("changing the purchase date still enforces arrival on or after purchase", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const purchasedAt = purchaseDay();
    const receivedAt = purchasedAt + 1000;
    const purchase = await t.mutation(api.purchases.create, {
      idempotencyKey: requestKey("purchase-create"),
      supplierId: ids.supplierId,
      purchasedAt,
      receivedAt,
      lines: [{ variantId: ids.variantM, qty: 5, unitCost: 600 }],
    });
    const before = await purchaseState(t, purchase._id);

    await expect(
      t.mutation(api.purchases.update, {
        purchaseId: purchase._id,
        supplierId: ids.supplierId,
        purchasedAt: receivedAt + 1000,
        lines: before.items.map((item) => ({
          purchaseItemId: item._id,
          variantId: item.variantId,
          qty: item.qty,
          unitCost: item.unitCost,
        })),
      })
    ).rejects.toThrow();

    expect(await purchaseState(t, purchase._id)).toEqual(before);
  });

  test("rejects a purchase item owned by another purchase without partial edits", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const first = await createPurchase(t, ids);
    const second = await createPurchase(t, ids, {
      lines: [{ variantId: ids.variantL, qty: 2, unitCost: 700 }],
    });
    const firstBefore = await purchaseState(t, first.purchase._id);
    const foreignItem = (await purchaseState(t, second.purchase._id)).items[0];

    await expect(
      t.mutation(api.purchases.update, {
        purchaseId: first.purchase._id,
        supplierId: ids.supplierId,
        lines: [
          {
            purchaseItemId: foreignItem._id,
            variantId: foreignItem.variantId,
            qty: 9,
            unitCost: foreignItem.unitCost,
          },
        ],
      })
    ).rejects.toThrow();

    expect(await purchaseState(t, first.purchase._id)).toEqual(firstBefore);
  });
});
