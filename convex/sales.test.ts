import { convexTest } from "convex-test";
import { describe, expect, test, vi } from "vitest";

import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import schema from "./schema";

const AUTH_USER_ID = "test-auth-user";

// Sign-in is the ONE thing faked here. `authComponent` is the better-auth
// Convex component, which has no in-memory equivalent — so it's replaced with
// a stub that always returns the same signed-in identity. Everything below it
// stays real: `requireUser` still looks the staff row up by `authUserId`, so
// the auth path the app actually runs is the one under test.
vi.mock("./auth", () => ({
  authComponent: {
    safeGetAuthUser: async () => ({
      _id: AUTH_USER_ID,
      name: "Test Owner",
      email: "owner@test.local",
    }),
  },
}));

const modules = import.meta.glob("./**/*.ts");

/** A shop with one product (M / L), 10 of each on the shelf via a received
 * purchase, and one customer to sell to. Prices in integer cents throughout:
 * $10.00 sell, $4.00 cost. */
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
    const productId = await ctx.db.insert("products", {
      name: "Basic Tee",
      nameLower: "basic tee",
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

    // Stock arrives the only way it can: a received purchase writing ledger
    // rows. This also gives weighted-average costing real batches to average.
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
    for (const variantId of [variantM, variantL]) {
      const purchaseItemId = await ctx.db.insert("purchaseItems", {
        purchaseId,
        variantId,
        qty: 10,
        unitCost: 400,
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
    return { userId, customerId, channelId, productId, variantM, variantL };
  });
}

/** Every ledger row for a variant, read the way the app reads it. */
async function ledgerRows(
  t: ReturnType<typeof convexTest>,
  variantId: Id<"productVariants">
) {
  return await t.run(async (ctx: MutationCtx) =>
    ctx.db
      .query("stockLedger")
      .withIndex("by_variant_ts", (q) => q.eq("variantId", variantId))
      .collect()
  );
}

/** Stock the way the app computes it: the sum of the variant's ledger deltas. */
async function stockOf(
  t: ReturnType<typeof convexTest>,
  variantId: Id<"productVariants">
) {
  const rows = await ledgerRows(t, variantId);
  return rows.reduce((sum, row) => sum + row.delta, 0);
}

async function movementCount(
  t: ReturnType<typeof convexTest>,
  variantId: Id<"productVariants">
) {
  return (await ledgerRows(t, variantId)).length;
}

/** A confirmed order through the real checkout — no shortcuts. */
async function createSale(
  t: ReturnType<typeof convexTest>,
  ids: Awaited<ReturnType<typeof seed>>,
  lines: { variantId: Id<"productVariants">; qty: number }[],
  extra: { deliveryFee?: number; discount?: number } = {}
) {
  return await t.mutation(api.sales.checkout, {
    customerId: ids.customerId,
    salesChannelId: ids.channelId,
    discount: extra.discount ?? 0,
    deliveryFee: extra.deliveryFee ?? 0,
    items: lines,
  });
}

/** The quantity a line actually bills: ordered − cancelled − returned. */
const billed = (item: {
  qtyOrdered: number;
  qtyCancelled: number;
  qtyReturned: number;
}) => item.qtyOrdered - item.qtyCancelled - item.qtyReturned;

describe("sales.saveEdit", () => {
  test("adds a new line and deducts its stock", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const sale = await createSale(t, ids, [{ variantId: ids.variantM, qty: 2 }]);
    expect(await stockOf(t, ids.variantM)).toBe(8);

    const after = await t.mutation(api.sales.saveEdit, {
      saleId: sale.sale._id,
      items: [
        { saleItemId: sale.items[0].item._id, qty: 2 },
        { variantId: ids.variantL, qty: 3 },
      ],
    });

    expect(after.items).toHaveLength(2);
    expect(await stockOf(t, ids.variantL)).toBe(7);
    expect(await stockOf(t, ids.variantM)).toBe(8); // untouched line, untouched stock
    expect(after.total).toBe(5000); // (2 + 3) × $10.00
    expect(after.events.some((e) => e.event.type === "item_added")).toBe(true);
  });

  test("removes a line, returns its stock, and keeps the row in history", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const sale = await createSale(t, ids, [
      { variantId: ids.variantM, qty: 2 },
      { variantId: ids.variantL, qty: 1 },
    ]);
    expect(await stockOf(t, ids.variantM)).toBe(8);

    const mLine = sale.items.find((i) => i.variant._id === ids.variantM)!;
    const lLine = sale.items.find((i) => i.variant._id === ids.variantL)!;
    const after = await t.mutation(api.sales.saveEdit, {
      saleId: sale.sale._id,
      items: [
        { saleItemId: mLine.item._id, qty: 0 },
        { saleItemId: lLine.item._id, qty: 1 },
      ],
    });

    expect(await stockOf(t, ids.variantM)).toBe(10); // both pieces back on the shelf
    // Nothing with history is ever deleted (rule #10): the row stays, billing zero.
    expect(after.items).toHaveLength(2);
    const removed = after.items.find((i) => i.item._id === mLine.item._id)!;
    expect(billed(removed.item)).toBe(0);
    expect(after.total).toBe(1000); // only the remaining L line
    expect(after.events.some((e) => e.event.type === "item_removed")).toBe(true);
  });

  test("raising a quantity deducts only the extra pieces", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const sale = await createSale(t, ids, [{ variantId: ids.variantM, qty: 2 }]);
    const before = await movementCount(t, ids.variantM);

    const after = await t.mutation(api.sales.saveEdit, {
      saleId: sale.sale._id,
      items: [{ saleItemId: sale.items[0].item._id, qty: 5 }],
    });

    expect(await stockOf(t, ids.variantM)).toBe(5); // 10 − 5, not 10 − 2 − 5
    expect(await movementCount(t, ids.variantM)).toBe(before + 1); // one movement row
    // The raise is an ADD-ON: the original line keeps billing 2, and the
    // extra 3 live in their own internal split line (never a rewrite).
    expect(billed(after.items[0].item)).toBe(2);
    expect(billed(after.items[1].item)).toBe(3);
    expect(after.items[1].item.splitFromItemId).toBe(after.items[0].item._id);
    expect(after.total).toBe(5000);
  });

  test("lowering a quantity returns only the difference", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const sale = await createSale(t, ids, [{ variantId: ids.variantM, qty: 5 }]);
    expect(await stockOf(t, ids.variantM)).toBe(5);

    const after = await t.mutation(api.sales.saveEdit, {
      saleId: sale.sale._id,
      items: [{ saleItemId: sale.items[0].item._id, qty: 2 }],
    });

    expect(await stockOf(t, ids.variantM)).toBe(8); // 3 pieces came back
    expect(billed(after.items[0].item)).toBe(2);
    expect(after.total).toBe(2000);
    expect(after.events.some((e) => e.event.type === "item_qty_changed")).toBe(true);
  });

  test("rejects a save that needs more stock than the shelf has", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const sale = await createSale(t, ids, [{ variantId: ids.variantM, qty: 2 }]);

    await expect(
      t.mutation(api.sales.saveEdit, {
        saleId: sale.sale._id,
        items: [{ saleItemId: sale.items[0].item._id, qty: 99 }],
      })
    ).rejects.toThrow();

    expect(await stockOf(t, ids.variantM)).toBe(8); // unchanged
  });

  test("lets a decrease on one line pay for an increase on another", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    // Both lines sell M, so the shelf is empty after checkout.
    const sale = await createSale(t, ids, [
      { variantId: ids.variantM, qty: 6 },
      { variantId: ids.variantM, qty: 4 },
    ]);
    expect(await stockOf(t, ids.variantM)).toBe(0);

    // Net zero: −4 on the first line funds +4 on the second, even though the
    // shelf never holds a single spare piece.
    const after = await t.mutation(api.sales.saveEdit, {
      saleId: sale.sale._id,
      items: [
        { saleItemId: sale.items[0].item._id, qty: 2 },
        { saleItemId: sale.items[1].item._id, qty: 8 },
      ],
    });

    expect(await stockOf(t, ids.variantM)).toBe(0);
    expect(after.total).toBe(10000); // still 10 pieces × $10.00
  });

  test("changes the order status and records it in the history", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const sale = await createSale(t, ids, [{ variantId: ids.variantM, qty: 2 }]);

    const after = await t.mutation(api.sales.saveEdit, {
      saleId: sale.sale._id,
      items: [{ saleItemId: sale.items[0].item._id, qty: 2 }],
      status: "packed",
    });

    expect(after.sale.status).toBe("packed");
    expect(after.events.some((e) => e.event.type === "status_changed")).toBe(true);
  });

  test("can set the status to pending from the edit page", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const sale = await createSale(t, ids, [{ variantId: ids.variantM, qty: 2 }]);
    const movementsBefore = await movementCount(t, ids.variantM);

    const after = await t.mutation(api.sales.saveEdit, {
      saleId: sale.sale._id,
      items: [{ saleItemId: sale.items[0].item._id, qty: 2 }],
      status: "pending",
    });

    expect(after.sale.status).toBe("pending");
    expect(after.events.some((e) => e.event.type === "status_changed")).toBe(true);
    // Pending reserves what checkout already took out — no new movement.
    expect(await stockOf(t, ids.variantM)).toBe(8);
    expect(await movementCount(t, ids.variantM)).toBe(movementsBefore);
  });

  test("re-derives the total on the server from the order's own rows", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const sale = await createSale(t, ids, [{ variantId: ids.variantM, qty: 3 }]);

    const after = await t.mutation(api.sales.saveEdit, {
      saleId: sale.sale._id,
      items: [{ saleItemId: sale.items[0].item._id, qty: 3, discount: 500 }],
      discount: 200,
      deliveryFee: 150,
    });

    // 3 × $10.00 − $5.00 line discount − $2.00 order discount + $1.50 shipping
    expect(after.total).toBe(3000 - 500 - 200 + 150);
    expect(after.remaining).toBe(after.total);
  });

  test("rolls back every line when a later step of the save fails", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const sale = await createSale(t, ids, [{ variantId: ids.variantM, qty: 2 }]);
    const movementsBefore = await movementCount(t, ids.variantM);

    // The line edits are applied first and the status step throws after them —
    // a confirmed order can never go back to draft. One transaction, so the
    // already-written line changes have to vanish with it.
    await expect(
      t.mutation(api.sales.saveEdit, {
        saleId: sale.sale._id,
        items: [
          { saleItemId: sale.items[0].item._id, qty: 4 },
          { variantId: ids.variantL, qty: 2 },
        ],
        status: "draft",
      })
    ).rejects.toThrow();

    expect(await stockOf(t, ids.variantM)).toBe(8); // not 6
    expect(await stockOf(t, ids.variantL)).toBe(10); // the new line never landed
    expect(await movementCount(t, ids.variantM)).toBe(movementsBefore);
    const reloaded = await t.query(api.sales.getDetail, { saleId: sale.sale._id });
    expect(reloaded!.items).toHaveLength(1);
    expect(billed(reloaded!.items[0].item)).toBe(2);
    expect(reloaded!.sale.status).toBe("confirmed");
  });

  test("adds the same variant again as its own separate line", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const sale = await createSale(t, ids, [{ variantId: ids.variantM, qty: 2 }]);
    expect(await stockOf(t, ids.variantM)).toBe(8);

    // The same item added twice stays two lines (checkout rule) — the edit
    // page does not merge them either.
    const after = await t.mutation(api.sales.saveEdit, {
      saleId: sale.sale._id,
      items: [
        { saleItemId: sale.items[0].item._id, qty: 2 },
        { variantId: ids.variantM, qty: 1 },
      ],
    });

    expect(after.items).toHaveLength(2);
    expect(await stockOf(t, ids.variantM)).toBe(7); // 10 − 2 − 1, both lines deduct
    expect(after.total).toBe(3000); // (2 + 1) × $10.00
    expect(after.events.some((e) => e.event.type === "item_added")).toBe(true);
  });

  test("refuses to bill less than what was already delivered", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const sale = await createSale(t, ids, [{ variantId: ids.variantM, qty: 3 }]);
    await t.mutation(api.sales.setLineDelivered, {
      saleId: sale.sale._id,
      adjustments: [{ saleItemId: sale.items[0].item._id, qtyDelivered: 3 }],
    });

    await expect(
      t.mutation(api.sales.saveEdit, {
        saleId: sale.sale._id,
        items: [{ saleItemId: sale.items[0].item._id, qty: 1 }],
      })
    ).rejects.toThrow();
  });

  test("records a price change in the order history", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const sale = await createSale(t, ids, [{ variantId: ids.variantM, qty: 2 }]);

    const after = await t.mutation(api.sales.saveEdit, {
      saleId: sale.sale._id,
      items: [{ saleItemId: sale.items[0].item._id, qty: 2, price: 550 }],
    });

    expect(after.total).toBe(1100);
    const event = after.events.find(
      (e) => e.event.type === "sale_edited" && e.event.payload?.field === "price"
    );
    expect(event).toBeDefined();
    expect(event!.event.summary).toContain("5.50");
  });

  test("leaves lines the client didn't send alone", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    await createSale(t, ids, [
      { variantId: ids.variantM, qty: 2 },
      { variantId: ids.variantL, qty: 3 },
    ]);
    const sale = await createSale(t, ids, [{ variantId: ids.variantM, qty: 1 }]);

    // Only the note changes — a dropped row must never cancel stock by itself.
    const after = await t.mutation(api.sales.saveEdit, {
      saleId: sale.sale._id,
      items: [],
      note: "Call before delivery",
    });

    expect(await stockOf(t, ids.variantM)).toBe(7); // 10 − 2 − 1
    expect(after.sale.note).toBe("Call before delivery");
    expect(after.total).toBe(1000);
  });
});

