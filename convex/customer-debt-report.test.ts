import { convexTest } from "convex-test";
import { describe, expect, test, vi } from "vitest";

import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import schema from "./schema";

const AUTH_USER_ID = "customer-debt-owner";

vi.mock("./auth", () => ({
  authComponent: {
    safeGetAuthUser: async () => ({
      _id: AUTH_USER_ID,
      name: "Customer Debt Owner",
      email: "customer-debt@test.local",
    }),
  },
}));

const modules = import.meta.glob("./**/*.ts");

async function seed(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx: MutationCtx) => {
    await ctx.db.insert("shop", {
      name: "Debt Test Shop",
      currency: "USD",
      exchangeRate: 4000,
      timezone: "UTC",
      deliveryEnabled: false,
      language: "en",
    });
    const userId = await ctx.db.insert("users", {
      authUserId: AUTH_USER_ID,
      name: "Customer Debt Owner",
      email: "customer-debt@test.local",
      role: "owner",
      active: true,
    });
    const customerA = await ctx.db.insert("customers", {
      name: "Alice Shop",
      nameLower: "alice shop",
      phone: "10111222",
      active: true,
    });
    const customerB = await ctx.db.insert("customers", {
      name: "Bob Store",
      nameLower: "bob store",
      phone: "11333444",
      active: true,
    });
    const channelId = await ctx.db.insert("salesChannels", {
      name: "Walk in",
      nameLower: "walk in",
      type: "walk_in",
      active: true,
    });
    const productId = await ctx.db.insert("products", {
      name: "Debt Product",
      nameLower: "debt product",
      defaultPrice: 1000,
      defaultCost: 400,
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
    return { userId, customerA, customerB, channelId, variantId };
  });
}

type Seed = Awaited<ReturnType<typeof seed>>;

function daysAgo(days: number) {
  const now = new Date();
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - days, 12);
}

async function addSale(
  t: ReturnType<typeof convexTest>,
  ids: Seed,
  options: {
    customerId: Id<"customers">;
    code: string;
    ageDays: number;
    itemTotal?: number;
    deliveryFee?: number;
    paid?: number;
    refund?: number;
    status?: "draft" | "confirmed" | "delivered" | "cancelled";
    chargeDeliveryOnCancel?: boolean;
  }
) {
  return await t.run(async (ctx: MutationCtx) => {
    const createdAt = daysAgo(options.ageDays);
    const saleId = await ctx.db.insert("sales", {
      code: options.code,
      customerId: options.customerId,
      salesChannelId: ids.channelId,
      status: options.status ?? "confirmed",
      deliveryFee: options.deliveryFee ?? 0,
      deliveryCost: 0,
      discount: 0,
      userId: ids.userId,
      createdAt,
      ...(options.chargeDeliveryOnCancel ? { chargeDeliveryOnCancel: true } : {}),
    });
    if ((options.itemTotal ?? 0) > 0) {
      await ctx.db.insert("saleItems", {
        saleId,
        variantId: ids.variantId,
        unitPrice: options.itemTotal!,
        unitCostSnapshot: 400,
        qtyOrdered: 1,
        qtyDelivered: 0,
        qtyCancelled: 0,
        qtyReturned: 0,
      });
    }
    if ((options.paid ?? 0) > 0) {
      await ctx.db.insert("payments", {
        saleId,
        amount: options.paid!,
        receivedAt: createdAt,
        receivedDay: new Date(createdAt).toISOString().slice(0, 10),
        method: "cash",
        userId: ids.userId,
      });
    }
    if ((options.refund ?? 0) > 0) {
      await ctx.db.insert("payments", {
        saleId,
        amount: -options.refund!,
        receivedAt: createdAt,
        receivedDay: new Date(createdAt).toISOString().slice(0, 10),
        method: "refund",
        userId: ids.userId,
      });
    }
    return saleId;
  });
}

describe("customer debt report", () => {
  test("groups balances and assigns every order to one aging bucket", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    await addSale(t, ids, {
      customerId: ids.customerA,
      code: "A-RECENT",
      ageDays: 5,
      itemTotal: 1000,
      deliveryFee: 100,
      paid: 300,
    });
    await addSale(t, ids, {
      customerId: ids.customerA,
      code: "A-OLD",
      ageDays: 40,
      itemTotal: 500,
    });
    await addSale(t, ids, {
      customerId: ids.customerB,
      code: "B-PAID",
      ageDays: 70,
      itemTotal: 700,
      paid: 700,
    });
    const cancelledId = await addSale(t, ids, {
      customerId: ids.customerB,
      code: "B-SHIPPING",
      ageDays: 61,
      deliveryFee: 200,
      status: "cancelled",
      chargeDeliveryOnCancel: true,
    });
    await addSale(t, ids, {
      customerId: ids.customerB,
      code: "B-DRAFT",
      ageDays: 80,
      itemTotal: 900,
      status: "draft",
    });
    await addSale(t, ids, {
      customerId: ids.customerB,
      code: "B-CANCELLED",
      ageDays: 90,
      itemTotal: 900,
      status: "cancelled",
    });

    const firstPage = await t.query(api.reports.getCustomerDebtReport, {
      paginationOpts: { numItems: 1, cursor: null },
    });
    expect(firstPage.totalOwed).toBe(1500);
    expect(firstPage.customerCount).toBe(2);
    expect(firstPage.aging).toEqual({
      days0To7: 800,
      days8To30: 0,
      days31To60: 500,
      over60Days: 200,
    });
    expect(firstPage.page).toHaveLength(1);
    expect(firstPage.page[0]).toEqual(
      expect.objectContaining({
        customerId: ids.customerA,
        totalOwed: 1300,
        unpaidOrderCount: 2,
        oldestOrderCode: "A-OLD",
        oldestAgeDays: 40,
      })
    );
    expect(firstPage.continueCursor).toBe("1");

    const secondPage = await t.query(api.reports.getCustomerDebtReport, {
      paginationOpts: { numItems: 1, cursor: firstPage.continueCursor },
    });
    expect(secondPage.page[0]).toEqual(
      expect.objectContaining({
        customerId: ids.customerB,
        totalOwed: 200,
        oldestOrderId: cancelledId,
      })
    );
  });

  test("refunds reopen debt and search accepts formatted local phones", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    await addSale(t, ids, {
      customerId: ids.customerB,
      code: "B-REFUND",
      ageDays: 8,
      itemTotal: 500,
      paid: 500,
      refund: 200,
      status: "delivered",
    });

    const report = await t.query(api.reports.getCustomerDebtReport, {
      search: "011 333",
      paginationOpts: { numItems: 20, cursor: null },
    });
    expect(report.customerCount).toBe(1);
    expect(report.totalOwed).toBe(200);
    expect(report.aging.days8To30).toBe(200);
    expect(report.page[0].customerId).toBe(ids.customerB);
  });
});
