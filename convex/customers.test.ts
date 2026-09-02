import { convexTest } from "convex-test";
import { beforeEach, describe, expect, test, vi } from "vitest";

import { api } from "./_generated/api";
import type { MutationCtx } from "./_generated/server";
import schema from "./schema";

const AUTH_USER_ID = "customer-test-owner";

vi.mock("./auth", () => ({
  authComponent: {
    safeGetAuthUser: async () => ({
      _id: AUTH_USER_ID,
      name: "Customer Test Owner",
      email: "customers@test.local",
    }),
  },
}));

const modules = import.meta.glob("./**/*.ts");

beforeEach(() => {
  vi.clearAllMocks();
});

async function seed(t: ReturnType<typeof convexTest>) {
  await t.run(async (ctx: MutationCtx) => {
    await ctx.db.insert("shop", {
      name: "Customer Test Shop",
      currency: "USD",
      exchangeRate: 4000,
      timezone: "Asia/Phnom_Penh",
      deliveryEnabled: false,
      language: "en",
    });
    await ctx.db.insert("users", {
      authUserId: AUTH_USER_ID,
      name: "Customer Test Owner",
      email: "customers@test.local",
      role: "owner",
      active: true,
    });
  });
}

describe("customer phone uniqueness", () => {
  test("POS creation returns the existing normalized phone", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    const existing = await t.mutation(api.customers.create, {
      name: "Sokha",
      phone: "012 345 678",
      address: "Original address",
    });

    const result = await t.mutation(api.customers.createOrGetByPhone, {
      name: "Duplicate entry",
      phone: "0 12-345-678",
      address: "Must not replace existing data",
    });

    expect(result.created).toBe(false);
    expect(result.customer).toEqual(existing);
    const customers = await t.run(async (ctx) => ctx.db.query("customers").collect());
    expect(customers).toHaveLength(1);
    expect(customers[0].address).toBe("Original address");
  });

  test("normal customer creation cannot bypass a duplicate phone", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    await t.mutation(api.customers.create, {
      name: "Sokha",
      phone: "012 345 678",
    });

    await expect(
      t.mutation(api.customers.create, {
        name: "Another Sokha",
        phone: "012-345-678",
      })
    ).rejects.toThrow("already exists");
    expect(
      await t.run(async (ctx) => (await ctx.db.query("customers").collect()).length)
    ).toBe(1);
  });

  test("customer updates cannot take another customer's phone", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    const first = await t.mutation(api.customers.create, {
      name: "First",
      phone: "010 111 222",
    });
    const second = await t.mutation(api.customers.create, {
      name: "Second",
      phone: "011 333 444",
    });

    await expect(
      t.mutation(api.customers.update, {
        customerId: second._id,
        name: second.name,
        phone: "010-111-222",
        active: true,
      })
    ).rejects.toThrow("already exists");
    const unchanged = await t.query(api.customers.get, { customerId: second._id });
    // Leading zeros are kept — a Cambodian number's 0 is a real digit.
    expect(unchanged?.phone).toBe("011333444");
    expect(first.phone).toBe("010111222");
  });

  test("formatted phone search finds the normalized customer", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    const customer = await t.mutation(api.customers.create, {
      name: "Sokha",
      phone: "012 345 678",
    });

    const matches = await t.query(api.customers.listActive, {
      search: "012-345",
    });
    expect(matches.map((match) => match._id)).toContain(customer._id);
  });
});
