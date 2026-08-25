import { convexTest } from "convex-test";
import { describe, expect, test, vi } from "vitest";

import { api } from "./_generated/api";
import type { MutationCtx } from "./_generated/server";
import schema from "./schema";

const AUTH_USER_ID = "expense-category-owner";

vi.mock("./auth", () => ({
  authComponent: {
    safeGetAuthUser: async () => ({
      _id: AUTH_USER_ID,
      name: "Expense Category Owner",
      email: "expense-categories@test.local",
    }),
  },
}));

const modules = import.meta.glob("./**/*.ts");

async function seed(t: ReturnType<typeof convexTest>) {
  await t.run(async (ctx: MutationCtx) => {
    await ctx.db.insert("shop", {
      name: "Expense Category Shop",
      currency: "USD",
      exchangeRate: 4000,
      timezone: "Asia/Phnom_Penh",
      deliveryEnabled: false,
      language: "en",
    });
    await ctx.db.insert("users", {
      authUserId: AUTH_USER_ID,
      name: "Expense Category Owner",
      email: "expense-categories@test.local",
      role: "owner",
      active: true,
    });
  });
}

describe("expense categories", () => {
  test("creates a trimmed reusable category", async () => {
    const t = convexTest(schema, modules);
    await seed(t);

    const category = await t.mutation(api.expenseCategories.create, {
      name: "  Delivery payouts  ",
    });

    expect(category).toEqual(
      expect.objectContaining({
        name: "Delivery payouts",
        nameLower: "delivery payouts",
        active: true,
      })
    );
    expect(await t.query(api.expenseCategories.listActive, {})).toEqual([category]);
  });

  test("rejects duplicate category names regardless of case and spaces", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    await t.mutation(api.expenseCategories.create, { name: "Rent" });

    await expect(
      t.mutation(api.expenseCategories.create, { name: "  RENT  " })
    ).rejects.toThrow("already exists");
    expect(
      await t.run(async (ctx) => (await ctx.db.query("expenseCategories").collect()).length)
    ).toBe(1);
  });

  test("lists categories alphabetically", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    await t.mutation(api.expenseCategories.create, { name: "Utilities" });
    await t.mutation(api.expenseCategories.create, { name: "Materials" });

    const categories = await t.query(api.expenseCategories.listActive, {});
    expect(categories.map((category) => category.name)).toEqual([
      "Materials",
      "Utilities",
    ]);
  });
});
