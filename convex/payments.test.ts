import { convexTest } from "convex-test";
import { describe, expect, test, vi } from "vitest";

import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { dayString } from "./helpers";
import schema from "./schema";

const AUTH_USER_ID = "payments-test-owner";
const TIMEZONE = "Asia/Phnom_Penh";

vi.mock("./auth", () => ({
  authComponent: {
    safeGetAuthUser: async () => ({
      _id: AUTH_USER_ID,
      name: "Payment Test Owner",
      email: "payments@test.local",
    }),
  },
}));

const modules = import.meta.glob("./**/*.ts");
type TestContext = ReturnType<typeof convexTest>;
type SeedIds = Awaited<ReturnType<typeof seed>>;

const requestSequences = new WeakMap<TestContext, number>();

function requestKey(t: TestContext, operation: "checkout" | "receive" | "refund") {
  const sequence = (requestSequences.get(t) ?? 0) + 1;
  requestSequences.set(t, sequence);
  return `payments-test:${operation}:${sequence}`;
}

/** Real inventory fixture: stock enters through a received purchase and leaves
 * through checkout, so every sale used below has a valid linked movement. */
async function seed(t: TestContext) {
  return await t.run(async (ctx) => {
    const now = Date.now() - 60_000;
    await ctx.db.insert("shop", {
      name: "Payment Test Shop",
      currency: "USD",
      exchangeRate: 4000,
      timezone: TIMEZONE,
      deliveryEnabled: true,
      language: "en" as const,
    });
    const userId = await ctx.db.insert("users", {
      authUserId: AUTH_USER_ID,
      name: "Payment Test Owner",
      email: "payments@test.local",
      role: "owner" as const,
      active: true,
    });
    const customerId = await ctx.db.insert("customers", {
      name: "Sokha",
      nameLower: "sokha",
      phone: "10123456",
      active: true,
    });
    const channelId = await ctx.db.insert("salesChannels", {
      name: "Facebook",
      nameLower: "facebook",
      type: "facebook" as const,
      active: true,
    });
    const productId = await ctx.db.insert("products", {
      name: "Linen Shirt",
      nameLower: "linen shirt",
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
      sku: "LINEN-M",
      active: true,
    });
    const supplierId = await ctx.db.insert("suppliers", {
      name: "Main Supplier",
      nameLower: "main supplier",
      active: true,
    });
    const purchaseId = await ctx.db.insert("purchases", {
      supplierId,
      code: "PAY-P-001",
      status: "received" as const,
      purchasedAt: now,
      receivedAt: now,
      userId,
      createdAt: now,
    });
    const purchaseItemId = await ctx.db.insert("purchaseItems", {
      purchaseId,
      variantId,
      qty: 30,
      unitCost: 400,
    });
    await ctx.db.insert("stockLedger", {
      variantId,
      delta: 30,
      reason: "purchase" as const,
      purchaseItemId,
      userId,
      ts: now,
    });
    return { userId, customerId, channelId, variantId };
  });
}

async function checkout(
  t: TestContext,
  ids: SeedIds,
  options: { qty?: number; deliveryFee?: number; discount?: number } = {}
) {
  return await t.mutation(api.sales.checkout, {
    idempotencyKey: requestKey(t, "checkout"),
    customerId: ids.customerId,
    salesChannelId: ids.channelId,
    discount: options.discount ?? 0,
    deliveryFee: options.deliveryFee ?? 0,
    items: [{ variantId: ids.variantId, qty: options.qty ?? 1 }],
  });
}

async function rawPayments(t: TestContext, saleId: Id<"sales">) {
  return await t.run(async (ctx: MutationCtx) =>
    ctx.db
      .query("payments")
      .withIndex("by_sale", (q) => q.eq("saleId", saleId))
      .collect()
  );
}

async function rawPaymentEvents(t: TestContext, saleId: Id<"sales">) {
  return await t.run(async (ctx: MutationCtx) =>
    (
      await ctx.db
        .query("saleEvents")
        .withIndex("by_sale_ts", (q) => q.eq("saleId", saleId))
        .collect()
    ).filter((row) => row.type === "payment_received" || row.type === "refund")
  );
}

