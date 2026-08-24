import { convexTest } from "convex-test";
import { describe, expect, test, vi } from "vitest";

import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import schema from "./schema";

const AUTH_USER_ID = "reports-integrity-user";

vi.mock("./auth", () => ({
  authComponent: {
    safeGetAuthUser: async () => ({
      _id: AUTH_USER_ID,
      name: "Report Owner",
      email: "reports@test.local",
    }),
  },
}));

const modules = import.meta.glob("./**/*.ts");

type Seed = Awaited<ReturnType<typeof seed>>;

async function seed(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    await ctx.db.insert("shop", {
      name: "Report Shop",
      currency: "USD",
      exchangeRate: 4000,
      timezone: "Asia/Phnom_Penh",
      deliveryEnabled: true,
      language: "en" as const,
    });
    const userId = await ctx.db.insert("users", {
      authUserId: AUTH_USER_ID,
      name: "Report Owner",
      email: "reports@test.local",
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
      name: "Rounding Item",
      nameLower: "rounding item",
      defaultPrice: 100,
      defaultCost: 1,
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
    return { userId, customerId, channelId, variantId };
  });
}

async function addSale(
  t: ReturnType<typeof convexTest>,
  ids: Seed,
  values: {
    code: string;
    unitPrice: number;
    unitCost: number;
    lineDiscount?: number;
    orderDiscount?: number;
    deliveryFee?: number;
    deliveryCost?: number;
  }
) {
  return await t.run(async (ctx: MutationCtx) => {
    const saleId = await ctx.db.insert("sales", {
      code: values.code,
      customerId: ids.customerId,
      salesChannelId: ids.channelId,
      status: "delivered" as const,
      deliveryFee: values.deliveryFee ?? 0,
      deliveryCost: values.deliveryCost ?? 0,
      discount: values.orderDiscount ?? 0,
      userId: ids.userId,
      createdAt: Date.UTC(2025, 0, 1),
      deliveredAt: Date.UTC(2025, 0, 2),
    });
    await ctx.db.insert("saleItems", {
      saleId,
      variantId: ids.variantId,
      unitPrice: values.unitPrice,
      unitCostSnapshot: values.unitCost,
      qtyOrdered: 1,
      qtyDelivered: 1,
      qtyCancelled: 0,
      qtyReturned: 0,
      discount: values.lineDiscount,
    });
    return saleId;
  });
}

async function addPayment(
  t: ReturnType<typeof convexTest>,
  ids: Seed,
  saleId: Id<"sales">,
  amount: number,
  receivedDay: string,
  receivedAt: number
) {
  return await t.run(async (ctx: MutationCtx) =>
    ctx.db.insert("payments", {
      saleId,
      amount,
      receivedDay,
      receivedAt,
      method: amount < 0 ? ("refund" as const) : ("cash" as const),
      userId: ids.userId,
    })
  );
}

async function dayReport(t: ReturnType<typeof convexTest>, day: string) {
  return await t.query(api.reports.getPlReport, {
    period: { type: "day", value: day },
  });
}

describe("cash-basis report allocation integrity", () => {
  test("split full payments recognize exact COGS instead of independently rounding", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const roundedAbove = await addSale(t, ids, {
      code: "ROUND-UP",
      unitPrice: 2,
      unitCost: 1,
    });
    const roundedBelow = await addSale(t, ids, {
      code: "ROUND-DOWN",
      unitPrice: 3,
      unitCost: 1,
    });

    await addPayment(t, ids, roundedAbove, 1, "2026-03-01", 100);
    await addPayment(t, ids, roundedAbove, 1, "2026-03-02", 200);
    await addPayment(t, ids, roundedBelow, 1, "2026-03-03", 300);
    await addPayment(t, ids, roundedBelow, 1, "2026-03-04", 400);
    await addPayment(t, ids, roundedBelow, 1, "2026-03-05", 500);

    const days = await Promise.all([
      dayReport(t, "2026-03-01"),
      dayReport(t, "2026-03-02"),
      dayReport(t, "2026-03-03"),
      dayReport(t, "2026-03-04"),
      dayReport(t, "2026-03-05"),
    ]);
    const month = await t.query(api.reports.getPlReport, {
      period: { type: "month", value: "2026-03" },
    });
    const csv = await t.query(api.reports.getReportCsv, {
      period: { type: "month", value: "2026-03" },
    });

    expect(days.map((row) => row.cogs)).toEqual([1, 0, 0, 1, 0]);
    expect(days.reduce((sum, row) => sum + row.cogs, 0)).toBe(2);
    expect(month.cogs).toBe(2);
    expect(csv.rows.reduce((sum, row) => sum + row.cogs, 0)).toBe(2);
    expect(days.reduce((sum, row) => sum + row.cogs, 0)).toBe(month.cogs);
  });

  test("refunds reverse cumulative cost and preserve discount and shipping policy", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const saleId = await addSale(t, ids, {
      code: "SHIPPING-REFUND",
      unitPrice: 120,
      unitCost: 41,
      lineDiscount: 10,
      orderDiscount: 10,
      deliveryFee: 20,
      deliveryCost: 13,
    });

    // Total is 120: (120 - 10 line discount) - 10 order discount + 20 shipping.
    // Equal timestamps intentionally exercise the creation/id tie-break.
    await addPayment(t, ids, saleId, 60, "2026-04-01", 500);
    await addPayment(t, ids, saleId, 60, "2026-04-02", 500);
    await addPayment(t, ids, saleId, -60, "2026-04-03", 600);
    await t.run(async (ctx: MutationCtx) => {
      await ctx.db.insert("expenses", {
        amount: 13,
        category: "Delivery",
        categoryLower: "delivery",
        spentAt: 500,
        spentDay: "2026-04-02",
        userId: ids.userId,
      });
    });

    const first = await dayReport(t, "2026-04-01");
    const second = await dayReport(t, "2026-04-02");
    const refund = await dayReport(t, "2026-04-03");
    const month = await t.query(api.reports.getPlReport, {
      period: { type: "month", value: "2026-04" },
    });

    expect([first.cogs, second.cogs, refund.cogs]).toEqual([21, 20, -20]);
    expect([first.deliveryIncome, second.deliveryIncome, refund.deliveryIncome]).toEqual([
      10, 10, -10,
    ]);
    expect([first.deliveryCost, second.deliveryCost, refund.deliveryCost]).toEqual([7, 6, -6]);
    expect(month.cogs).toBe(first.cogs + second.cogs + refund.cogs);
    expect(month.deliveryIncome).toBe(
      first.deliveryIncome + second.deliveryIncome + refund.deliveryIncome
    );
    expect(month.deliveryCost).toBe(first.deliveryCost + second.deliveryCost + refund.deliveryCost);
    expect(month.moneyIn).toBe(60);
    expect(month.refunds).toBe(60);
    expect(month.profit).toBe(first.profit + second.profit + refund.profit);

    const detail = await t.query(api.sales.getDetail, { saleId });
    expect(detail?.profit).toBe(66);
    expect(first.moneyIn).toBe(60);
    expect(second.moneyIn).toBe(60);
    expect(refund.moneyIn).toBe(-60);
    expect((await dayReport(t, "2026-04-04")).moneyIn).toBe(0);
    expect(first.profit + second.profit).toBe(detail?.profit);

    const channels = await t.query(api.reports.getChannelReport, {
      period: { type: "month", value: "2026-04" },
    });
    const channel = channels.find((row) => row.channelId === ids.channelId);
    expect(channel?.revenue).toBe(60);
    expect(channel?.profit).toBe(32); // 60 cash - 21 item cost - 7 allocated delivery cost.
  });
});
