import { convexTest } from "convex-test";
import { describe, expect, test, vi } from "vitest";

import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { dayString } from "./helpers";
import { dayRange } from "./sales";
import schema from "./schema";

const AUTH_USER_ID = "test-auth-user";
let requestKeySequence = 0;

function requestKey(operation: string): string {
  requestKeySequence += 1;
  return `${operation}-${requestKeySequence}`;
}

// Sign-in is the ONE thing faked here — the same stub as the other test
// files. `requireUser` still resolves the seeded staff row, so everything
// below auth runs for real.
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

const TZ = "Asia/Phnom_Penh";

// The same day-string arithmetic getOverview uses.
function addDays(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + n));
  const pad = (x: number) => String(x).padStart(2, "0");
  return `${next.getUTCFullYear()}-${pad(next.getUTCMonth() + 1)}-${pad(next.getUTCDate())}`;
}

/** Midday epoch (ms) of a day string — safely inside the shop-tz day. */
function noonOf(day: string): number {
  return dayRange(day, TZ).from + 12 * 3_600_000;
}

const today = () => dayString(Date.now(), TZ);

async function getOverview(
  t: ReturnType<typeof convexTest>,
  range: "today" | "7d" | "30d" | "mtd" | "ytd" = "today",
) {
  return (await t.query(api.dashboard.getOverview, { range }))!;
}

/** Base shop. The stock-building purchases sit in the year 2000 (out of every
 * real KPI window) so range KPIs never count them, while the ledger (which
 * ignores time) still gives the variants their shelf stock. Variants:
 *   M — two batches 10@$4 + 10@$6 → 20 units at $5.00 average
 *   L — one batch 10@$4
 *   S — no purchases, one +5 adjustment, $3.50 cost override
 *   XL — 2 purchased, 5 adjusted away → negative shelf (−3)
 * Low-stock threshold 2, so only XL starts out "low". */
async function seed(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    await ctx.db.insert("shop", {
      name: "Test Shop",
      currency: "USD",
      exchangeRate: 4000,
      timezone: TZ,
      deliveryEnabled: true,
      language: "en" as const,
      lowStockThreshold: 2,
    });
    const userId = await ctx.db.insert("users", {
      authUserId: AUTH_USER_ID,
      name: "Test Owner",
      email: "owner@test.local",
      role: "owner" as const,
      active: true,
    });
    const customerA = await ctx.db.insert("customers", {
      name: "Dara",
      nameLower: "dara",
      phone: "010000001",
      active: true,
    });
    const customerB = await ctx.db.insert("customers", {
      name: "Srey",
      nameLower: "srey",
      phone: "010000002",
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
      sizes: ["M", "L", "S", "XL"],
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
    const variantS = await ctx.db.insert("productVariants", {
      productId,
      size: "S",
      cost: 350,
      active: true,
    });
    const variantXL = await ctx.db.insert("productVariants", {
      productId,
      size: "XL",
      active: true,
    });

    const supplierId = await ctx.db.insert("suppliers", {
      name: "Supplier",
      nameLower: "supplier",
      active: true,
    });
    // Two purchases far in the past: shelf stock + weighted-average batches.
    const purchase1 = await ctx.db.insert("purchases", {
      supplierId,
      code: "P-2000-1",
      status: "received" as const,
      purchasedAt: noonOf("2000-01-05"),
      receivedAt: noonOf("2000-01-05"),
      userId,
      createdAt: noonOf("2000-01-05"),
    });
    const purchase2 = await ctx.db.insert("purchases", {
      supplierId,
      code: "P-2000-2",
      status: "received" as const,
      purchasedAt: noonOf("2000-01-06"),
      receivedAt: noonOf("2000-01-06"),
      userId,
      createdAt: noonOf("2000-01-06"),
    });
    const batches: {
      purchaseId: Id<"purchases">;
      variantId: Id<"productVariants">;
      qty: number;
      unitCost: number;
    }[] = [
      { purchaseId: purchase1, variantId: variantM, qty: 10, unitCost: 400 },
      { purchaseId: purchase1, variantId: variantL, qty: 10, unitCost: 400 },
      { purchaseId: purchase2, variantId: variantM, qty: 10, unitCost: 600 },
      { purchaseId: purchase1, variantId: variantXL, qty: 2, unitCost: 400 },
    ];
    for (const batch of batches) {
      const purchaseItemId = await ctx.db.insert("purchaseItems", {
        purchaseId: batch.purchaseId,
        variantId: batch.variantId,
        qty: batch.qty,
        unitCost: batch.unitCost,
      });
      await ctx.db.insert("stockLedger", {
        variantId: batch.variantId,
        delta: batch.qty,
        reason: "purchase" as const,
        purchaseItemId,
        userId,
        ts: now,
      });
    }
    // S arrives without a purchase (found stock), XL loses more than it has.
    await ctx.db.insert("stockLedger", {
      variantId: variantS,
      delta: 5,
      reason: "adjustment" as const,
      userId,
      ts: now,
      note: "found in storage",
    });
    await ctx.db.insert("stockLedger", {
      variantId: variantXL,
      delta: -5,
      reason: "adjustment" as const,
      userId,
      ts: now,
      note: "damaged",
    });

    return {
      userId,
      customerA,
      customerB,
      channelId,
      supplierId,
      productId,
      variantM,
      variantL,
      variantS,
      variantXL,
    };
  });
}

