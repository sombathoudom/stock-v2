import { convexTest } from "convex-test";
import { describe, expect, test, vi } from "vitest";

import { api } from "./_generated/api";
import schema from "./schema";

const OWNER_AUTH_ID = "idempotency-owner";
const INACTIVE_AUTH_ID = "idempotency-inactive-user";

type AuthUser = { _id: string; name: string; email: string };

const authState = vi.hoisted(() => ({
  current: {
    _id: "idempotency-owner",
    name: "Sreyneang Owner",
    email: "owner@idempotency.test",
  } as AuthUser | null,
}));

vi.mock("./auth", () => ({
  authComponent: {
    safeGetAuthUser: async () => authState.current,
  },
}));

const modules = import.meta.glob("./**/*.ts");
type TestContext = ReturnType<typeof convexTest>;
type SeedIds = Awaited<ReturnType<typeof seed>>;

const ownerAuth: AuthUser = {
  _id: OWNER_AUTH_ID,
  name: "Sreyneang Owner",
  email: "owner@idempotency.test",
};
const inactiveAuth: AuthUser = {
  _id: INACTIVE_AUTH_ID,
  name: "Former Cashier",
  email: "former@idempotency.test",
};

function signInAs(user: AuthUser | null) {
  authState.current = user;
}

async function errorCodeOf(promise: Promise<unknown>) {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return (error as { data?: { code?: string } }).data?.code;
  }
}

async function seed(t: TestContext) {
  signInAs(ownerAuth);
  const ids = await t.run(async (ctx) => {
    await ctx.db.insert("shop", {
      name: "Lotus Clothing",
      address: "Russian Market, Phnom Penh",
      currency: "USD",
      exchangeRate: 4100,
      timezone: "Asia/Phnom_Penh",
      deliveryEnabled: true,
      language: "en" as const,
    });
    const userId = await ctx.db.insert("users", {
      authUserId: OWNER_AUTH_ID,
      name: ownerAuth.name,
      email: ownerAuth.email,
      role: "owner" as const,
      active: true,
    });
    await ctx.db.insert("users", {
      authUserId: INACTIVE_AUTH_ID,
      name: inactiveAuth.name,
      email: inactiveAuth.email,
      role: "staff" as const,
      active: false,
    });
    const categoryId = await ctx.db.insert("categories", {
      name: "Tops",
      nameLower: "tops",
      active: true,
    });
    const productId = await ctx.db.insert("products", {
      name: "Linen Blouse",
      nameLower: "linen blouse",
      categoryId,
      defaultPrice: 2500,
      defaultCost: 900,
      hasColors: true,
      sizes: ["M"],
      colors: ["Cream"],
      active: true,
    });
    const variantId = await ctx.db.insert("productVariants", {
      productId,
      size: "M",
      color: "Cream",
      sku: "LB-M-CREAM",
      active: true,
    });
    const customerId = await ctx.db.insert("customers", {
      name: "Chan Dara",
      nameLower: "chan dara",
      phone: "12123456",
      address: "Toul Kork, Phnom Penh",
      active: true,
    });
    const channelId = await ctx.db.insert("salesChannels", {
      name: "Facebook Main Page",
      nameLower: "facebook main page",
      type: "facebook" as const,
      active: true,
    });
    const supplierId = await ctx.db.insert("suppliers", {
      name: "Phnom Penh Garment Supply",
      nameLower: "phnom penh garment supply",
      phone: "12888777",
      active: true,
    });
    return { userId, variantId, customerId, channelId, supplierId };
  });

  // Opening stock uses the same public transaction path as the application.
  const purchasedAt = Date.now() - 10_000;
  await t.mutation(api.purchases.create, {
    idempotencyKey: "shared-operation-key",
    supplierId: ids.supplierId,
    purchasedAt,
    receivedAt: purchasedAt + 1_000,
    notes: "Opening stock",
    lines: [{ variantId: ids.variantId, qty: 100, unitCost: 900 }],
  });
  return ids;
}

