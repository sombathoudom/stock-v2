import { convexTest } from "convex-test";
import { describe, expect, test, vi } from "vitest";

import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

const AUTH_USER_ID = "reorder-test-auth-user";

// Signed-in identity is switchable per test (owner vs nobody).
const authState = vi.hoisted(() => ({
  current: {
    _id: "reorder-test-auth-user",
    name: "Reorder Tester",
    email: "reorder@test.local",
  } as { _id: string; name: string; email: string } | null,
}));

vi.mock("./auth", () => ({
  authComponent: {
    safeGetAuthUser: async () => authState.current,
  },
}));

const modules = import.meta.glob("./**/*.ts");
const TZ = "Asia/Phnom_Penh";

/** Seed shop + one product with M/L variants; stock arrives via a received
 * purchase (the only real inflow path). */
async function seed(t: ReturnType<typeof convexTest>) {
  const now = Date.now();
  return await t.run(async (ctx) => {
    await ctx.db.insert("shop", {
      name: "Reorder Shop",
      currency: "USD",
      exchangeRate: 4000,
      timezone: TZ,
      deliveryEnabled: false,
      language: "en" as const,
    });
    const userId = await ctx.db.insert("users", {
      authUserId: AUTH_USER_ID,
      name: "Owner",
      email: "reorder@test.local",
      role: "owner" as const,
      active: true,
    });
    const supplierId = await ctx.db.insert("suppliers", {
      name: "Supplier",
      nameLower: "supplier",
      active: true,
    });
    const productId = await ctx.db.insert("products", {
      name: "Tee",
      nameLower: "tee",
      code: "TEE",
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
      active: true,
    });
    const variantL = await ctx.db.insert("productVariants", {
      productId,
      size: "L",
      active: true,
    });
    // Never-sold variant on a second product — must never appear.
    const quietProductId = await ctx.db.insert("products", {
      name: "Quiet",
      nameLower: "quiet",
      defaultPrice: 800,
      defaultCost: 300,
      hasColors: false,
      sizes: ["S"],
      colors: [],
      active: true,
    });
    const variantQuiet = await ctx.db.insert("productVariants", {
      productId: quietProductId,
      size: "S",
      active: true,
    });
    for (const [variantId, qty] of [
      [variantM, 10],
      [variantL, 6],
      [variantQuiet, 5],
    ] as const) {
      const purchaseId = await ctx.db.insert("purchases", {
        supplierId,
        code: `P-${String(qty)}`,
        status: "received" as const,
        purchasedAt: now,
        receivedAt: now,
        userId,
        createdAt: now,
      });
      const purchaseItemId = await ctx.db.insert("purchaseItems", {
        purchaseId,
        variantId,
        qty,
        unitCost: 400,
      });
      await ctx.db.insert("stockLedger", {
        variantId,
        delta: qty,
        reason: "purchase" as const,
        purchaseItemId,
        userId,
        ts: now - 40 * 86_400_000,
      });
    }
    return { userId, productId, variantM, variantL, variantQuiet };
  });
}

type SeedIds = Awaited<ReturnType<typeof seed>>;

/** A sale ledger row N days ago (the only real outflow path). */
async function sell(
  t: ReturnType<typeof convexTest>,
  ids: SeedIds,
  variantId: Id<"productVariants">,
  daysAgo: number,
  qty = 1,
) {
  await t.run(async (ctx) => {
    await ctx.db.insert("stockLedger", {
      variantId,
      delta: -qty,
      reason: "sale" as const,
      userId: ids.userId,
      ts: Date.now() - daysAgo * 86_400_000,
    });
  });
}

describe("reports.getReorderPlanningReport", () => {
  test("suggests cover − stock from average daily sales; skips no-sale variants", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);

    // M: 7 sold in the last 30 days → avg 7/30 per day → target ⌈7⌉ = 7,
    // stock left 10−7=3 → suggestion 7−3=4.
    for (let i = 0; i < 7; i++) {
      await sell(t, ids, ids.variantM, i * 4); // spread across the window
    }
    // L sells slowly and keeps enough shelf: target ⌈2⌉=2 < remaining 4 →
    // nothing to reorder, so L must NOT appear.
    await sell(t, ids, ids.variantL, 1);
    await sell(t, ids, ids.variantL, 3);

    const report = await t.query(api.reports.getReorderPlanningReport, {
      lookbackDays: 30,
      targetDays: 30,
      paginationOpts: { numItems: 50, cursor: null },
    });

    expect(report.asOfDay).toBeTruthy();
    expect(report.totals.variantCount).toBe(1);
    const m = report.page.find((row) => row.variantId === ids.variantM);
    expect(m).toBeDefined();
    expect(m!.unitsSoldInLookback).toBe(7);
    expect(m!.currentQty).toBe(3);
    expect(m!.suggestedReorderQty).toBe(4);
    expect(m!.estimatedDaysRemaining).toBe(Math.floor(3 / (7 / 30))); // 12
    expect(m!.estimatedReorderCost).toBe(4 * 400);
    // L covered by shelf, and Quiet never sold — neither appears.
    expect(report.page.some((row) => row.variantId === ids.variantL)).toBe(false);
    expect(report.page.some((row) => row.variantId === ids.variantQuiet)).toBe(false);
  });

  test("search narrows rows and totals follow the filtered set", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    for (let i = 0; i < 8; i++) {
      await sell(t, ids, ids.variantM, i * 3);
    }

    const all = await t.query(api.reports.getReorderPlanningReport, {
      lookbackDays: 30,
      targetDays: 30,
      paginationOpts: { numItems: 50, cursor: null },
    });
    const filtered = await t.query(api.reports.getReorderPlanningReport, {
      lookbackDays: 30,
      targetDays: 30,
      search: "quiet", // matches only the never-sold product → empty result
      paginationOpts: { numItems: 50, cursor: null },
    });

    expect(all.total).toBe(1);
    expect(filtered.total).toBe(0);
    expect(filtered.totals.suggestedUnits).toBe(0);
  });

  test("unauthenticated callers are rejected", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    authState.current = null;
    try {
      await expect(
        t.query(api.reports.getReorderPlanningReport, {
          lookbackDays: 30,
          targetDays: 30,
          paginationOpts: { numItems: 20, cursor: null },
        }),
      ).rejects.toThrow();
    } finally {
      authState.current = {
        _id: AUTH_USER_ID,
        name: "Reorder Tester",
        email: "reorder@test.local",
      };
    }
  });
});
