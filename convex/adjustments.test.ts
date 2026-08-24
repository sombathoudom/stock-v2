import { convexTest } from "convex-test";
import { describe, expect, test, vi } from "vitest";

import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import schema from "./schema";

const AUTH_USER_ID = "adjustments-test-auth-user";

function requestKey(intent: string) {
  return `adjustments-test:${intent}`;
}

vi.mock("./auth", () => ({
  authComponent: {
    safeGetAuthUser: async () => ({
      _id: AUTH_USER_ID,
      name: "Adjustment Tester",
      email: "adjustments@test.local",
    }),
  },
}));

const modules = import.meta.glob("./**/*.ts");

type TestContext = ReturnType<typeof convexTest>;
type ExpectedMovement = {
  delta: number;
  reason: "adjustment" | "stocktake";
  note: string;
};

async function seed(t: TestContext) {
  return await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {
      authUserId: AUTH_USER_ID,
      name: "Adjustment Tester",
      email: "adjustments@test.local",
      role: "owner" as const,
      active: true,
    });
    const productId = await ctx.db.insert("products", {
      name: "Test Shirt",
      nameLower: "test shirt",
      defaultPrice: 1000,
      defaultCost: 400,
      hasColors: false,
      sizes: ["M", "L", "XL"],
      colors: [],
      active: true,
    });
    const activeVariantId = await ctx.db.insert("productVariants", {
      productId,
      size: "M",
      active: true,
    });
    const secondVariantId = await ctx.db.insert("productVariants", {
      productId,
      size: "L",
      active: true,
    });
    const inactiveVariantId = await ctx.db.insert("productVariants", {
      productId,
      size: "XL",
      active: false,
    });
    return { userId, activeVariantId, secondVariantId, inactiveVariantId };
  });
}

async function ledgerRows(t: TestContext, variantId: Id<"productVariants">) {
  return await t.run(async (ctx: MutationCtx) =>
    ctx.db
      .query("stockLedger")
      .withIndex("by_variant_ts", (q) => q.eq("variantId", variantId))
      .collect()
  );
}

/** Re-read and independently derive stock after every operation under test. */
async function expectLedger(
  t: TestContext,
  variantId: Id<"productVariants">,
  userId: Id<"users">,
  stock: number,
  expected: ExpectedMovement[]
) {
  const rows = (await ledgerRows(t, variantId)).toSorted(
    (left, right) => left._creationTime - right._creationTime
  );
  expect(rows.reduce((sum, row) => sum + row.delta, 0)).toBe(stock);
  expect(rows).toHaveLength(expected.length);
  expect(
    rows.map((row) => ({ delta: row.delta, reason: row.reason, note: row.note }))
  ).toEqual(expected);
  for (const row of rows) {
    expect(row.variantId).toBe(variantId);
    expect(row.userId).toBe(userId);
    expect(row.purchaseItemId).toBeUndefined();
    expect(row.saleItemId).toBeUndefined();
  }
}