async function state(t: TestContext) {
  return await t.run(async (ctx) => {
    const [sales, saleItems, purchases, purchaseItems, payments, events, ledger, records] =
      await Promise.all([
        ctx.db.query("sales").collect(),
        ctx.db.query("saleItems").collect(),
        ctx.db.query("purchases").collect(),
        ctx.db.query("purchaseItems").collect(),
        ctx.db.query("payments").collect(),
        ctx.db.query("saleEvents").collect(),
        ctx.db.query("stockLedger").collect(),
        ctx.db.query("idempotencyRecords").collect(),
      ]);
    return {
      sales: sales.length,
      saleItems: saleItems.length,
      purchases: purchases.length,
      purchaseItems: purchaseItems.length,
      payments: payments.length,
      events: events.length,
      ledger: ledger.length,
      ledgerSum: ledger.reduce((sum, row) => sum + row.delta, 0),
      records: records.length,
    };
  });
}

type State = Awaited<ReturnType<typeof state>>;

function expectDelta(after: State, before: State, delta: Partial<State>) {
  for (const key of Object.keys(before) as (keyof State)[]) {
    expect(after[key], key).toBe(before[key] + (delta[key] ?? 0));
  }
}

type ExerciseOptions<Args, Result> = {
  t: TestContext;
  firstKey?: string;
  makeArgs: (key: string) => Args;
  makeConflictArgs: (key: string) => Args;
  invoke: (args: Args) => Promise<Result>;
  primaryId: (result: Result) => string;
  effect: Partial<State>;
  deniedAs: "inactive" | "unauthenticated";
};

async function exerciseOperation<Args, Result>({
  t,
  firstKey = "shared-operation-key",
  makeArgs,
  makeConflictArgs,
  invoke,
  primaryId,
  effect,
  deniedAs,
}: ExerciseOptions<Args, Result>) {
  const firstArgs = makeArgs(firstKey);
  const beforeFirst = await state(t);
  const first = await invoke(firstArgs);
  const afterFirst = await state(t);
  expectDelta(afterFirst, beforeFirst, effect);

  // A UI double-click is two sequential calls with one request key.
  const replay = await invoke(firstArgs);
  expect(primaryId(replay)).toBe(primaryId(first));
  expect(await state(t)).toEqual(afterFirst);

  // The first call committed, but its response was lost; only the retry is observed.
  const timeoutArgs = makeArgs("simulated-timeout-key");
  await invoke(timeoutArgs);
  const afterIgnoredSuccess = await state(t);
  const timeoutRetry = await invoke(timeoutArgs);
  expect(await state(t)).toEqual(afterIgnoredSuccess);

  const concurrentArgs = makeArgs("concurrent-double-click-key");
  const beforeConcurrent = await state(t);
  const [concurrentA, concurrentB] = await Promise.all([
    invoke(concurrentArgs),
    invoke(concurrentArgs),
  ]);
  expect(primaryId(concurrentA)).toBe(primaryId(concurrentB));
  expectDelta(await state(t), beforeConcurrent, effect);

  const beforeConflict = await state(t);
  expect(await errorCodeOf(invoke(makeConflictArgs(firstKey)))).toBe(
    "IDEMPOTENCY_CONFLICT"
  );
  expect(await state(t)).toEqual(beforeConflict);

  const beforeIndependent = await state(t);
  const independentA = await invoke(makeArgs("independent-key-a"));
  const independentB = await invoke(makeArgs("independent-key-b"));
  expect(primaryId(independentA)).not.toBe(primaryId(independentB));
  const twice = Object.fromEntries(
    Object.entries(effect).map(([key, value]) => [key, value * 2])
  ) as Partial<State>;
  expectDelta(await state(t), beforeIndependent, twice);

  const beforeDenied = await state(t);
  signInAs(deniedAs === "inactive" ? inactiveAuth : null);
  try {
    const code = await errorCodeOf(invoke(firstArgs));
    expect(code).toBe(deniedAs === "inactive" ? "NO_STAFF_RECORD" : "UNAUTHORIZED");
    expect(await state(t)).toEqual(beforeDenied);
  } finally {
    signInAs(ownerAuth);
  }

  return { first, timeoutRetry, concurrentA, independentA, independentB };
}