type Seed = Awaited<ReturnType<typeof seed>>;

async function addPayment(
  t: ReturnType<typeof convexTest>,
  userId: Id<"users">,
  saleId: Id<"sales">,
  amount: number,
  day: string,
) {
  await t.run(async (ctx: MutationCtx) => {
    await ctx.db.insert("payments", {
      saleId,
      amount,
      receivedAt: noonOf(day),
      receivedDay: day,
      method: amount < 0 ? ("refund" as const) : ("cash" as const),
      userId,
    });
  });
}

async function addExpense(
  t: ReturnType<typeof convexTest>,
  userId: Id<"users">,
  amount: number,
  day: string,
  category = "Rent",
) {
  await t.run(async (ctx: MutationCtx) => {
    await ctx.db.insert("expenses", {
      amount,
      category,
      categoryLower: category.toLowerCase(),
      spentAt: noonOf(day),
      spentDay: day,
      userId,
    });
  });
}

/** A confirmed order through the real checkout — no shortcuts. */
async function createSale(
  t: ReturnType<typeof convexTest>,
  ids: Seed,
  lines: { variantId: Id<"productVariants">; qty: number }[],
  idempotencyKey = requestKey("checkout"),
) {
  return await t.mutation(api.sales.checkout, {
    idempotencyKey,
    customerId: ids.customerA,
    salesChannelId: ids.channelId,
    discount: 0,
    deliveryFee: 0,
    items: lines,
  });
}

/** A raw sale row (no stock, no checkout) — for window/billing-shape tests.
 * saleItems lines carry the full item shape so billed pieces can be skewed
 * with cancelled/returned quantities. */
