import { convexTest } from "convex-test";
import { describe, expect, test, vi } from "vitest";

import { api } from "./_generated/api";
import type { MutationCtx } from "./_generated/server";
import schema from "./schema";

const AUTH_USER_ID = "product-performance-owner";

vi.mock("./auth", () => ({
  authComponent: {
    safeGetAuthUser: async () => ({
      _id: AUTH_USER_ID,
      name: "Product Performance Owner",
      email: "product-performance@test.local",
    }),
  },
}));

const modules = import.meta.glob("./**/*.ts");

function today() {
  return new Date().toISOString().slice(0, 10);
}

async function seed(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx: MutationCtx) => {
    await ctx.db.insert("shop", {
      name: "Product Report Shop",
      currency: "USD",
      exchangeRate: 4000,
      timezone: "UTC",
      deliveryEnabled: false,
      language: "en",
    });
    const userId = await ctx.db.insert("users", {
      authUserId: AUTH_USER_ID,
      name: "Product Performance Owner",
      email: "product-performance@test.local",
      role: "owner",
      active: true,
    });
    const customerId = await ctx.db.insert("customers", {
      name: "Report Customer",
      nameLower: "report customer",
      phone: "101234567",
      active: true,
    });
    const channelId = await ctx.db.insert("salesChannels", {
      name: "Walk in",
      nameLower: "walk in",
      type: "walk_in",
      active: true,
    });
    const productId = await ctx.db.insert("products", {
      name: "Performance Shirt",
      nameLower: "performance shirt",
      code: "PERF-01",
      defaultPrice: 1000,
      defaultCost: 400,
      hasColors: false,
      sizes: ["M", "L"],
      colors: [],
      active: true,
    });
    const variantM = await ctx.db.insert("productVariants", {
      productId,
      size: "M",
      sku: "PERF-M",
      active: true,
    });
    const variantL = await ctx.db.insert("productVariants", {
      productId,
      size: "L",
      sku: "PERF-L",
      active: true,
    });
    return { userId, customerId, channelId, productId, variantM, variantL };
  });
}

describe("product performance report", () => {
  test("allocates cash revenue and landed cost exactly across variants", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    await t.run(async (ctx: MutationCtx) => {
      const now = Date.now();
      const saleId = await ctx.db.insert("sales", {
        code: "PERF-SALE",
        customerId: ids.customerId,
        salesChannelId: ids.channelId,
        status: "confirmed",
        deliveryFee: 150,
        deliveryCost: 0,
        discount: 150,
        userId: ids.userId,
        createdAt: now,
      });
      const itemM = await ctx.db.insert("saleItems", {
        saleId,
        variantId: ids.variantM,
        unitPrice: 1000,
        unitCostSnapshot: 400,
        qtyOrdered: 1,
        qtyDelivered: 0,
        qtyCancelled: 0,
        qtyReturned: 0,
      });
      const itemL = await ctx.db.insert("saleItems", {
        saleId,
        variantId: ids.variantL,
        unitPrice: 500,
        unitCostSnapshot: 200,
        qtyOrdered: 1,
        qtyDelivered: 0,
        qtyCancelled: 0,
        qtyReturned: 0,
      });
      await ctx.db.insert("stockLedger", {
        variantId: ids.variantM,
        delta: -1,
        reason: "sale",
        saleItemId: itemM,
        userId: ids.userId,
        ts: now,
      });
      await ctx.db.insert("stockLedger", {
        variantId: ids.variantL,
        delta: -1,
        reason: "sale",
        saleItemId: itemL,
        userId: ids.userId,
        ts: now,
      });
      await ctx.db.insert("payments", {
        saleId,
        amount: 750,
        receivedAt: now,
        receivedDay: today(),
        method: "cash",
        userId: ids.userId,
      });
    });

    const report = await t.query(api.reports.getProductPerformanceReport, {
      period: { type: "day", value: today() },
      paginationOpts: { numItems: 20, cursor: null },
    });
    expect(report.totals).toEqual({
      unitsSold: 2,
      returnedUnits: 0,
      exchangedUnits: 0,
      revenue: 675,
      landedCost: 300,
      profit: 375,
    });
    expect(report.page).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          variantId: ids.variantM,
          unitsSold: 1,
          revenue: 450,
          landedCost: 200,
          profit: 250,
        }),
        expect.objectContaining({
          variantId: ids.variantL,
          unitsSold: 1,
          revenue: 225,
          landedCost: 100,
          profit: 125,
        }),
      ])
    );
    const pl = await t.query(api.reports.getPlReport, {
      period: { type: "day", value: today() },
    });
    expect(report.totals.landedCost).toBe(pl.cogs);
  });

  test("uses movement time for returns and exchanges", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    await t.run(async (ctx: MutationCtx) => {
      const now = Date.now();
      for (const movement of [
        { variantId: ids.variantM, delta: -2, reason: "sale" as const },
        { variantId: ids.variantM, delta: 1, reason: "return" as const },
        { variantId: ids.variantM, delta: 1, reason: "exchange_out" as const },
        { variantId: ids.variantL, delta: -1, reason: "exchange_in" as const },
      ]) {
        await ctx.db.insert("stockLedger", {
          ...movement,
          userId: ids.userId,
          ts: now,
        });
      }
    });

    const report = await t.query(api.reports.getProductPerformanceReport, {
      period: { type: "day", value: today() },
      search: "PERF",
      paginationOpts: { numItems: 1, cursor: null },
    });
    expect(report.totals).toEqual({
      unitsSold: 1,
      returnedUnits: 1,
      exchangedUnits: 1,
      revenue: 0,
      landedCost: 0,
      profit: 0,
    });
    expect(report.total).toBe(2);
    expect(report.continueCursor).toBe("1");
    expect(report.page[0]).toEqual(
      expect.objectContaining({
        variantId: ids.variantL,
        unitsSold: 1,
      })
    );
  });
});