describe("sales.setStatus — pending", () => {
  test("confirmed → pending → confirmed writes only history, no stock", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const sale = await createSale(t, ids, [{ variantId: ids.variantM, qty: 2 }]);
    const movementsBefore = await movementCount(t, ids.variantM);
    expect(await stockOf(t, ids.variantM)).toBe(8);

    // Pending reserves what checkout already took out — no new movement.
    const pending = await t.mutation(api.sales.setStatus, {
      saleId: sale.sale._id,
      status: "pending",
    });
    expect(pending.sale.status).toBe("pending");
    expect(await stockOf(t, ids.variantM)).toBe(8);
    expect(await movementCount(t, ids.variantM)).toBe(movementsBefore);

    // And it can go straight back to confirmed — processing started.
    const confirmed = await t.mutation(api.sales.setStatus, {
      saleId: sale.sale._id,
      status: "confirmed",
    });
    expect(confirmed.sale.status).toBe("confirmed");
    expect(await stockOf(t, ids.variantM)).toBe(8);
    expect(await movementCount(t, ids.variantM)).toBe(movementsBefore);

    // Every transition is audited; sorted because the two events can share a
    // millisecond and the read order is then unspecified.
    const tos = confirmed.events
      .filter((e) => e.event.type === "status_changed")
      .map((e) => e.event.payload?.to)
      .sort();
    expect(tos).toEqual(["confirmed", "pending"]);
  });

  test("pending → cancelled flows the reserved stock back", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const sale = await createSale(t, ids, [{ variantId: ids.variantM, qty: 2 }]);
    await t.mutation(api.sales.setStatus, {
      saleId: sale.sale._id,
      status: "pending",
    });

    const after = await t.mutation(api.sales.setStatus, {
      saleId: sale.sale._id,
      status: "cancelled",
    });

    expect(after.sale.status).toBe("cancelled");
    expect(await stockOf(t, ids.variantM)).toBe(10);
    const rows = await ledgerRows(t, ids.variantM);
    expect(rows[rows.length - 1].reason).toBe("cancel");
  });

  test("a later stage can never regress to pending", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const sale = await createSale(t, ids, [{ variantId: ids.variantM, qty: 2 }]);
    await t.mutation(api.sales.setStatus, {
      saleId: sale.sale._id,
      status: "delivering",
    });

    await expect(
      t.mutation(api.sales.setStatus, {
        saleId: sale.sale._id,
        status: "pending",
      })
    ).rejects.toThrow();

    const reloaded = await t.query(api.sales.getDetail, { saleId: sale.sale._id });
    expect(reloaded!.sale.status).toBe("delivering");
    expect(await stockOf(t, ids.variantM)).toBe(8);
  });

  test("a pending order with a balance appears in the still-owed list", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const sale = await createSale(t, ids, [{ variantId: ids.variantM, qty: 2 }]);
    await t.mutation(api.sales.setStatus, {
      saleId: sale.sale._id,
      status: "pending",
    });

    const unpaid = await t.query(api.sales.listUnpaid, {
      paginationOpts: { numItems: 20, cursor: null },
    });
    const row = unpaid.page.find((r) => r.sale._id === sale.sale._id);
    expect(row).toBeDefined();
    expect(row!.remaining).toBe(row!.total); // nothing paid yet
  });
});

describe("sales.getEditData", () => {
  test("caps each line at what it bills plus what is on the shelf", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const sale = await createSale(t, ids, [{ variantId: ids.variantM, qty: 4 }]);

    const data = await t.query(api.sales.getEditData, { saleId: sale.sale._id });

    expect(data).not.toBeNull();
    const line = data!.items[0];
    expect(line.billedQty).toBe(4);
    expect(line.stock).toBe(6); // this order's own 4 are already off the shelf
    expect(line.maxQty).toBe(10); // so the line can go back up to all 10
  });
});