async function insertSale(
  t: ReturnType<typeof convexTest>,
  ids: Seed,
  {
    code,
    createdDay,
    createdAtMs,
    status = "confirmed" as const,
    lines = [],
  }: {
    code: string;
    createdDay: string;
    /** Override the default noon-of-createdDay timestamp. */
    createdAtMs?: number;
    status?: "confirmed" | "delivered" | "draft";
    lines?: {
      variantId: Id<"productVariants">;
      unitPrice: number;
      qtyOrdered: number;
      qtyCancelled?: number;
      qtyReturned?: number;
    }[];
  },
) {
  return await t.run(async (ctx: MutationCtx) => {
    const saleId = await ctx.db.insert("sales", {
      code,
      customerId: ids.customerA,
      salesChannelId: ids.channelId,
      status,
      deliveryFee: 0,
      deliveryCost: 0,
      discount: 0,
      userId: ids.userId,
      createdAt: createdAtMs ?? noonOf(createdDay),
    });
    for (const line of lines) {
      await ctx.db.insert("saleItems", {
        saleId,
        variantId: line.variantId,
        unitPrice: line.unitPrice,
        unitCostSnapshot: 400,
        qtyOrdered: line.qtyOrdered,
        qtyDelivered: 0,
        qtyCancelled: line.qtyCancelled ?? 0,
        qtyReturned: line.qtyReturned ?? 0,
      });
    }
    return saleId;
  });
}

describe("dashboard.getOverview — ranges", () => {
  test("today: 7 rolling chart buckets ending today, KPI counts only today", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const sale = await createSale(t, ids, [
      { variantId: ids.variantM, qty: 1 },
    ]);
    const day = today();
    await addPayment(t, ids.userId, sale.sale._id, 1000, day);
    await addPayment(t, ids.userId, sale.sale._id, 2000, addDays(day, -3));

    const overview = await getOverview(t, "today");

    expect(overview.fromDay).toBe(day);
    expect(overview.toDay).toBe(addDays(day, 1));
    expect(overview.kpis.sales).toBe(1000); // the −3d payment is chart-only
    expect(overview.chart.type).toBe("day");
    expect(overview.chart.buckets).toHaveLength(7);
    expect(overview.chart.buckets[0].key).toBe(addDays(day, -6));
    expect(overview.chart.buckets[6].key).toBe(day);
    expect(overview.chart.buckets[3].sales).toBe(2000);
    expect(overview.chart.buckets[6].sales).toBe(1000);
  });

  test("7d: from today − 6 days; the boundary day counts, the day before does not", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const sale = await createSale(t, ids, [
      { variantId: ids.variantM, qty: 1 },
    ]);
    const day = today();
    await addPayment(t, ids.userId, sale.sale._id, 1000, addDays(day, -6));
    await addPayment(t, ids.userId, sale.sale._id, 3000, addDays(day, -7));
    await addPayment(t, ids.userId, sale.sale._id, 2000, day);

    const overview = await getOverview(t, "7d");

    expect(overview.fromDay).toBe(addDays(day, -6));
    expect(overview.toDay).toBe(addDays(day, 1));
    expect(overview.kpis.sales).toBe(3000); // 1000 + 2000 — the −7d row is out
    expect(overview.chart.buckets).toHaveLength(7);
  });

  test("30d: from today − 29 days; boundary included, −30 excluded", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const sale = await createSale(t, ids, [
      { variantId: ids.variantM, qty: 1 },
    ]);
    const day = today();
    await addPayment(t, ids.userId, sale.sale._id, 1000, addDays(day, -29));
    await addPayment(t, ids.userId, sale.sale._id, 3000, addDays(day, -30));

    const overview = await getOverview(t, "30d");

    expect(overview.fromDay).toBe(addDays(day, -29));
    expect(overview.kpis.sales).toBe(1000);
    expect(overview.chart.buckets).toHaveLength(30);
  });

  test("mtd: from the first of the month", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const sale = await createSale(t, ids, [
      { variantId: ids.variantM, qty: 1 },
    ]);
    const day = today();
    const monthFirst = `${day.slice(0, 8)}01`;
    await addPayment(t, ids.userId, sale.sale._id, 1000, monthFirst);
    await addPayment(
      t,
      ids.userId,
      sale.sale._id,
      3000,
      addDays(monthFirst, -1),
    );

    const overview = await getOverview(t, "mtd");

    expect(overview.fromDay).toBe(monthFirst);
    expect(overview.kpis.sales).toBe(1000);
  });

  test("ytd: monthly buckets January → now; Jan 1 counts, Dec 31 doesn't", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const sale = await createSale(t, ids, [
      { variantId: ids.variantM, qty: 1 },
    ]);
    const day = today();
    const year = day.slice(0, 4);
    await addPayment(t, ids.userId, sale.sale._id, 1000, `${year}-01-01`);
    await addPayment(
      t,
      ids.userId,
      sale.sale._id,
      3000,
      `${Number(year) - 1}-12-31`,
    );

    const overview = await getOverview(t, "ytd");

    expect(overview.fromDay).toBe(`${year}-01-01`);
    expect(overview.kpis.sales).toBe(1000);
    expect(overview.chart.type).toBe("month");
    expect(overview.chart.buckets[0].key).toBe(`${year}-01`);
    expect(overview.chart.buckets).toHaveLength(Number(day.slice(5, 7)));
    expect(overview.chart.buckets.at(-1)!.key).toBe(
      `${year}-${day.slice(5, 7)}`,
    );
    expect(overview.chart.buckets[0].sales).toBe(1000);
  });
});

