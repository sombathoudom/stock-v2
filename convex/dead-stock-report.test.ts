import { convexTest } from "convex-test";
import { describe, expect, test, vi } from "vitest";

import { api } from "./_generated/api";
import type { MutationCtx } from "./_generated/server";
import schema from "./schema";

const AUTH_USER_ID = "dead-stock-owner";

vi.mock("./auth", () => ({
  authComponent: {
    safeGetAuthUser: async () => ({
      _id: AUTH_USER_ID,
      name: "Dead Stock Owner",
      email: "dead-stock@test.local",
    }),
  },
}));

const modules = import.meta.glob("./**/*.ts");

function daysAgo(days: number) {
  const now = new Date();
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - days, 12);
}

async function seed(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx: MutationCtx) => {
    await ctx.db.insert("shop", {
      name: "Dead Stock Shop",
      currency: "USD",
      exchangeRate: 4000,
      timezone: "UTC",
      deliveryEnabled: false,
      language: "en",
    });
    const userId = await ctx.db.insert("users", {
      authUserId: AUTH_USER_ID,
      name: "Dead Stock Owner",
      email: "dead-stock@test.local",
      role: "owner",
      active: true,
    });
    const productId = await ctx.db.insert("products", {
      name: "Aging Shirt",
      nameLower: "aging shirt",
      code: "AGING-01",
      defaultPrice: 900,
      defaultCost: 300,
      hasColors: false,
      sizes: ["S", "M", "L"],
      colors: [],
      active: true,
    });
    const neverSold = await ctx.db.insert("productVariants", {
      productId,
      size: "S",
      sku: "AGING-S",
      active: false,
    });
    const sold = await ctx.db.insert("productVariants", {
      productId,
      size: "M",
      sku: "AGING-M",
      active: true,
    });
    const fresh = await ctx.db.insert("productVariants", {
      productId,
      size: "L",
      sku: "AGING-L",
      active: true,
    });
    await ctx.db.insert("stockLedger", {
      variantId: neverSold,
      delta: 5,
      reason: "adjustment",
      userId,
      ts: daysAgo(100),
    });
    await ctx.db.insert("stockLedger", {
      variantId: sold,
      delta: 10,
      reason: "adjustment",
      userId,
      ts: daysAgo(120),
    });
    await ctx.db.insert("stockLedger", {
      variantId: sold,
      delta: -2,
      reason: "sale",
      userId,
      ts: daysAgo(40),
    });
    await ctx.db.insert("stockLedger", {
      variantId: fresh,
      delta: 4,
      reason: "adjustment",
      userId,
      ts: daysAgo(10),
    });
    return { neverSold, sold, fresh };
  });
}

describe("dead stock report", () => {
  test("ages never-sold stock from first stock-in and sold stock from last sale", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);

    const report = await t.query(api.reports.getDeadStockReport, {
      thresholdDays: 30,
      paginationOpts: { numItems: 20, cursor: null },
    });
    expect(report.totals).toEqual({
      totalUnits: 13,
      tiedUpValue: 3900,
      variantCount: 2,
      neverSoldCount: 1,
      inactiveVariantCount: 1,
    });
    expect(report.page).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          variantId: ids.neverSold,
          currentQty: 5,
          ageDays: 100,
          active: false,
          tiedUpValue: 1500,
        }),
        expect.objectContaining({
          variantId: ids.sold,
          currentQty: 8,
          ageDays: 40,
          tiedUpValue: 2400,
        }),
      ])
    );
    expect(report.page.find((row) => row.variantId === ids.neverSold)?.lastSoldAt).toBeUndefined();
    expect(report.page.some((row) => row.variantId === ids.fresh)).toBe(false);
  });

  test("applies threshold, search, totals, and pagination after aging", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);

    const report = await t.query(api.reports.getDeadStockReport, {
      thresholdDays: 90,
      search: "AGING-S",
      paginationOpts: { numItems: 1, cursor: null },
    });
    expect(report.total).toBe(1);
    expect(report.page[0].variantId).toBe(ids.neverSold);
    expect(report.totals.totalUnits).toBe(5);
    expect(report.totals.tiedUpValue).toBe(1500);
    expect(report.continueCursor).toBe("");
  });
});
