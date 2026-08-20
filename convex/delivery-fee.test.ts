import { convexTest } from "convex-test";
import { describe, expect, test, vi } from "vitest";

import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import schema from "./schema";

// Delivery-fee survival (shipping charged to the customer must never vanish):
// the fee stands on its own without a company, survives saves that don't
// touch it, and stays visible/editable on orders that carry delivery data
// even after the shop turns the module off — while adding a fee to a
// fee-less order with the module off is still rejected.

const AUTH_USER_ID = "test-auth-user";
vi.mock("./auth", () => ({
  authComponent: {
    safeGetAuthUser: vi.fn(async () => ({
      _id: AUTH_USER_ID,
      name: "Test Owner",
      email: "owner@test.local",
    })),
  },
}));
const modules = import.meta.glob("./**/*.ts");

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
    const companyId = await ctx.db.insert("deliveryCompanies", {
      name: "J&T",
      nameLower: "j&t",
      defaultFee: 300,
      active: true,
    });
    const teeId = await ctx.db.insert("products", {
      name: "Basic Tee",
      nameLower: "basic tee",
      defaultPrice: 1000,
      defaultCost: 400,
      hasColors: false,
      sizes: ["M"],
      colors: [],
      active: true,
    });
    const teeM = await ctx.db.insert("productVariants", {
      productId: teeId,
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
      variantId: teeM,
      qty: 10,
      unitCost: 400,
    });
    await ctx.db.insert("stockLedger", {
      variantId: teeM,
      delta: 10,
      reason: "purchase" as const,
      purchaseItemId,
      userId,
      ts: now,
    });
    return { userId, customerId, channelId, companyId, teeM };
  });
}


async function errorCodeOf(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
    return undefined;
  } catch (err) {
    return (err as { data?: { code?: string } }).data?.code;
  }
}

describe("shipping fee survival", () => {
  test("fee with no company survives checkout and edit", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);

    // Self-delivery: fee stands on its own, no company.
    const detail = await t.mutation(api.sales.checkout, {
      customerId: ids.customerId,
      salesChannelId: ids.channelId,
      discount: 0,
      deliveryFee: 500,
      items: [{ variantId: ids.teeM, qty: 1 }],
    });
    expect(detail.sale.deliveryFee).toBe(500);
    expect(detail.total).toBe(1500);

    // Edit WITHOUT touching delivery fields (the form sends nothing when
    // delivery is off, or the same values when on).
    const edited = await t.mutation(api.sales.saveEdit, {
      saleId: detail.sale._id,
      items: [{ saleItemId: detail.items[0].item._id, qty: 1 }],
    });
    expect(edited.sale.deliveryFee).toBe(500);
    expect(edited.total).toBe(1500);
  });

  test("fee with company: edit keeps company default when fee untouched", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);

    // POS sends company but NO fee → company default 300 lands.
    const detail = await t.mutation(api.sales.checkout, {
      customerId: ids.customerId,
      salesChannelId: ids.channelId,
      deliveryCompanyId: ids.companyId,
      discount: 0,
      items: [{ variantId: ids.teeM, qty: 1 }],
    });
    expect(detail.sale.deliveryFee).toBe(300);
    expect(detail.sale.deliveryCost).toBe(300);

    // The EDIT page's exact payload: it ALWAYS sends the fee field when the
    // module is on (seeded from the sale). Same values → nothing changes.
    const edited = await t.mutation(api.sales.saveEdit, {
      saleId: detail.sale._id,
      items: [{ saleItemId: detail.items[0].item._id, qty: 1 }],
      customerId: ids.customerId,
      salesChannelId: ids.channelId,
      deliveryCompanyId: ids.companyId as Id<"deliveryCompanies">,
      deliveryFee: 300,
      deliveryCost: 300,
      discount: 0,
      note: null,
    });
    expect(edited.sale.deliveryFee).toBe(300);
    expect(edited.total).toBe(1300);
  });

  test("edit form payload with companyId empty string -> null keeps fee", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const detail = await t.mutation(api.sales.checkout, {
      customerId: ids.customerId,
      salesChannelId: ids.channelId,
      discount: 0,
      deliveryFee: 500,
      items: [{ variantId: ids.teeM, qty: 1 }],
    });

    // The form sends `deliveryCompanyId: (values.companyId || null)` — "" → null.
    const edited = await t.mutation(api.sales.saveEdit, {
      saleId: detail.sale._id,
      items: [{ saleItemId: detail.items[0].item._id, qty: 1 }],
      customerId: ids.customerId,
      salesChannelId: ids.channelId,
      deliveryCompanyId: null,
      deliveryFee: 500,
      deliveryCost: 0,
      discount: 0,
      note: null,
    });
    expect(edited.sale.deliveryFee).toBe(500);
    expect(edited.total).toBe(1500);
  });

  test("module off: order with legacy fee stays editable; fee-less order rejects fees", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);

    // Create the fee-bearing order while the module is ON, then turn the
    // module off — the order keeps its fee (nothing is ever rewritten).
    const detail = await t.mutation(api.sales.checkout, {
      customerId: ids.customerId,
      salesChannelId: ids.channelId,
      discount: 0,
      deliveryFee: 500,
      items: [{ variantId: ids.teeM, qty: 1 }],
    });
    expect(detail.sale.deliveryFee).toBe(500);
    await t.run(async (ctx) => {
      const shop = await ctx.db.query("shop").first();
      await ctx.db.patch(shop!._id, { deliveryEnabled: false });
    });

    // The edit page sends the delivery fields (order carries a fee) — kept.
    const edited = await t.mutation(api.sales.saveEdit, {
      saleId: detail.sale._id,
      items: [{ saleItemId: detail.items[0].item._id, qty: 1 }],
      customerId: ids.customerId,
      salesChannelId: ids.channelId,
      deliveryCompanyId: null,
      deliveryFee: 500,
      deliveryCost: 0,
      discount: 0,
      note: null,
    });
    expect(edited.sale.deliveryFee).toBe(500);
    expect(edited.total).toBe(1500);

    // A fee on a fee-less order while the module is off is still rejected.
    const feeLess = await t.mutation(api.sales.checkout, {
      customerId: ids.customerId,
      salesChannelId: ids.channelId,
      discount: 0,
      items: [{ variantId: ids.teeM, qty: 1 }],
    });
    const rejected = await errorCodeOf(
      t.mutation(api.sales.saveEdit, {
        saleId: feeLess.sale._id,
        items: [{ saleItemId: feeLess.items[0].item._id, qty: 1 }],
        deliveryFee: 500,
      })
    );
    expect(rejected).toBe("INVALID_INPUT");
  });
});
