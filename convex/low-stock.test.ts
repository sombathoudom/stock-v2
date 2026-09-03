import { convexTest } from "convex-test";
import { describe, expect, test, vi } from "vitest";

import { api } from "./_generated/api";
import schema from "./schema";

const AUTH_USER_ID = "low-stock-test-auth-user";

// A signed-in staff identity (switchable to null for the unauth check).
const authState = vi.hoisted(() => ({
  current: {
    _id: "low-stock-test-auth-user",
    name: "Low Stock Tester",
    email: "lowstock@test.local",
  } as { _id: string; name: string; email: string } | null,
}));

vi.mock("./auth", () => ({
  authComponent: {
    safeGetAuthUser: async () => authState.current,
  },
}));

const modules = import.meta.glob("./**/*.ts");

/** Seed ONLY a staff row — no shop row — to reproduce a fresh sign-up that
 * lands on /dashboard before the owner has finished Settings. */
async function seedStaffOnly(t: ReturnType<typeof convexTest>) {
  await t.run(async (ctx) => {
    await ctx.db.insert("users", {
      authUserId: AUTH_USER_ID,
      name: "Owner",
      email: "lowstock@test.local",
      role: "owner" as const,
      active: true,
    });
  });
}

describe("lowStock — fresh sign-up (no shop row yet)", () => {
  test("lowStockCount returns 0 instead of throwing NO_SHOP", async () => {
    const t = convexTest(schema, modules);
    await seedStaffOnly(t);

    // The nav badge renders on every page right after sign-up. It must not
    // crash the dashboard when the shop hasn't been set up yet.
    const result = await t.query(api.lowStock.lowStockCount, {});
    expect(result).toEqual({ count: 0, threshold: 0 });
  });

  test("lowStock returns an empty reorder list instead of throwing", async () => {
    const t = convexTest(schema, modules);
    await seedStaffOnly(t);

    const result = await t.query(api.lowStock.lowStock, {});
    expect(result.items).toEqual([]);
  });
});