describe("dashboard.getOverview — purchases", () => {
  test("counts received purchases in range at Σ qty × unitCost; drafts and out-of-range excluded", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const day = today();
    const { inRange } = await t.run(async (ctx: MutationCtx) => {
      const mk = (status: "received" | "draft", receivedDay: string) =>
        ctx.db.insert("purchases", {
          supplierId: ids.supplierId,
          code: `D-${status}-${receivedDay}`,
          status,
          purchasedAt: noonOf(receivedDay),
          receivedAt: noonOf(receivedDay),
          userId: ids.userId,
          createdAt: noonOf(receivedDay),
        });
      return {
        inRange: await mk("received", day),
        draft: await mk("draft", day),
        outOfRange: await mk("received", addDays(day, -40)),
      };
    });
    await t.run(async (ctx: MutationCtx) => {
      const mk = (
        purchaseId: Id<"purchases">,
        variantId: Id<"productVariants">,
        qty: number,
        unitCost: number,
      ) =>
        ctx.db.insert("purchaseItems", {
          purchaseId,
          variantId,
          qty,
          unitCost,
        });
      await mk(inRange, ids.variantM, 10, 400);
      await mk(inRange, ids.variantL, 5, 500);
    });

    const overview = await getOverview(t, "today");

    // 10@$4 + 5@$5 = $65.00 — the draft and the 40-day-old purchase drop out.
    expect(overview.kpis.purchases).toBe(6500);
    const todayBucket = overview.chart.buckets.find((b) => b.key === day);
    expect(todayBucket!.purchases).toBe(6500); // KPI and chart agree
    expect(overview.chart.buckets.reduce((s, b) => s + b.purchases, 0)).toBe(
      6500,
    );
  });
});

describe("dashboard.getOverview — profit", () => {
  test("matches the reports page for the same day (payment + refund + expense)", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const sale = await createSale(t, ids, [
      { variantId: ids.variantM, qty: 2 },
    ]); // $20 total
    const day = today();
    await addPayment(t, ids.userId, sale.sale._id, 2000, day);
    await addPayment(t, ids.userId, sale.sale._id, -500, day); // refund
    await addExpense(t, ids.userId, 300, day);

    const overview = await getOverview(t, "today");
    const report = await t.query(api.reports.getPlReport, {
      period: { type: "day", value: day },
    });

    // The M snapshot is the weighted average 500¢ (two seed batches), so
    // moneyIn 1500 − pro-rata COGS (1500/2000 × 1000 = 750) − 300 = 450.
    expect(overview.kpis.profit).toBe(450);
    expect(overview.kpis.profit).toBe(report.profit); // one implementation
    expect(overview.kpis.sales).toBe(1500);
  });
});

