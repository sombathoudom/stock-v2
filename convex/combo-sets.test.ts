import { convexTest } from "convex-test";
import { describe, expect, test, vi } from "vitest";

import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import schema from "./schema";

const AUTH_USER_ID = "combo-set-auth-user";
let keySeq = 0;
const requestKey = (op: string) => `${op}-${(keySeq += 1)}`;

vi.mock("./auth", () => ({
  authComponent: {
    safeGetAuthUser: async () => ({
      _id: AUTH_USER_ID,
      name: "Combo Owner",
      email: "combo@test.local",
    }),
  },
}));

const modules = import.meta.glob("./**/*.ts");

/** A shop with TWO products — a shirt (M/L, cost $4, price $6) and pants
 * (M/L, cost $3, price $7) — each stocked 10 per size via a received
 * purchase, plus a customer and channel. Cents throughout. */
async function seed(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    await ctx.db.insert("shop", {
      name: "Combo Shop",
      currency: "USD",
      exchangeRate: 4000,
      timezone: "Asia/Phnom_Penh",
      deliveryEnabled: true,
      language: "en" as const,
    });
    const userId = await ctx.db.insert("users", {
      authUserId: AUTH_USER_ID,
      name: "Combo Owner",
      email: "combo@test.local",
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

    async function makeProduct(
      name: string,
      price: number,
      cost: number,
    ): Promise<{ productId: Id<"products">; m: Id<"productVariants">; l: Id<"productVariants"> }> {
      const productId = await ctx.db.insert("products", {
        name,
        nameLower: name.toLowerCase(),
        defaultPrice: price,
        defaultCost: cost,
        hasColors: false,
        sizes: ["M", "L"],
        colors: [],
        active: true,
      });
      const variants: Record<string, Id<"productVariants">> = {};
      for (const size of ["M", "L"]) {
        const variantId = await ctx.db.insert("productVariants", {
          productId,
          size,
          active: true,
        });
        variants[size] = variantId;
        const purchaseItemId = await ctx.db.insert("purchaseItems", {
          purchaseId,
          variantId,
          qty: 10,
          unitCost: cost,
        });
        await ctx.db.insert("stockLedger", {
          variantId,
          delta: 10,
          reason: "purchase" as const,
          purchaseItemId,
          userId,
          ts: now,
        });
      }
      return { productId, m: variants.M, l: variants.L };
    }

    const shirt = await makeProduct("Shirt", 600, 400); // price $6, cost $4
    const pants = await makeProduct("Pants", 700, 300); // price $7, cost $3

    // A set: 1 shirt @ set $6 + 2 pants @ set $6 each → set total $18.
    const setId = await ctx.db.insert("sets", {
      name: "Uniform Set",
      nameLower: "uniform set",
      active: true,
    });
    await ctx.db.insert("setItems", {
      setId,
      productId: shirt.productId,
      qty: 1,
      setPrice: 600,
    });
    await ctx.db.insert("setItems", {
      setId,
      productId: pants.productId,
      qty: 2,
      setPrice: 600,
    });

    return { userId, customerId, channelId, shirt, pants, setId };
  });
}

async function stockOf(t: ReturnType<typeof convexTest>, variantId: Id<"productVariants">) {
  const rows = await t.run(async (ctx: MutationCtx) =>
    ctx.db
      .query("stockLedger")
      .withIndex("by_variant_ts", (q) => q.eq("variantId", variantId))
      .collect(),
  );
  return rows.reduce((sum, row) => sum + row.delta, 0);
}

describe("combo sets — checkout", () => {
  test("uses the set price from the recipe, deducts each component, and profits correctly", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const groupId = "set-instance-1";

    // Sell one set: shirt M + pants M + pants L (mix-and-match sizes).
    const detail = await t.mutation(api.sales.checkout, {
      idempotencyKey: requestKey("checkout"),
      customerId: ids.customerId,
      salesChannelId: ids.channelId,
      discount: 0,
      deliveryFee: 0,
      items: [
        { variantId: ids.shirt.m, qty: 1, setId: ids.setId, setGroupId: groupId },
        { variantId: ids.pants.m, qty: 1, setId: ids.setId, setGroupId: groupId },
        { variantId: ids.pants.l, qty: 1, setId: ids.setId, setGroupId: groupId },
      ],
    });

    // Each line billed at its SET price (from the recipe), NOT the normal price.
    const shirtLine = detail.items.find((i) => i.variant._id === ids.shirt.m)!;
    const pantsM = detail.items.find((i) => i.variant._id === ids.pants.m)!;
    const pantsL = detail.items.find((i) => i.variant._id === ids.pants.l)!;
    expect(shirtLine.item.unitPrice).toBe(600); // set price, shirt normal is also 600
    expect(pantsM.item.unitPrice).toBe(600); // set price (pants normal is 700)
    expect(pantsL.item.unitPrice).toBe(600);

    // All three lines share the set group id.
    for (const line of [shirtLine, pantsM, pantsL]) {
      expect(line.item.setGroupId).toBe(groupId);
    }

    // Order total = set total = 600 + 600 + 600 = 1800.
    expect(detail.total).toBe(1800);

    // Stock deducted per component variant via the ledger.
    expect(await stockOf(t, ids.shirt.m)).toBe(9);
    expect(await stockOf(t, ids.pants.m)).toBe(9);
    expect(await stockOf(t, ids.pants.l)).toBe(9);

    // Profit = Σ(setPrice − cost): shirt (600−400) + pantsM (600−300) +
    // pantsL (600−300) = 200 + 300 + 300 = 800.
    expect(detail.profit).toBe(800);
  });

  test("rejects a variant that is not part of the set", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);

    // A brand-new product NOT in the set.
    const strayVariant = await t.run(async (ctx) => {
      const productId = await ctx.db.insert("products", {
        name: "Hat",
        nameLower: "hat",
        defaultPrice: 500,
        defaultCost: 200,
        hasColors: false,
        sizes: ["M"],
        colors: [],
        active: true,
      });
      return await ctx.db.insert("productVariants", { productId, size: "M", active: true });
    });

    await expect(
      t.mutation(api.sales.checkout, {
        idempotencyKey: requestKey("checkout"),
        customerId: ids.customerId,
        salesChannelId: ids.channelId,
        discount: 0,
        deliveryFee: 0,
        items: [{ variantId: strayVariant, qty: 1, setId: ids.setId, setGroupId: "g" }],
      }),
    ).rejects.toThrow();
  });
});