async function checkoutSale(t: TestContext, ids: SeedIds, key: string, qty = 1) {
  return await t.mutation(api.sales.checkout, {
    idempotencyKey: key,
    customerId: ids.customerId,
    salesChannelId: ids.channelId,
    deliveryFee: 0,
    discount: 0,
    items: [{ variantId: ids.variantId, qty }],
  });
}

describe("idempotent public mutations", () => {
  test("sales.checkout has one sale, event, and stock effect per scoped key", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const result = await exerciseOperation({
      t,
      makeArgs: (idempotencyKey) => ({
        idempotencyKey,
        customerId: ids.customerId,
        salesChannelId: ids.channelId,
        deliveryFee: 0,
        discount: 0,
        items: [{ variantId: ids.variantId, qty: 2 }],
      }),
      makeConflictArgs: (idempotencyKey) => ({
        idempotencyKey,
        customerId: ids.customerId,
        salesChannelId: ids.channelId,
        deliveryFee: 0,
        discount: 0,
        items: [{ variantId: ids.variantId, qty: 3 }],
      }),
      invoke: (args) => t.mutation(api.sales.checkout, args),
      primaryId: (value) => value.sale._id,
      effect: { sales: 1, saleItems: 1, events: 1, ledger: 1, ledgerSum: -2, records: 1 },
      deniedAs: "inactive",
    });

    expect(result.first.sale._id).toBeTruthy();
    const snapshot = await state(t);
    expect(snapshot.ledgerSum).toBe(90);
    expect(snapshot.sales).toBe(5);
    expect(snapshot.events).toBe(5);
  });

  test("purchases.create has one purchase, item, and stock effect per scoped key", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const purchasedAt = Date.now() - 20_000;
    const result = await exerciseOperation({
      t,
      firstKey: "purchase-create-primary",
      makeArgs: (idempotencyKey) => ({
        idempotencyKey,
        supplierId: ids.supplierId,
        purchasedAt,
        receivedAt: purchasedAt + 1_000,
        notes: "Restock linen blouse",
        lines: [{ variantId: ids.variantId, qty: 3, unitCost: 950 }],
      }),
      makeConflictArgs: (idempotencyKey) => ({
        idempotencyKey,
        supplierId: ids.supplierId,
        purchasedAt,
        receivedAt: purchasedAt + 1_000,
        notes: "Restock linen blouse",
        lines: [{ variantId: ids.variantId, qty: 4, unitCost: 950 }],
      }),
      invoke: (args) => t.mutation(api.purchases.create, args),
      primaryId: (value) => value._id,
      effect: { purchases: 1, purchaseItems: 1, ledger: 1, ledgerSum: 3, records: 1 },
      deniedAs: "unauthenticated",
    });

    expect(result.first.status).toBe("received");
    const snapshot = await state(t);
    expect(snapshot.purchases).toBe(6);
    expect(snapshot.purchaseItems).toBe(6);
    expect(snapshot.ledgerSum).toBe(115);
  });

  test("payments.receive has one positive payment and audit event per scoped key", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const order = await checkoutSale(t, ids, "payment-sale", 2);
    const result = await exerciseOperation({
      t,
      makeArgs: (idempotencyKey) => ({
        idempotencyKey,
        saleId: order.sale._id,
        amount: 100,
        method: "cash" as const,
        note: "Customer deposit",
      }),
      makeConflictArgs: (idempotencyKey) => ({
        idempotencyKey,
        saleId: order.sale._id,
        amount: 200,
        method: "cash" as const,
        note: "Customer deposit",
      }),
      invoke: (args) => t.mutation(api.payments.receive, args),
      primaryId: (value) => value._id,
      effect: { payments: 1, events: 1, records: 1 },
      deniedAs: "inactive",
    });

    expect(result.first.amount).toBe(100);
    const rows = await t.run(async (ctx) => ctx.db.query("payments").collect());
    expect(rows).toHaveLength(5);
    expect(rows.map((row) => row.amount)).toEqual([100, 100, 100, 100, 100]);
    expect((await state(t)).ledgerSum).toBe(98);
  });

  test("payments.refund has one negative payment and audit event per scoped key", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const order = await checkoutSale(t, ids, "refund-sale", 2);
    await t.mutation(api.payments.receive, {
      idempotencyKey: "refund-opening-payment",
      saleId: order.sale._id,
      amount: 1000,
      method: "bank_transfer",
    });
    const result = await exerciseOperation({
      t,
      makeArgs: (idempotencyKey) => ({
        idempotencyKey,
        saleId: order.sale._id,
        amount: 100,
        note: "Price correction",
      }),
      makeConflictArgs: (idempotencyKey) => ({
        idempotencyKey,
        saleId: order.sale._id,
        amount: 200,
        note: "Price correction",
      }),
      invoke: (args) => t.mutation(api.payments.refund, args),
      primaryId: (value) => value._id,
      effect: { payments: 1, events: 1, records: 1 },
      deniedAs: "unauthenticated",
    });

    expect(result.first).toMatchObject({ amount: -100, method: "refund" });
    const rows = await t.run(async (ctx) => ctx.db.query("payments").collect());
    expect(rows.map((row) => row.amount)).toEqual([1000, -100, -100, -100, -100, -100]);
    expect(rows.filter((row) => row.method === "refund")).toHaveLength(5);
    expect((await state(t)).ledgerSum).toBe(98);
  });

  test("adjustments.adjustStock has one signed ledger effect per scoped key", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const result = await exerciseOperation({
      t,
      makeArgs: (idempotencyKey) => ({
        idempotencyKey,
        variantId: ids.variantId,
        delta: 2,
        note: "Found during shelf count",
      }),
      makeConflictArgs: (idempotencyKey) => ({
        idempotencyKey,
        variantId: ids.variantId,
        delta: 3,
        note: "Found during shelf count",
      }),
      invoke: (args) => t.mutation(api.adjustments.adjustStock, args),
      primaryId: (value) => value._id,
      effect: { ledger: 1, ledgerSum: 2, records: 1 },
      deniedAs: "inactive",
    });

    expect(result.first).toMatchObject({ delta: 2, reason: "adjustment" });
    const ledger = await t.run(async (ctx) => ctx.db.query("stockLedger").collect());
    expect(ledger.filter((row) => row.reason === "adjustment")).toHaveLength(5);
    expect(ledger.reduce((sum, row) => sum + row.delta, 0)).toBe(110);
  });

  test("sales.saveEdit replays before stale-version validation and never repeats diffs", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const order = await checkoutSale(t, ids, "save-edit-sale", 1);
    const saleItemId = order.items[0].item._id;
    const editArgs = (idempotencyKey: string, qty: number, expectedVersion?: number) => ({
      idempotencyKey,
      saleId: order.sale._id,
      items: [{ saleItemId, variantId: ids.variantId, qty }],
      ...(expectedVersion !== undefined ? { expectedVersion } : {}),
    });

    const before = await state(t);
    const firstArgs = editArgs("shared-operation-key", 2, 0);
    const first = await t.mutation(api.sales.saveEdit, firstArgs);
    expect(first.sale._id).toBe(order.sale._id);
    expect(first.sale.editedVersion).toBe(1);
    expectDelta(await state(t), before, {
      saleItems: 1,
      events: 1,
      ledger: 1,
      ledgerSum: -1,
      records: 1,
    });

    const afterFirst = await state(t);
    const replay = await t.mutation(api.sales.saveEdit, firstArgs);
    expect(replay.sale._id).toBe(first.sale._id);
    expect(replay.sale.editedVersion).toBe(1);
    expect(await state(t)).toEqual(afterFirst);

    const beforeConflict = await state(t);
    expect(
      await errorCodeOf(t.mutation(api.sales.saveEdit, editArgs("shared-operation-key", 3, 0)))
    ).toBe("IDEMPOTENCY_CONFLICT");
    expect(await state(t)).toEqual(beforeConflict);

    const concurrentArgs = editArgs("save-edit-concurrent", 3, 1);
    const beforeConcurrent = await state(t);
    const [concurrentA, concurrentB] = await Promise.all([
      t.mutation(api.sales.saveEdit, concurrentArgs),
      t.mutation(api.sales.saveEdit, concurrentArgs),
    ]);
    expect(concurrentA.sale._id).toBe(concurrentB.sale._id);
    expect(concurrentA.sale.editedVersion).toBe(2);
    expect(concurrentB.sale.editedVersion).toBe(2);
    expectDelta(await state(t), beforeConcurrent, {
      saleItems: 1,
      events: 1,
      ledger: 1,
      ledgerSum: -1,
      records: 1,
    });

    const timeoutArgs = editArgs("save-edit-timeout", 4, 2);
    await t.mutation(api.sales.saveEdit, timeoutArgs);
    const afterIgnoredSuccess = await state(t);
    const timeoutRetry = await t.mutation(api.sales.saveEdit, timeoutArgs);
    expect(timeoutRetry.sale.editedVersion).toBe(3);
    expect(await state(t)).toEqual(afterIgnoredSuccess);

    // Without a version guard, two different keys are independent no-op saves.
    const beforeIndependent = await state(t);
    const independentA = await t.mutation(
      api.sales.saveEdit,
      editArgs("save-edit-independent-a", 4)
    );
    const independentB = await t.mutation(
      api.sales.saveEdit,
      editArgs("save-edit-independent-b", 4)
    );
    expect(independentA.sale.editedVersion).toBe(4);
    expect(independentB.sale.editedVersion).toBe(5);
    expectDelta(await state(t), beforeIndependent, { records: 2 });

    const beforeDenied = await state(t);
    signInAs(null);
    try {
      expect(await errorCodeOf(t.mutation(api.sales.saveEdit, firstArgs))).toBe("UNAUTHORIZED");
      expect(await state(t)).toEqual(beforeDenied);
    } finally {
      signInAs(ownerAuth);
    }

    // A replay with expectedVersion 0 succeeded above at version 1. A fresh
    // key reaches the stale guard and its failed transaction records nothing.
    const beforeStale = await state(t);
    expect(
      await errorCodeOf(t.mutation(api.sales.saveEdit, editArgs("save-edit-stale-new-key", 5, 0)))
    ).toBe("STALE_EDIT");
    expect(await state(t)).toEqual(beforeStale);

    const finalState = await state(t);
    expect(finalState.ledger).toBe(5);
    expect(finalState.ledgerSum).toBe(96);
    expect(finalState.events).toBe(4);
    const editRecords = await t.run(async (ctx) =>
      ctx.db
        .query("idempotencyRecords")
        .withIndex("by_scope", (q) =>
          q
            .eq("userId", ids.userId)
            .eq("operation", "sales.saveEdit")
        )
        .collect()
    );
    expect(editRecords).toHaveLength(5);
  });

  test("a failed business operation rolls back its idempotency record", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const before = await state(t);

    expect(
      await errorCodeOf(
        t.mutation(api.adjustments.adjustStock, {
          idempotencyKey: "failed-business-operation",
          variantId: ids.variantId,
          delta: -101,
          note: "Impossible shrinkage",
        })
      )
    ).toBe("OUT_OF_STOCK");
    expect(await state(t)).toEqual(before);
  });
});