async function ledgerSnapshot(t: TestContext, variantId: Id<"productVariants">) {
  const rows = await t.run(async (ctx: MutationCtx) =>
    ctx.db
      .query("stockLedger")
      .withIndex("by_variant_ts", (q) => q.eq("variantId", variantId))
      .collect()
  );
  return {
    ids: rows.map((row) => row._id),
    sum: rows.reduce((sum, row) => sum + row.delta, 0),
  };
}

/** Re-derive all money from raw rows and all stock from immutable movements;
 * no production total helper is used for either independent sum. */
async function verifyIndependentState(
  t: TestContext,
  saleId: Id<"sales">,
  variantId: Id<"productVariants">,
  expected: {
    total: number;
    paymentAmounts: number[];
    ledgerSum: number;
    remaining?: number;
    overpaid?: number;
  }
) {
  const payments = await rawPayments(t, saleId);
  const paymentSum = payments.reduce((sum, row) => sum + row.amount, 0);
  const detail = await t.query(api.sales.getDetail, { saleId });
  const ledger = await ledgerSnapshot(t, variantId);

  expect(detail).not.toBeNull();
  expect(detail!.total).toBe(expected.total);
  expect(payments.map((row) => row.amount)).toEqual(expected.paymentAmounts);
  expect(detail!.paid).toBe(paymentSum);
  expect(detail!.remaining).toBe(Math.max(expected.total - paymentSum, 0));
  expect(Math.max(paymentSum - expected.total, 0)).toBe(expected.overpaid ?? 0);
  expect(detail!.remaining).toBe(expected.remaining ?? Math.max(expected.total - paymentSum, 0));
  expect(ledger.sum).toBe(expected.ledgerSum);
  return { payments, paymentSum, detail: detail!, ledger };
}

async function errorCodeOf(promise: Promise<unknown>) {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return (error as { data?: { code?: string } }).data?.code;
  }
}

