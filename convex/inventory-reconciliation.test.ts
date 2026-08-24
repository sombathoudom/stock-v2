import { convexTest } from "convex-test";
import { describe, expect, test, vi } from "vitest";

import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import schema from "./schema";

const AUTH_USER_ID = "inventory-reconciliation-owner";
let requestSequence = 0;

function requestKey(operation: string) {
  requestSequence += 1;
  return `${operation}-${requestSequence}`;
}

vi.mock("./auth", () => ({
  authComponent: {
    safeGetAuthUser: async () => ({
      _id: AUTH_USER_ID,
      name: "Inventory Owner",
      email: "inventory-reconciliation@test.local",
    }),
  },
}));

const modules = import.meta.glob("./**/*.ts");
type TestContext = ReturnType<typeof convexTest>;

async function seedCatalog(t: TestContext) {
  const base = await t.run(async (ctx) => {
    await ctx.db.insert("shop", {
      name: "Reconciliation Shop",
      currency: "USD",
      exchangeRate: 4000,
      timezone: "Asia/Phnom_Penh",
      deliveryEnabled: false,
      language: "en" as const,
    });
    const userId = await ctx.db.insert("users", {
      authUserId: AUTH_USER_ID,
      name: "Inventory Owner",
      email: "inventory-reconciliation@test.local",
      role: "owner" as const,
      active: true,
    });
    const productId = await ctx.db.insert("products", {
      name: "Oxford Shirt",
      nameLower: "oxford shirt",
      defaultPrice: 1500,
      defaultCost: 500,
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
    const variantXL = await ctx.db.insert("productVariants", {
      productId,
      size: "XL",
      price: 2000,
      active: true,
    });
    return { userId, variantM, variantL, variantXL };
  });

  const [supplier, customer, channel] = await Promise.all([
    t.mutation(api.suppliers.create, { name: "Central Garment Supply" }),
    t.mutation(api.customers.create, {
      name: "Sophea Chan",
      phone: "012 345 678",
      address: "Phnom Penh",
    }),
    t.mutation(api.channels.create, { name: "Facebook Main", type: "facebook" }),
  ]);
  return { ...base, supplierId: supplier._id, customerId: customer._id, channelId: channel._id };
}

async function receiveStock(
  t: TestContext,
  ids: Awaited<ReturnType<typeof seedCatalog>>,
  quantities: { m: number; l?: number; xl?: number }
) {
  const purchasedAt = Date.now() - 10_000;
  const lines = [{ variantId: ids.variantM, qty: quantities.m, unitCost: 600 }];
  if (quantities.l !== undefined) {
    lines.push({ variantId: ids.variantL, qty: quantities.l, unitCost: 700 });
  }
  if (quantities.xl !== undefined) {
    lines.push({ variantId: ids.variantXL, qty: quantities.xl, unitCost: 900 });
  }
  return await t.mutation(api.purchases.create, {
    idempotencyKey: requestKey("purchase-create"),
    supplierId: ids.supplierId,
    purchasedAt,
    receivedAt: purchasedAt + 1_000,
    lines,
  });
}

async function expectReconciled(
  t: TestContext,
  expectedStock: Map<Id<"productVariants">, number>
) {
  const state = await t.run(async (ctx) => ({
    variants: await ctx.db.query("productVariants").collect(),
    users: await ctx.db.query("users").collect(),
    suppliers: await ctx.db.query("suppliers").collect(),
    customers: await ctx.db.query("customers").collect(),
    channels: await ctx.db.query("salesChannels").collect(),
    purchases: await ctx.db.query("purchases").collect(),
    purchaseItems: await ctx.db.query("purchaseItems").collect(),
    sales: await ctx.db.query("sales").collect(),
    saleItems: await ctx.db.query("saleItems").collect(),
    payments: await ctx.db.query("payments").collect(),
    events: await ctx.db.query("saleEvents").collect(),
    ledger: await ctx.db.query("stockLedger").collect(),
  }));
  const byId = <T extends { _id: string }>(rows: T[]) => new Map(rows.map((row) => [row._id, row]));
  const variants = byId(state.variants);
  const users = byId(state.users);
  const suppliers = byId(state.suppliers);
  const customers = byId(state.customers);
  const channels = byId(state.channels);
  const purchases = byId(state.purchases);
  const purchaseItems = byId(state.purchaseItems);
  const sales = byId(state.sales);
  const saleItems = byId(state.saleItems);

  for (const purchase of state.purchases) {
    expect(suppliers.has(purchase.supplierId)).toBe(true);
    expect(users.has(purchase.userId)).toBe(true);
  }
  for (const item of state.purchaseItems) {
    const purchase = purchases.get(item.purchaseId);
    expect(purchase).toBeDefined();
    expect(variants.has(item.variantId)).toBe(true);
    const movements = state.ledger.filter((row) => row.purchaseItemId === item._id);
    if (purchase?.status === "received") {
      expect(movements).toHaveLength(1);
      expect(movements[0]).toMatchObject({
        reason: "purchase",
        variantId: item.variantId,
        delta: item.qty,
      });
    } else {
      expect(movements).toEqual([]);
    }
  }
  for (const sale of state.sales) {
    expect(customers.has(sale.customerId)).toBe(true);
    expect(channels.has(sale.salesChannelId)).toBe(true);
    expect(users.has(sale.userId)).toBe(true);
  }
  for (const item of state.saleItems) {
    expect(sales.has(item.saleId)).toBe(true);
    expect(variants.has(item.variantId)).toBe(true);
    expect(Number.isInteger(item.qtyOrdered)).toBe(true);
    expect(Number.isInteger(item.qtyDelivered)).toBe(true);
    expect(Number.isInteger(item.qtyCancelled)).toBe(true);
    expect(Number.isInteger(item.qtyReturned)).toBe(true);
    expect(item.qtyOrdered).toBeGreaterThanOrEqual(0);
    expect(item.qtyDelivered).toBeGreaterThanOrEqual(0);
    expect(item.qtyCancelled).toBeGreaterThanOrEqual(0);
    expect(item.qtyReturned).toBeGreaterThanOrEqual(0);
    expect(item.qtyReturned).toBeLessThanOrEqual(item.qtyDelivered);
    expect(item.qtyOrdered - item.qtyCancelled - item.qtyReturned).toBeGreaterThanOrEqual(0);
    expect(item.qtyDelivered - item.qtyReturned).toBeGreaterThanOrEqual(0);
  }

  for (const row of state.ledger) {
    expect(variants.has(row.variantId)).toBe(true);
    expect(users.has(row.userId)).toBe(true);
    if (row.reason === "purchase") {
      expect(row.saleItemId).toBeUndefined();
      const item = row.purchaseItemId ? purchaseItems.get(row.purchaseItemId) : undefined;
      const purchase = item ? purchases.get(item.purchaseId) : undefined;
      expect(item).toBeDefined();
      expect(purchase?.status).toBe("received");
      expect(row.variantId).toBe(item?.variantId);
      expect(row.delta).toBe(item?.qty);
      continue;
    }
    expect(row.purchaseItemId).toBeUndefined();
    if (row.reason === "stocktake") {
      expect(row.saleItemId).toBeUndefined();
      continue;
    }
    if (row.reason === "adjustment" && row.saleItemId === undefined) continue;

    const item = row.saleItemId ? saleItems.get(row.saleItemId) : undefined;
    expect(item).toBeDefined();
    expect(sales.has(item?.saleId ?? "")).toBe(true);
    const variantBelongsToLineHistory = (variantId: Id<"productVariants">, fromTs: number) =>
      item?.variantId === variantId ||
      state.ledger.some(
        (candidate) =>
          candidate.reason === "exchange_out" &&
          candidate.saleItemId === row.saleItemId &&
          candidate.variantId === variantId &&
          candidate.ts >= fromTs
      );
    if (row.reason === "exchange_out") {
      const pairedIn = state.ledger.find(
        (candidate) =>
          candidate.reason === "exchange_in" &&
          candidate.saleItemId === row.saleItemId &&
          candidate.ts === row.ts
      );
      expect(row.delta).toBeGreaterThan(0);
      expect(pairedIn).toBeDefined();
      expect(pairedIn && variantBelongsToLineHistory(pairedIn.variantId, pairedIn.ts)).toBe(true);
    } else {
      expect(variantBelongsToLineHistory(row.variantId, row.ts)).toBe(true);
    }
    if (row.reason === "sale" || row.reason === "exchange_in") {
      expect(row.delta).toBeLessThan(0);
    } else if (row.reason === "adjustment") {
      const pairedReturn = state.ledger.find(
        (candidate) =>
          candidate.reason === "return" &&
          candidate.saleItemId === row.saleItemId &&
          candidate.ts === row.ts &&
          candidate.delta === -row.delta
      );
      expect(row.delta).toBeLessThan(0);
      expect(pairedReturn).toBeDefined();
    } else {
      expect(row.delta).toBeGreaterThan(0);
    }
  }

  for (const payment of state.payments) {
    expect(sales.has(payment.saleId)).toBe(true);
    expect(users.has(payment.userId)).toBe(true);
    expect(Number.isInteger(payment.amount)).toBe(true);
    expect(payment.method === "refund" ? payment.amount < 0 : payment.amount > 0).toBe(true);
  }
  for (const event of state.events) {
    expect(sales.has(event.saleId)).toBe(true);
    expect(users.has(event.userId)).toBe(true);
  }

  for (const [variantId, expected] of expectedStock) {
    const actual = state.ledger
      .filter((row) => row.variantId === variantId)
      .reduce((sum, row) => sum + row.delta, 0);
    expect(actual).toBe(expected);
  }
  return state;
}

async function workflowSnapshot(t: TestContext, saleId: Id<"sales">) {
  return await t.run(async (ctx: MutationCtx) => {
    const items = await ctx.db
      .query("saleItems")
      .withIndex("by_sale", (q) => q.eq("saleId", saleId))
      .collect();
    return {
      items: items.map((item) => ({
        id: item._id,
        delivered: item.qtyDelivered,
        returned: item.qtyReturned,
        cancelled: item.qtyCancelled,
      })),
      ledgerCount: (await ctx.db.query("stockLedger").collect()).length,
      paymentCount: (
        await ctx.db
          .query("payments")
          .withIndex("by_sale", (q) => q.eq("saleId", saleId))
          .collect()
      ).length,
      eventCount: (
        await ctx.db
          .query("saleEvents")
          .withIndex("by_sale_ts", (q) => q.eq("saleId", saleId))
          .collect()
      ).length,
    };
  });
}

describe("inventory source and immutable-ledger reconciliation", () => {
  test("reconciles a received purchase through mixed sale, return, and count workflows", async () => {
    const t = convexTest(schema, modules);
    const ids = await seedCatalog(t);
    await receiveStock(t, ids, { m: 8, l: 5, xl: 4 });
    await expectReconciled(
      t,
      new Map([
        [ids.variantM, 8],
        [ids.variantL, 5],
        [ids.variantXL, 4],
      ])
    );

    const checkedOut = await t.mutation(api.sales.checkout, {
      idempotencyKey: requestKey("checkout"),
      customerId: ids.customerId,
      salesChannelId: ids.channelId,
      discount: 100,
      items: [
        { variantId: ids.variantM, qty: 2 },
        { variantId: ids.variantM, qty: 1 },
        { variantId: ids.variantL, qty: 2 },
      ],
      payment: { amount: 3000, method: "cash" },
    });
    expect(checkedOut.items.map(({ item }) => item.variantId)).toEqual([
      ids.variantM,
      ids.variantM,
      ids.variantL,
    ]);
    expect(checkedOut.items).toHaveLength(3);
    expect(checkedOut.items[0].item._id).not.toBe(checkedOut.items[1].item._id);
    await expectReconciled(
      t,
      new Map([
        [ids.variantM, 5],
        [ids.variantL, 3],
        [ids.variantXL, 4],
      ])
    );

    const [firstM, secondM, shirtL] = checkedOut.items.map(({ item }) => item);
    const edited = await t.mutation(api.sales.saveEdit, {
      idempotencyKey: requestKey("sale-edit"),
      saleId: checkedOut.sale._id,
      items: [
        { saleItemId: firstM._id, qty: 1 },
        { saleItemId: secondM._id, qty: 1 },
        { saleItemId: shirtL._id, variantId: ids.variantXL, qty: 2 },
      ],
    });
    expect(edited.items).toHaveLength(3);
    await expectReconciled(
      t,
      new Map([
        [ids.variantM, 6],
        [ids.variantL, 5],
        [ids.variantXL, 2],
      ])
    );

    await t.mutation(api.sales.setLineDelivered, {
      saleId: checkedOut.sale._id,
      adjustments: [
        { saleItemId: firstM._id, qtyDelivered: 1 },
        { saleItemId: secondM._id, qtyDelivered: 1 },
        { saleItemId: shirtL._id, qtyDelivered: 2 },
      ],
    });
    await t.mutation(api.sales.setStatus, { saleId: checkedOut.sale._id, status: "delivered" });
    await expectReconciled(
      t,
      new Map([
        [ids.variantM, 6],
        [ids.variantL, 5],
        [ids.variantXL, 2],
      ])
    );

    const beforeInvalidEdit = await workflowSnapshot(t, checkedOut.sale._id);
    await expect(
      t.mutation(api.sales.saveEdit, {
        idempotencyKey: requestKey("sale-edit"),
        saleId: checkedOut.sale._id,
        resolutions: [{ saleItemId: firstM._id, outcome: "returned_sellable", qty: 1 }],
        refund: { amount: 100, note: "Must roll back" },
        items: [
          { saleItemId: firstM._id, qty: 0 },
          { saleItemId: firstM._id, qty: 0 },
        ],
      })
    ).rejects.toThrow();
    expect(await workflowSnapshot(t, checkedOut.sale._id)).toEqual(beforeInvalidEdit);

    await t.mutation(api.sales.saveEdit, {
      idempotencyKey: requestKey("sale-edit"),
      saleId: checkedOut.sale._id,
      resolutions: [
        { saleItemId: firstM._id, outcome: "returned_sellable", qty: 1 },
        { saleItemId: secondM._id, outcome: "returned_damaged", qty: 1 },
      ],
      refund: { amount: 500, note: "Returned shirts" },
      items: [
        { saleItemId: firstM._id, qty: 0 },
        { saleItemId: secondM._id, qty: 0 },
        { saleItemId: shirtL._id, qty: 2 },
      ],
    });
    await t.mutation(api.payments.receive, {
      idempotencyKey: requestKey("payment"),
      saleId: checkedOut.sale._id,
      amount: 500,
      method: "bank_transfer",
    });
    await expectReconciled(
      t,
      new Map([
        [ids.variantM, 7],
        [ids.variantL, 5],
        [ids.variantXL, 2],
      ])
    );

    const detail = await t.query(api.sales.getDetail, { saleId: checkedOut.sale._id });
    expect(detail).not.toBeNull();
    expect(detail?.payments.map((payment) => payment.amount).toSorted((a, b) => a - b)).toEqual([
      -500,
      500,
      3000,
    ]);
    expect(detail?.paid).toBe(3000);
    expect(detail?.total).toBe(3900);
    expect(detail?.remaining).toBe(900);
    expect(detail?.profit).toBe(2100);
    expect(detail?.items.find(({ item }) => item._id === firstM._id)?.item.unitCostSnapshot).toBe(600);
    expect(detail?.items.find(({ item }) => item._id === shirtL._id)?.item.unitCostSnapshot).toBe(900);

    await t.mutation(api.adjustments.adjustStock, {
      idempotencyKey: requestKey("stock-adjustment"),
      variantId: ids.variantXL,
      delta: -1,
      note: "Damaged during shelf handling",
    });
    await expectReconciled(
      t,
      new Map([
        [ids.variantM, 7],
        [ids.variantL, 5],
        [ids.variantXL, 1],
      ])
    );
    await t.mutation(api.adjustments.recordStocktake, {
      rows: [
        { variantId: ids.variantM, countedQty: 6 },
        { variantId: ids.variantL, countedQty: 4 },
        { variantId: ids.variantXL, countedQty: 2 },
      ],
    });
    const finalState = await expectReconciled(
      t,
      new Map([
        [ids.variantM, 6],
        [ids.variantL, 4],
        [ids.variantXL, 2],
      ])
    );
    const standalone = finalState.ledger.filter(
      (row) => row.reason === "stocktake" || (row.reason === "adjustment" && !row.saleItemId)
    );
    expect(standalone).toHaveLength(4);
    expect(standalone.every((row) => !row.purchaseItemId && !row.saleItemId)).toBe(true);
  });

  test("serializes concurrent checkouts competing for the final unit", async () => {
    const t = convexTest(schema, modules);
    const ids = await seedCatalog(t);
    await receiveStock(t, ids, { m: 1 });
    const request = {
      customerId: ids.customerId,
      salesChannelId: ids.channelId,
      discount: 0,
      items: [{ variantId: ids.variantM, qty: 1 }],
    };

    const results = await Promise.allSettled([
      t.mutation(api.sales.checkout, {
        ...request,
        idempotencyKey: requestKey("last-unit-checkout"),
      }),
      t.mutation(api.sales.checkout, {
        ...request,
        idempotencyKey: requestKey("last-unit-checkout"),
      }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);

    const state = await expectReconciled(t, new Map([[ids.variantM, 0]]));
    expect(state.sales).toHaveLength(1);
    expect(state.saleItems).toHaveLength(1);
    expect(state.ledger.filter((row) => row.reason === "sale")).toHaveLength(1);
  });
});
