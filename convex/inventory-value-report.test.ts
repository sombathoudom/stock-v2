import { convexTest } from "convex-test";
import { describe, expect, test, vi } from "vitest";

import { api } from "./_generated/api";
import type { MutationCtx } from "./_generated/server";
import schema from "./schema";

const AUTH_USER_ID = "inventory-value-owner";

vi.mock("./auth", () => ({
  authComponent: {
    safeGetAuthUser: async () => ({
      _id: AUTH_USER_ID,
      name: "Inventory Value Owner",
      email: "inventory-value@test.local",
    }),
  },
}));

const modules = import.meta.glob("./**/*.ts");

async function seed(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx: MutationCtx) => {
    await ctx.db.insert("shop", {
      name: "Inventory Value Shop",
      currency: "USD",
      exchangeRate: 4000,
      timezone: "UTC",
      deliveryEnabled: false,
      language: "en",
    });
    const userId = await ctx.db.insert("users", {
      authUserId: AUTH_USER_ID,
      name: "Inventory Value Owner",
      email: "inventory-value@test.local",
      role: "owner",
      active: true,
    });
    const supplierId = await ctx.db.insert("suppliers", {
      name: "Value Supplier",
      nameLower: "value supplier",
      active: true,
    });
    const activeProduct = await ctx.db.insert("products", {
      name: "Active Shirt",
      nameLower: "active shirt",
      code: "ACTIVE-01",
      defaultPrice: 1000,
      defaultCost: 300,
      hasColors: false,
      sizes: ["M", "L", "XL"],
      colors: [],
      active: true,
    });
    const variantM = await ctx.db.insert("productVariants", {
      productId: activeProduct,
      size: "M",
      sku: "ACTIVE-M",
      active: true,
    });
    const variantL = await ctx.db.insert("productVariants", {
      productId: activeProduct,
      size: "L",
      sku: "ACTIVE-L",
      active: true,
    });
    const negativeVariant = await ctx.db.insert("productVariants", {
      productId: activeProduct,
      size: "XL",
      sku: "ACTIVE-XL",
      active: true,
    });
    const inactiveProduct = await ctx.db.insert("products", {
      name: "Hidden Trousers",
      nameLower: "hidden trousers",
      defaultPrice: 900,
      defaultCost: 300,
      hasColors: false,
      sizes: ["S"],
      colors: [],
      active: false,
    });
    const inactiveVariant = await ctx.db.insert("productVariants", {
      productId: inactiveProduct,
      size: "S",
      sku: "HIDDEN-S",
      active: false,
    });
    const now = Date.now();
    const purchaseId = await ctx.db.insert("purchases", {
      supplierId,
      code: "PO-VALUE-001",
      status: "received",
      purchasedAt: now,
      receivedAt: now,
      deliveryCost: 200,
      userId,
      createdAt: now,
    });
    for (const [variantId, unitCost] of [
      [variantM, 400],
      [variantL, 600],
    ] as const) {
      const purchaseItemId = await ctx.db.insert("purchaseItems", {
        purchaseId,
        variantId,
        qty: 10,
        unitCost,
      });
      await ctx.db.insert("stockLedger", {
        variantId,
        delta: 10,
        reason: "purchase",
        purchaseItemId,
        userId,
        ts: now,
      });
    }
    await ctx.db.insert("stockLedger", {
      variantId: inactiveVariant,
      delta: 3,
      reason: "adjustment",
      userId,
      ts: now,
    });
    await ctx.db.insert("stockLedger", {
      variantId: negativeVariant,
      delta: -2,
      reason: "adjustment",
      userId,
      ts: now,
    });
    return { variantM, variantL, inactiveVariant, negativeVariant };
  });
}

describe("inventory value report", () => {
  test("values ledger stock using landed weighted-average cost", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);

    const report = await t.query(api.reports.getInventoryValueReport, {
      status: "all",
      paginationOpts: { numItems: 20, cursor: null },
    });
    expect(report.totals).toEqual({
      totalUnits: 23,
      totalValue: 11100,
      variantCount: 4,
      inactiveVariantCount: 1,
    });
    expect(report.page).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          variantId: ids.variantM,
          currentQty: 10,
          weightedLandedUnitCost: 410,
          totalValue: 4100,
        }),
        expect.objectContaining({
          variantId: ids.variantL,
          currentQty: 10,
          weightedLandedUnitCost: 610,
          totalValue: 6100,
        }),
        expect.objectContaining({
          variantId: ids.inactiveVariant,
          active: false,
          currentQty: 3,
          totalValue: 900,
        }),
        expect.objectContaining({
          variantId: ids.negativeVariant,
          currentQty: -2,
          totalValue: 0,
        }),
      ])
    );
  });

  test("filters inactive stock and paginates the final variant rows", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);

    const inactive = await t.query(api.reports.getInventoryValueReport, {
      status: "inactive",
      search: "hidden-s",
      paginationOpts: { numItems: 1, cursor: null },
    });
    expect(inactive.total).toBe(1);
    expect(inactive.totals).toEqual({
      totalUnits: 3,
      totalValue: 900,
      variantCount: 1,
      inactiveVariantCount: 1,
    });
    expect(inactive.page[0].variantId).toBe(ids.inactiveVariant);
    expect(inactive.continueCursor).toBe("");
  });
});