describe("adjustments.adjustStock", () => {
  test("records positive, negative, and exact-to-zero movements one row at a time", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);

    const stockIn = await t.mutation(api.adjustments.adjustStock, {
      idempotencyKey: requestKey("movement-stock-in"),
      variantId: ids.activeVariantId,
      delta: 5,
      note: "  Found during shelf check  ",
    });
    expect(stockIn).toMatchObject({
      variantId: ids.activeVariantId,
      delta: 5,
      reason: "adjustment",
      userId: ids.userId,
      note: "Found during shelf check",
    });
    await expectLedger(t, ids.activeVariantId, ids.userId, 5, [
      { delta: 5, reason: "adjustment", note: "Found during shelf check" },
    ]);

    const damaged = await t.mutation(api.adjustments.adjustStock, {
      idempotencyKey: requestKey("movement-damaged"),
      variantId: ids.activeVariantId,
      delta: -2,
      note: "Damaged",
    });
    expect(damaged).toMatchObject({ delta: -2, reason: "adjustment", note: "Damaged" });
    await expectLedger(t, ids.activeVariantId, ids.userId, 3, [
      { delta: 5, reason: "adjustment", note: "Found during shelf check" },
      { delta: -2, reason: "adjustment", note: "Damaged" },
    ]);

    const lost = await t.mutation(api.adjustments.adjustStock, {
      idempotencyKey: requestKey("movement-lost"),
      variantId: ids.activeVariantId,
      delta: -3,
      note: "Lost",
    });
    expect(lost).toMatchObject({ delta: -3, reason: "adjustment", note: "Lost" });
    await expectLedger(t, ids.activeVariantId, ids.userId, 0, [
      { delta: 5, reason: "adjustment", note: "Found during shelf check" },
      { delta: -2, reason: "adjustment", note: "Damaged" },
      { delta: -3, reason: "adjustment", note: "Lost" },
    ]);
  });

  test("rolls back a decrement that would take stock below zero", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    await t.mutation(api.adjustments.adjustStock, {
      idempotencyKey: requestKey("below-zero-opening-count"),
      variantId: ids.activeVariantId,
      delta: 2,
      note: "Opening count",
    });
    await expectLedger(t, ids.activeVariantId, ids.userId, 2, [
      { delta: 2, reason: "adjustment", note: "Opening count" },
    ]);

    await expect(
      t.mutation(api.adjustments.adjustStock, {
        idempotencyKey: requestKey("below-zero-damaged"),
        variantId: ids.activeVariantId,
        delta: -3,
        note: "Damaged",
      })
    ).rejects.toThrow();
    await expectLedger(t, ids.activeVariantId, ids.userId, 2, [
      { delta: 2, reason: "adjustment", note: "Opening count" },
    ]);
  });

  test.each([0, 1.5, -0.5])("rejects invalid delta %s without a movement", async (delta) => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);

    await expect(
      t.mutation(api.adjustments.adjustStock, {
        idempotencyKey: requestKey(`invalid-delta-${delta}`),
        variantId: ids.activeVariantId,
        delta,
        note: "Invalid adjustment",
      })
    ).rejects.toThrow();
    await expectLedger(t, ids.activeVariantId, ids.userId, 0, []);
  });

  test("applies sequential duplicate requests independently", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const request = {
      variantId: ids.activeVariantId,
      delta: 2,
      note: "Found two",
    };

    await t.mutation(api.adjustments.adjustStock, {
      ...request,
      idempotencyKey: requestKey("duplicate-intent-first"),
    });
    await expectLedger(t, ids.activeVariantId, ids.userId, 2, [
      { delta: 2, reason: "adjustment", note: "Found two" },
    ]);
    await t.mutation(api.adjustments.adjustStock, {
      ...request,
      idempotencyKey: requestKey("duplicate-intent-second"),
    });
    await expectLedger(t, ids.activeVariantId, ids.userId, 4, [
      { delta: 2, reason: "adjustment", note: "Found two" },
      { delta: 2, reason: "adjustment", note: "Found two" },
    ]);
  });

  test("accepts an existing inactive variant and rejects a deleted variant", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);

    await t.mutation(api.adjustments.adjustStock, {
      idempotencyKey: requestKey("inactive-variant"),
      variantId: ids.inactiveVariantId,
      delta: 1,
      note: "Historical item found",
    });
    await expectLedger(t, ids.inactiveVariantId, ids.userId, 1, [
      { delta: 1, reason: "adjustment", note: "Historical item found" },
    ]);

    const deletedVariantId = await t.run(async (ctx) => {
      const variantId = await ctx.db.insert("productVariants", {
        productId: (await ctx.db.get(ids.activeVariantId))!.productId,
        size: "Deleted",
        active: false,
      });
      await ctx.db.delete(variantId);
      return variantId;
    });
    await expect(
      t.mutation(api.adjustments.adjustStock, {
        idempotencyKey: requestKey("deleted-variant"),
        variantId: deletedVariantId,
        delta: 1,
        note: "Must not land",
      })
    ).rejects.toThrow();
    await expectLedger(t, deletedVariantId, ids.userId, 0, []);
  });

  test("serializes concurrent decrements against the last unit", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    await t.mutation(api.adjustments.adjustStock, {
      idempotencyKey: requestKey("concurrent-last-unit"),
      variantId: ids.activeVariantId,
      delta: 1,
      note: "Last unit",
    });
    await expectLedger(t, ids.activeVariantId, ids.userId, 1, [
      { delta: 1, reason: "adjustment", note: "Last unit" },
    ]);

    const results = await Promise.allSettled([
      t.mutation(api.adjustments.adjustStock, {
        idempotencyKey: requestKey("concurrent-damaged"),
        variantId: ids.activeVariantId,
        delta: -1,
        note: "Damaged",
      }),
      t.mutation(api.adjustments.adjustStock, {
        idempotencyKey: requestKey("concurrent-lost"),
        variantId: ids.activeVariantId,
        delta: -1,
        note: "Lost",
      }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);

    const successfulNote = results[0].status === "fulfilled" ? "Damaged" : "Lost";
    await expectLedger(t, ids.activeVariantId, ids.userId, 0, [
      { delta: 1, reason: "adjustment", note: "Last unit" },
      { delta: -1, reason: "adjustment", note: successfulNote },
    ]);
  });
});