describe("dashboard.getOverview — sales due", () => {
  test("sums remaining across owing orders; fully paid and cancelled excluded", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const halfPaid = await createSale(t, ids, [
      { variantId: ids.variantM, qty: 2 },
    ]); // $20
    await addPayment(t, ids.userId, halfPaid.sale._id, 500, today());
    const settled = await createSale(t, ids, [
      { variantId: ids.variantL, qty: 1 },
    ]); // $10
    await addPayment(t, ids.userId, settled.sale._id, 1000, today());
    const cancelled = await createSale(t, ids, [
      { variantId: ids.variantM, qty: 1 },
    ]);
    await t.mutation(api.sales.setStatus, {
      saleId: cancelled.sale._id,
      status: "cancelled",
    });

    const overview = await getOverview(t, "today");

    expect(overview.kpis.salesDue).toBe(1500);
  });
});

describe("dashboard.getOverview — top products", () => {
  test("ranks by billed pieces (cancelled/returned excluded) with per-line revenue", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    await createSale(t, ids, [
      { variantId: ids.variantM, qty: 2 },
      { variantId: ids.variantL, qty: 1 },
    ]);
    await createSale(t, ids, [{ variantId: ids.variantM, qty: 3 }]);
    // Billed pieces: 5 ordered − 2 cancelled − 1 returned = 2, $20 revenue.
    await insertSale(t, ids, {
      code: "SKEWED",
      createdDay: today(),
      lines: [
        {
          variantId: ids.variantM,
          unitPrice: 1000,
          qtyOrdered: 5,
          qtyCancelled: 2,
          qtyReturned: 1,
        },
      ],
    });
    // Out of today's window — must not count.
    await insertSale(t, ids, {
      code: "OLD",
      createdDay: addDays(today(), -40),
      lines: [{ variantId: ids.variantM, unitPrice: 1000, qtyOrdered: 2 }],
    });

    const overview = await getOverview(t, "today");

    expect(overview.topProducts).toHaveLength(2);
    const [m, l] = overview.topProducts;
    expect(m.label).toBe("Basic Tee — M");
    expect(m.qty).toBe(7); // 2 + 3 + 2
    expect(m.revenue).toBe(7000);
    expect(l.label).toBe("Basic Tee — L");
    expect(l.qty).toBe(1);
    expect(l.revenue).toBe(1000);
    expect(overview.otherQty).toBe(0);
  });
});

describe("dashboard.getOverview — top customers", () => {
  test("nets refunds per customer and excludes out-of-range payments", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const saleA = await createSale(t, ids, [
      { variantId: ids.variantM, qty: 1 },
    ]);
    const day = today();
    await addPayment(t, ids.userId, saleA.sale._id, 2000, day);
    await addPayment(t, ids.userId, saleA.sale._id, -500, day);
    await addPayment(t, ids.userId, saleA.sale._id, 999, addDays(day, -40)); // out of window

    const { saleBId } = await t.run(async (ctx: MutationCtx) => {
      const saleBId = await ctx.db.insert("sales", {
        code: "B-1",
        customerId: ids.customerB,
        salesChannelId: ids.channelId,
        status: "confirmed" as const,
        deliveryFee: 0,
        deliveryCost: 0,
        discount: 0,
        userId: ids.userId,
        createdAt: noonOf(day),
      });
      await ctx.db.insert("saleItems", {
        saleId: saleBId,
        variantId: ids.variantL,
        unitPrice: 1000,
        unitCostSnapshot: 400,
        qtyOrdered: 1,
        qtyDelivered: 0,
        qtyCancelled: 0,
        qtyReturned: 0,
      });
      return { saleBId };
    });
    await addPayment(t, ids.userId, saleBId, 1000, day);

    const overview = await getOverview(t, "today");

    expect(overview.topCustomers).toHaveLength(2);
    expect(overview.topCustomers[0].name).toBe("Dara");
    expect(overview.topCustomers[0].revenue).toBe(1500); // 2000 − 500, the old row drops
    expect(overview.topCustomers[1].name).toBe("Srey");
    expect(overview.topCustomers[1].revenue).toBe(1000);
  });
});

