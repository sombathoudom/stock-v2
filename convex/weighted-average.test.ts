import { convexTest } from "convex-test";
import { describe, expect, test, vi } from "vitest";

import { api } from "./_generated/api";
import type { MutationCtx } from "./_generated/server";
import schema from "./schema";

const AUTH_USER_ID = "weighted-average-owner";
let requestSequence = 0;

function requestKey(operation: string) {
  requestSequence += 1;
  return `${operation}-${requestSequence}`;
}

vi.mock("./auth", () => ({
  authComponent: {
    safeGetAuthUser: async () => ({
      _id: AUTH_USER_ID,
      name: "Weighted Average Owner",
      email: "weighted-average@test.local",
    }),
  },
}));

const modules = import.meta.glob("./**/*.ts");

async function seed(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx: MutationCtx) => {
    await ctx.db.insert("shop", {
      name: "Cost Test Shop",
      currency: "USD",
      exchangeRate: 4000,
      timezone: "Asia/Phnom_Penh",
      deliveryEnabled: false,
      language: "en" as const,
    });
    await ctx.db.insert("users", {
      authUserId: AUTH_USER_ID,
      name: "Weighted Average Owner",
      email: "weighted-average@test.local",
      role: "owner" as const,
      active: true,
    });
    const supplierId = await ctx.db.insert("suppliers", {
      name: "Cost Supplier",
      nameLower: "cost supplier",
      active: true,
    });
    const customerId = await ctx.db.insert("customers", {
      name: "Cost Customer",
      nameLower: "cost customer",
      phone: "101234567",
      active: true,
    });
    const channelId = await ctx.db.insert("salesChannels", {
      name: "Walk in",
      nameLower: "walk in",
      type: "walk_in" as const,
      active: true,
    });
    const productId = await ctx.db.insert("products", {
      name: "Costed Shirt",
      nameLower: "costed shirt",
      defaultPrice: 2000,
      defaultCost: 300,
      hasColors: false,
      sizes: ["M"],
      colors: [],
      active: true,
    });
    const variantId = await ctx.db.insert("productVariants", {
      productId,
      size: "M",
      active: true,
    });
    return { supplierId, customerId, channelId, variantId };
  });
}

type Seed = Awaited<ReturnType<typeof seed>>;

async function receive(
  t: ReturnType<typeof convexTest>,
  ids: Seed,
  qty: number,
  unitCost: number
) {
  const receivedAt = Date.now();
  return await t.mutation(api.purchases.create, {
    idempotencyKey: requestKey("purchase-create"),
    supplierId: ids.supplierId,
    purchasedAt: receivedAt,
    receivedAt,
    lines: [{ variantId: ids.variantId, qty, unitCost }],
  });
}

async function sell(t: ReturnType<typeof convexTest>, ids: Seed, qty: number) {
  return await t.mutation(api.sales.checkout, {
    idempotencyKey: requestKey("checkout"),
    customerId: ids.customerId,
    salesChannelId: ids.channelId,
    discount: 0,
    items: [{ variantId: ids.variantId, qty }],
  });
}

function snapshot(sale: Awaited<ReturnType<typeof sell>>) {
  return sale.items[0].item.unitCostSnapshot;
}

describe("moving weighted-average sale cost", () => {
  test("a receipt after full depletion establishes the new average", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);

    await receive(t, ids, 10, 400);
    expect(snapshot(await sell(t, ids, 10))).toBe(400);
    await receive(t, ids, 10, 600);

    expect(snapshot(await sell(t, ids, 1))).toBe(600);
  });

  test("weights a new receipt by only the quantity remaining on shelf", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);

    await receive(t, ids, 10, 400);
    const oldSale = await sell(t, ids, 9);
    await receive(t, ids, 10, 1000);
    const nextSale = await sell(t, ids, 1);

    expect(snapshot(oldSale)).toBe(400);
    expect(snapshot(nextSale)).toBe(945);
    expect((await t.query(api.sales.getDetail, { saleId: oldSale.sale._id }))?.items[0].item.unitCostSnapshot).toBe(400);
  });

  test("purchase cost edits change future snapshots but never old sales", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);

    const purchase = await receive(t, ids, 10, 400);
    const oldSale = await sell(t, ids, 1);
    const detail = await t.query(api.purchases.get, { purchaseId: purchase._id });
    expect(detail).not.toBeNull();
    await t.mutation(api.purchases.update, {
      purchaseId: purchase._id,
      supplierId: ids.supplierId,
      lines: [
        {
          purchaseItemId: detail!.items[0].item._id,
          variantId: ids.variantId,
          qty: 10,
          unitCost: 600,
        },
      ],
    });

    expect(snapshot(await sell(t, ids, 1))).toBe(600);
    expect((await t.query(api.sales.getDetail, { saleId: oldSale.sale._id }))?.items[0].item.unitCostSnapshot).toBe(400);
  });

  test("returns and adjustments alter receipt weighting without rewriting snapshots", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);

    await receive(t, ids, 10, 400);
    const oldSale = await sell(t, ids, 4);
    await t.mutation(api.sales.setLineDelivered, {
      saleId: oldSale.sale._id,
      adjustments: [{ saleItemId: oldSale.items[0].item._id, qtyDelivered: 4 }],
    });
    await t.mutation(api.sales.returnItems, {
      saleId: oldSale.sale._id,
      returns: [{ saleItemId: oldSale.items[0].item._id, qty: 1 }],
    });
    await t.mutation(api.adjustments.adjustStock, {
      idempotencyKey: requestKey("stock-adjustment"),
      variantId: ids.variantId,
      delta: -2,
      note: "Damaged after customer return",
    });
    await receive(t, ids, 5, 1000);

    expect(snapshot(await sell(t, ids, 1))).toBe(700);
    expect((await t.query(api.sales.getDetail, { saleId: oldSale.sale._id }))?.items[0].item.unitCostSnapshot).toBe(400);
  });
});