describe("payments", () => {
  test("partial payment followed by an overpay records only the full remaining balance", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const order = await checkout(t, ids, { qty: 2, deliveryFee: 400, discount: 100 });
    const before = await ledgerSnapshot(t, ids.variantId);

    const partial = await t.mutation(api.payments.receive, {
      idempotencyKey: requestKey(t, "receive"),
      saleId: order.sale._id,
      amount: 600,
      method: "cash",
    });
    expect(partial.amount).toBe(600);
    expect(await ledgerSnapshot(t, ids.variantId)).toEqual(before);

    const clamped = await t.mutation(api.payments.receive, {
      idempotencyKey: requestKey(t, "receive"),
      saleId: order.sale._id,
      amount: 5000,
      method: "bank_transfer",
    });
    expect(clamped.amount).toBe(1700);
    expect(await ledgerSnapshot(t, ids.variantId)).toEqual(before);

    await verifyIndependentState(t, order.sale._id, ids.variantId, {
      total: 2300,
      paymentAmounts: [600, 1700],
      remaining: 0,
      ledgerSum: 28,
    });
  });

  test("refunds may be less than or equal to net paid but never greater", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const order = await checkout(t, ids, { qty: 2 });
    const before = await ledgerSnapshot(t, ids.variantId);

    await t.mutation(api.payments.receive, {
      idempotencyKey: requestKey(t, "receive"),
      saleId: order.sale._id,
      amount: 1800,
      method: "other",
    });
    const partialRefund = await t.mutation(api.payments.refund, {
      idempotencyKey: requestKey(t, "refund"),
      saleId: order.sale._id,
      amount: 300,
      note: "Price correction",
    });
    expect(partialRefund.amount).toBe(-300);
    const equalRefund = await t.mutation(api.payments.refund, {
      idempotencyKey: requestKey(t, "refund"),
      saleId: order.sale._id,
      amount: 1500,
    });
    expect(equalRefund.amount).toBe(-1500);

    const rowsBeforeFailure = await rawPayments(t, order.sale._id);
    const eventsBeforeFailure = await rawPaymentEvents(t, order.sale._id);
    expect(
      await errorCodeOf(
        t.mutation(api.payments.refund, {
          idempotencyKey: requestKey(t, "refund"),
          saleId: order.sale._id,
          amount: 1,
        })
      )
    ).toBe("INVALID_PAYMENT");
    expect(await rawPayments(t, order.sale._id)).toEqual(rowsBeforeFailure);
    expect(await rawPaymentEvents(t, order.sale._id)).toEqual(eventsBeforeFailure);
    expect(await ledgerSnapshot(t, ids.variantId)).toEqual(before);

    await verifyIndependentState(t, order.sale._id, ids.variantId, {
      total: 2000,
      paymentAmounts: [1800, -300, -1500],
      remaining: 2000,
      ledgerSum: 28,
    });
  });

  test("retained shipping remains payable after cancellation and paid-before-cancel becomes overpaid", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);

    const unpaid = await checkout(t, ids, { deliveryFee: 300 });
    await t.mutation(api.sales.setStatus, {
      saleId: unpaid.sale._id,
      status: "cancelled",
      chargeDeliveryFee: true,
    });
    const afterCancel = await ledgerSnapshot(t, ids.variantId);
    const shippingPayment = await t.mutation(api.payments.receive, {
      idempotencyKey: requestKey(t, "receive"),
      saleId: unpaid.sale._id,
      amount: 1000,
      method: "cash",
    });
    expect(shippingPayment.amount).toBe(300);
    expect(await ledgerSnapshot(t, ids.variantId)).toEqual(afterCancel);
    await verifyIndependentState(t, unpaid.sale._id, ids.variantId, {
      total: 300,
      paymentAmounts: [300],
      remaining: 0,
      ledgerSum: 30,
    });

    const prepaid = await checkout(t, ids, { deliveryFee: 300 });
    const beforePayment = await ledgerSnapshot(t, ids.variantId);
    await t.mutation(api.payments.receive, {
      idempotencyKey: requestKey(t, "receive"),
      saleId: prepaid.sale._id,
      amount: 1300,
      method: "bank_transfer",
    });
    expect(await ledgerSnapshot(t, ids.variantId)).toEqual(beforePayment);
    await t.mutation(api.sales.setStatus, {
      saleId: prepaid.sale._id,
      status: "cancelled",
      chargeDeliveryFee: true,
    });
    await verifyIndependentState(t, prepaid.sale._id, ids.variantId, {
      total: 300,
      paymentAmounts: [1300],
      remaining: 0,
      overpaid: 1000,
      ledgerSum: 30,
    });
  });

  test("backdated receipts use the shop day and link exact payment audit events", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const order = await checkout(t, ids);
    const before = await ledgerSnapshot(t, ids.variantId);
    const receivedAt = Date.UTC(2026, 0, 14, 18, 30);

    const received = await t.mutation(api.payments.receive, {
      idempotencyKey: requestKey(t, "receive"),
      saleId: order.sale._id,
      amount: 700,
      method: "cash",
      note: "  Counter receipt  ",
      receivedAt,
    });
    const refunded = await t.mutation(api.payments.refund, {
      idempotencyKey: requestKey(t, "refund"),
      saleId: order.sale._id,
      amount: 200,
      note: "  Customer refund  ",
    });
    const events = await rawPaymentEvents(t, order.sale._id);

    expect(received.receivedAt).toBe(receivedAt);
    expect(received.receivedDay).toBe(dayString(receivedAt, TIMEZONE));
    expect(received.note).toBe("Counter receipt");
    expect(refunded.receivedDay).toBe(dayString(refunded.receivedAt, TIMEZONE));
    expect(events).toHaveLength(2);
    for (const payment of [received, refunded]) {
      const event = events.find(
        (candidate) =>
          candidate.saleId === payment.saleId &&
          candidate.userId === payment.userId &&
          candidate.ts === payment.receivedAt
      );
      expect(event).toBeDefined();
      expect(event!.payload?.amount).toBe(String(Math.abs(payment.amount)));
      expect(event!.type).toBe(payment.amount < 0 ? "refund" : "payment_received");
    }
    expect(await ledgerSnapshot(t, ids.variantId)).toEqual(before);
    await verifyIndependentState(t, order.sale._id, ids.variantId, {
      total: 1000,
      paymentAmounts: [700, -200],
      remaining: 500,
      ledgerSum: 29,
    });
  });

  test("invalid amounts and dates roll back payment and event writes", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const order = await checkout(t, ids);
    const ledger = await ledgerSnapshot(t, ids.variantId);

    const invalidReceives = [
      { amount: 0, expected: "INVALID_PAYMENT" },
      { amount: -1, expected: "INVALID_PAYMENT" },
      { amount: 1.5, expected: "INVALID_MONEY" },
    ];
    for (const invalid of invalidReceives) {
      expect(
        await errorCodeOf(
          t.mutation(api.payments.receive, {
            idempotencyKey: requestKey(t, "receive"),
            saleId: order.sale._id,
            amount: invalid.amount,
            method: "cash",
          })
        )
      ).toBe(invalid.expected);
      expect(await rawPayments(t, order.sale._id)).toEqual([]);
      expect(await rawPaymentEvents(t, order.sale._id)).toEqual([]);
      expect(await ledgerSnapshot(t, ids.variantId)).toEqual(ledger);
    }
    expect(
      await errorCodeOf(
        t.mutation(api.payments.receive, {
          idempotencyKey: requestKey(t, "receive"),
          saleId: order.sale._id,
          amount: 100,
          method: "cash",
          receivedAt: Date.now() + 86_400_000,
        })
      )
    ).toBe("INVALID_PAYMENT");
    expect(await rawPayments(t, order.sale._id)).toEqual([]);
    expect(await rawPaymentEvents(t, order.sale._id)).toEqual([]);

    await t.mutation(api.payments.receive, {
      idempotencyKey: requestKey(t, "receive"),
      saleId: order.sale._id,
      amount: 500,
      method: "cash",
    });
    const paymentsBeforeRefunds = await rawPayments(t, order.sale._id);
    const eventsBeforeRefunds = await rawPaymentEvents(t, order.sale._id);
    for (const amount of [0, -1, 1.5, 501]) {
      expect(
        await errorCodeOf(
          t.mutation(api.payments.refund, {
            idempotencyKey: requestKey(t, "refund"),
            saleId: order.sale._id,
            amount,
          })
        )
      ).toMatch(/INVALID_(PAYMENT|MONEY)/);
      expect(await rawPayments(t, order.sale._id)).toEqual(paymentsBeforeRefunds);
      expect(await rawPaymentEvents(t, order.sale._id)).toEqual(eventsBeforeRefunds);
      expect(await ledgerSnapshot(t, ids.variantId)).toEqual(ledger);
    }
    await verifyIndependentState(t, order.sale._id, ids.variantId, {
      total: 1000,
      paymentAmounts: [500],
      remaining: 500,
      ledgerSum: 29,
    });
  });

  test("concurrent receives serialize against one remaining balance", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const order = await checkout(t, ids);
    const before = await ledgerSnapshot(t, ids.variantId);

    const received = await Promise.all([
      t.mutation(api.payments.receive, {
        idempotencyKey: requestKey(t, "receive"),
        saleId: order.sale._id,
        amount: 800,
        method: "cash",
      }),
      t.mutation(api.payments.receive, {
        idempotencyKey: requestKey(t, "receive"),
        saleId: order.sale._id,
        amount: 800,
        method: "bank_transfer",
      }),
    ]);
    expect(received.map((row) => row.amount).sort((a, b) => a - b)).toEqual([200, 800]);
    expect(await ledgerSnapshot(t, ids.variantId)).toEqual(before);

    const state = await verifyIndependentState(t, order.sale._id, ids.variantId, {
      total: 1000,
      paymentAmounts: (await rawPayments(t, order.sale._id)).map((row) => row.amount),
      remaining: 0,
      ledgerSum: 29,
    });
    expect(state.paymentSum).toBe(1000);
    expect(state.payments).toHaveLength(2);
  });

  test("concurrent refunds serialize against the limited net paid balance", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const order = await checkout(t, ids);
    await t.mutation(api.payments.receive, {
      idempotencyKey: requestKey(t, "receive"),
      saleId: order.sale._id,
      amount: 1000,
      method: "cash",
    });
    const before = await ledgerSnapshot(t, ids.variantId);

    const results = await Promise.all(
      [700, 700].map(async (amount) => {
        try {
          return {
            status: "fulfilled" as const,
            payment: await t.mutation(api.payments.refund, {
              idempotencyKey: requestKey(t, "refund"),
              saleId: order.sale._id,
              amount,
            }),
          };
        } catch (error) {
          return {
            status: "rejected" as const,
            code: (error as { data?: { code?: string } }).data?.code,
          };
        }
      })
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toEqual([
      { status: "rejected", code: "INVALID_PAYMENT" },
    ]);
    expect(await ledgerSnapshot(t, ids.variantId)).toEqual(before);

    await verifyIndependentState(t, order.sale._id, ids.variantId, {
      total: 1000,
      paymentAmounts: [1000, -700],
      remaining: 700,
      ledgerSum: 29,
    });
  });
});