describe("dashboard.getOverview — stock value", () => {
  test("ledger qty × weighted-average cost; fallback costs and negative shelf handled", async () => {
    const t = convexTest(schema, modules);
    await seed(t);

    const overview = await getOverview(t, "today");

    // M: 20 × $5.00 avg = $100.00 · L: 10 × $4.00 = $40.00 · S: 5 × $3.50
    // override (no purchase) = $17.50 · XL: shelf −3 → counts zero.
    expect(overview.stockValue.totalUnits).toBe(35);
    expect(overview.stockValue.totalValue).toBe(15750);
  });
});

describe("dashboard.getOverview — invoices & recent sales", () => {
  test("counts invoices in the range and lists the 5 newest, newest first", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const day = today();
    // Staggered createdAt (all inside the same day) so "newest" is deterministic.
    for (let i = 1; i <= 6; i++) {
      await insertSale(t, ids, {
        code: `INV-${String(i).padStart(2, "0")}`,
        createdDay: day,
        createdAtMs: noonOf(day) + i * 1_000,
      });
    }
    await insertSale(t, ids, { code: "OLD", createdDay: addDays(day, -40) });
    await insertSale(t, ids, {
      code: "DRAFT",
      createdDay: day,
      status: "draft",
    });

    const overview = await getOverview(t, "today");

    expect(overview.kpis.invoices).toBe(6); // drafts are not invoices
    expect(overview.recentSales).toHaveLength(5);
    expect(overview.recentSales.map((r) => r.sale.code)).toEqual([
      "INV-06",
      "INV-05",
      "INV-04",
      "INV-03",
      "INV-02",
    ]);
  });
});

describe("dashboard.getOverview — low stock", () => {
  test("worst offenders first, threshold applied", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    const day = today();
    // One more variant with a single piece on the shelf (threshold 2).
    const { tinyId } = await t.run(async (ctx: MutationCtx) => {
      const productId = await ctx.db.insert("products", {
        name: "Socks",
        nameLower: "socks",
        defaultPrice: 300,
        defaultCost: 100,
        hasColors: false,
        sizes: ["One"],
        colors: [],
        active: true,
      });
      const tinyId = await ctx.db.insert("productVariants", {
        productId,
        size: "One",
        active: true,
      });
      const purchaseId = await ctx.db.insert("purchases", {
        supplierId: ids.supplierId,
        code: "P-TINY",
        status: "received" as const,
        purchasedAt: noonOf(day),
        receivedAt: noonOf(day),
        userId: ids.userId,
        createdAt: noonOf(day),
      });
      const purchaseItemId = await ctx.db.insert("purchaseItems", {
        purchaseId,
        variantId: tinyId,
        qty: 1,
        unitCost: 100,
      });
      await ctx.db.insert("stockLedger", {
        variantId: tinyId,
        delta: 1,
        reason: "purchase" as const,
        purchaseItemId,
        userId: ids.userId,
        ts: noonOf(day),
      });
      return { tinyId };
    });

    const overview = await getOverview(t, "today");

    // XL's shelf is −3, the new pair is 1 — worst (lowest) first.
    expect(overview.lowStock.map((i) => i.variantId)).toEqual([
      ids.variantXL,
      tinyId,
    ]);
    expect(overview.lowStock[0].qty).toBe(-3);
    expect(overview.lowStock[1].qty).toBe(1);
  });
});

describe("dashboard.getOverview — fresh signup", () => {
  test("returns null when no shop row exists yet", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.db.insert("users", {
        authUserId: AUTH_USER_ID,
        name: "Test Owner",
        email: "owner@test.local",
        role: "owner" as const,
        active: true,
      });
    });

    const overview = await t.query(api.dashboard.getOverview, {
      range: "today",
    });

    expect(overview).toBeNull();
  });
});