describe("adjustments.recordStocktake", () => {
  test("writes positive and negative differences and skips an unchanged count", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    await t.mutation(api.adjustments.adjustStock, {
      idempotencyKey: requestKey("stocktake-opening-count"),
      variantId: ids.activeVariantId,
      delta: 2,
      note: "Opening count",
    });
    await expectLedger(t, ids.activeVariantId, ids.userId, 2, [
      { delta: 2, reason: "adjustment", note: "Opening count" },
    ]);

    const positive = await t.mutation(api.adjustments.recordStocktake, {
      rows: [{ variantId: ids.activeVariantId, countedQty: 5 }],
    });
    expect(positive).toEqual({
      written: 1,
      rows: [{ variantId: ids.activeVariantId, before: 2, after: 5 }],
    });
    await expectLedger(t, ids.activeVariantId, ids.userId, 5, [
      { delta: 2, reason: "adjustment", note: "Opening count" },
      { delta: 3, reason: "stocktake", note: "Counted 5, system had 2" },
    ]);

    const negative = await t.mutation(api.adjustments.recordStocktake, {
      rows: [{ variantId: ids.activeVariantId, countedQty: 1 }],
    });
    expect(negative).toEqual({
      written: 1,
      rows: [{ variantId: ids.activeVariantId, before: 5, after: 1 }],
    });
    await expectLedger(t, ids.activeVariantId, ids.userId, 1, [
      { delta: 2, reason: "adjustment", note: "Opening count" },
      { delta: 3, reason: "stocktake", note: "Counted 5, system had 2" },
      { delta: -4, reason: "stocktake", note: "Counted 1, system had 5" },
    ]);

    const unchanged = await t.mutation(api.adjustments.recordStocktake, {
      rows: [{ variantId: ids.activeVariantId, countedQty: 1 }],
    });
    expect(unchanged).toEqual({ written: 0, rows: [] });
    await expectLedger(t, ids.activeVariantId, ids.userId, 1, [
      { delta: 2, reason: "adjustment", note: "Opening count" },
      { delta: 3, reason: "stocktake", note: "Counted 5, system had 2" },
      { delta: -4, reason: "stocktake", note: "Counted 1, system had 5" },
    ]);
  });

  test("rolls back all writes when a variant is duplicated", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);

    await expect(
      t.mutation(api.adjustments.recordStocktake, {
        rows: [
          { variantId: ids.activeVariantId, countedQty: 4 },
          { variantId: ids.activeVariantId, countedQty: 5 },
        ],
      })
    ).rejects.toThrow();
    await expectLedger(t, ids.activeVariantId, ids.userId, 0, []);
  });

  test.each([-1, 2.5])("rolls back earlier rows when a late count %s is invalid", async (countedQty) => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);

    await expect(
      t.mutation(api.adjustments.recordStocktake, {
        rows: [
          { variantId: ids.activeVariantId, countedQty: 3 },
          { variantId: ids.secondVariantId, countedQty },
        ],
      })
    ).rejects.toThrow();
    await expectLedger(t, ids.activeVariantId, ids.userId, 0, []);
    await expectLedger(t, ids.secondVariantId, ids.userId, 0, []);
  });

  test("counts an existing inactive variant but fully rolls back a late deleted one", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);

    const inactive = await t.mutation(api.adjustments.recordStocktake, {
      rows: [{ variantId: ids.inactiveVariantId, countedQty: 2 }],
    });
    expect(inactive).toEqual({
      written: 1,
      rows: [{ variantId: ids.inactiveVariantId, before: 0, after: 2 }],
    });
    await expectLedger(t, ids.inactiveVariantId, ids.userId, 2, [
      { delta: 2, reason: "stocktake", note: "Counted 2, system had 0" },
    ]);

    const deletedVariantId = await t.run(async (ctx) => {
      const variantId = await ctx.db.insert("productVariants", {
        productId: (await ctx.db.get(ids.activeVariantId))!.productId,
        size: "Deleted",
        active: false,
      });
      await ctx.db.delete(variantId);
      return variantId;
    });
    await expect(
      t.mutation(api.adjustments.recordStocktake, {
        rows: [
          { variantId: ids.activeVariantId, countedQty: 3 },
          { variantId: deletedVariantId, countedQty: 1 },
        ],
      })
    ).rejects.toThrow();
    await expectLedger(t, ids.activeVariantId, ids.userId, 0, []);
    await expectLedger(t, deletedVariantId, ids.userId, 0, []);
    await expectLedger(t, ids.inactiveVariantId, ids.userId, 2, [
      { delta: 2, reason: "stocktake", note: "Counted 2, system had 0" },
    ]);
  });
});
