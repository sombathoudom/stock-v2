import type { Infer } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel";
import { query } from "./_generated/server";
import { dayString, getShop, requireUser } from "./helpers";
import { collectLowStock } from "./lowStock";
import { computePl } from "./reports";
import {
  computePaid,
  computeTotal,
  dayRange,
  toListRow,
  variantLabel,
  weightedAvgCost,
} from "./sales";
import { variantQty } from "./stock";
import { dashboardOverview, dashboardRange } from "./types";

// T20 — the analytics dashboard. One query for the whole page: five KPI
// cards over the selected range (today / 7d / 30d / mtd / ytd), the sales &
// purchases chart, top products / customers, stock value, low stock and the
// newest orders. Every number is derived server-side from the DB (the client
// sends only the range enum) — all reads indexed, money is integer cents.

type Range = Infer<typeof dashboardRange>;

// The same "owing" statuses sales.listUnpaid scans — cancelled owes nothing.
const OWED_STATUSES = [
  "confirmed",
  "pending",
  "packed",
  "delivering",
  "delivered",
  "partially_delivered",
] as const;

// Day-string arithmetic — the same Date.UTC pattern as periodRange in
// reports.ts: day strings are calendar days, so +/− n days is pure UTC math.
function addDays(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + n));
  const pad = (x: number) => String(x).padStart(2, "0");
  return `${next.getUTCFullYear()}-${pad(next.getUTCMonth() + 1)}-${pad(next.getUTCDate())}`;
}

/** [from, to) day-string window for each range enum (to is exclusive). */
function kpiWindow(today: string, range: Range): { from: string; to: string } {
  switch (range) {
    case "today":
      return { from: today, to: addDays(today, 1) };
    case "7d":
      return { from: addDays(today, -6), to: addDays(today, 1) };
    case "30d":
      return { from: addDays(today, -29), to: addDays(today, 1) };
    case "mtd":
      return { from: `${today.slice(0, 8)}01`, to: addDays(today, 1) };
    case "ytd":
      return { from: `${today.slice(0, 5)}01-01`, to: addDays(today, 1) };
  }
}

/** Day bucket keys from `from` (inclusive) to `to` (exclusive). */
function dayKeys(from: string, to: string): string[] {
  const keys: string[] = [];
  for (let day = from; day < to; day = addDays(day, 1)) keys.push(day);
  return keys;
}

/** Month bucket keys for the ytd chart: January → the current month. */
function monthKeys(from: string, today: string): string[] {
  const year = Number(from.slice(0, 4));
  const currentMonth = Number(today.slice(5, 7));
  const pad = (n: number) => String(n).padStart(2, "0");
  const keys: string[] = [];
  for (let m = 1; m <= currentMonth; m++) keys.push(`${year}-${pad(m)}`);
  return keys;
}

export const getOverview = query({
  args: { range: dashboardRange },
  returns: dashboardOverview,
  handler: async (ctx, args) => {
    await requireUser(ctx);
    const shop = await getShop(ctx);
    const tz = shop.timezone;
    const today = dayString(Date.now(), tz);
    const kpi = kpiWindow(today, args.range);

    // Chart window: the KPI window, except "today" widens to a rolling week
    // so the chart has something to draw. ytd buckets by month, the rest by
    // day.
    const chartFrom = args.range === "today" ? addDays(today, -6) : kpi.from;
    const monthBuckets = args.range === "ytd";
    const bucketKeys = monthBuckets ? monthKeys(kpi.from, today) : dayKeys(chartFrom, kpi.to);
    const buckets = new Map<string, { sales: number; purchases: number }>();
    for (const key of bucketKeys) buckets.set(key, { sales: 0, purchases: 0 });

    // Sales series: the window's payment rows (refunds are negative rows, so
    // money back nets out per bucket automatically) — by_receivedDay index.
    const payments = await ctx.db
      .query("payments")
      .withIndex("by_receivedDay", (q) => q.gte("receivedDay", chartFrom).lt("receivedDay", kpi.to))
      .collect();

    let kpiSales = 0;
    for (const payment of payments) {
      const key = monthBuckets ? payment.receivedDay.slice(0, 7) : payment.receivedDay;
      const bucket = buckets.get(key);
      if (bucket) bucket.sales += payment.amount;
      if (payment.receivedDay >= kpi.from) kpiSales += payment.amount; // < kpi.to by the collect
    }

    // Purchases series: stock received in the window (by_receivedAt index),
    // valued at Σ qty × unitCost of each purchase's lines.
    const chartEpoch = {
      from: dayRange(chartFrom, tz).from,
      to: dayRange(kpi.to, tz).from,
    };
    const purchases = (
      await ctx.db
        .query("purchases")
        .withIndex("by_receivedAt", (q) =>
          q.gte("receivedAt", chartEpoch.from).lt("receivedAt", chartEpoch.to)
        )
        .collect()
    ).filter((p) => p.status === "received");

    const purchaseValues = new Map<Id<"purchases">, number>();
    await Promise.all(
      purchases.map(async (purchase) => {
        const items = await ctx.db
          .query("purchaseItems")
          .withIndex("by_purchase", (q) => q.eq("purchaseId", purchase._id))
          .collect();
        let value = 0;
        for (const item of items) value += item.qty * item.unitCost;
        purchaseValues.set(purchase._id, value);
      })
    );

    let kpiPurchases = 0;
    for (const purchase of purchases) {
      const day = dayString(purchase.receivedAt ?? purchase.purchasedAt, tz);
      const key = monthBuckets ? day.slice(0, 7) : day;
      const value = purchaseValues.get(purchase._id) ?? 0;
      const bucket = buckets.get(key);
      if (bucket) bucket.purchases += value;
      if (day >= kpi.from) kpiPurchases += value; // < kpi.to by the collect
    }

    // Profit: the shared cash-basis P/L (same math as the reports page).
    const pl = await computePl(ctx, kpi.from, kpi.to);

    // Invoices + recent sales: orders created in the KPI window (drafts are
    // not invoices). Newest first; the first five become the recent-sales
    // card and also drive top products.
    const kpiEpoch = {
      from: dayRange(kpi.from, tz).from,
      to: dayRange(kpi.to, tz).from,
    };
    const rangeSales = (
      await ctx.db
        .query("sales")
        .withIndex("by_createdAt", (q) => q.gte("createdAt", kpiEpoch.from).lt("createdAt", kpiEpoch.to))
        .collect()
    )
      .filter((s) => s.status !== "draft")
      .sort((a, b) => b.createdAt - a.createdAt);
    const invoices = rangeSales.length;
    const recentSales = await Promise.all(
      rangeSales.slice(0, 5).map((sale) => toListRow(ctx, sale))
    );

    // Top products: billed pieces (ordered − cancelled − returned) per
    // variant across the range's orders, ranked by qty.
    const productTotals = new Map<Id<"productVariants">, { qty: number; revenue: number }>();
    await Promise.all(
      rangeSales.map(async (sale) => {
        const items = await ctx.db
          .query("saleItems")
          .withIndex("by_sale", (q) => q.eq("saleId", sale._id))
          .collect();
        for (const item of items) {
          const billed = item.qtyOrdered - item.qtyCancelled - item.qtyReturned;
          if (billed <= 0) continue;
          const prev = productTotals.get(item.variantId) ?? { qty: 0, revenue: 0 };
          productTotals.set(item.variantId, {
            qty: prev.qty + billed,
            // Per-line revenue mirrors orderCosts: the discount is once per
            // line, not per piece.
            revenue: prev.revenue + item.unitPrice * billed - (item.discount ?? 0),
          });
        }
      })
    );

    const ranked = [...productTotals.entries()]
      .map(([variantId, v]) => ({ variantId, ...v }))
      .sort((a, b) => b.qty - a.qty);
    const totalQty = ranked.reduce((sum, r) => sum + r.qty, 0);
    const topFive = ranked.slice(0, 5);
    const variantDocs = await Promise.all(topFive.map((r) => ctx.db.get(r.variantId)));
    const productDocs = await Promise.all(
      [...new Set(variantDocs.filter(Boolean).map((vd) => vd!.productId))].map((id) =>
        ctx.db.get(id)
      )
    );
    const productById = new Map<Id<"products">, Doc<"products">>();
    for (const doc of productDocs) if (doc) productById.set(doc._id, doc);
    const topProducts = topFive.map((r, i) => {
      const variant = variantDocs[i];
      const product = variant ? productById.get(variant.productId) : undefined;
      return {
        variantId: r.variantId,
        label: variant && product ? variantLabel(product, variant) : "—",
        qty: r.qty,
        revenue: r.revenue,
      };
    });

    // Top customers: Σ payment amounts in the KPI window per customer
    // (refunds are negative rows, so they net out), top 5 by revenue.
    const kpiPayments = payments.filter((p) => p.receivedDay >= kpi.from);
    const saleIdSet = [...new Set(kpiPayments.map((p) => p.saleId))];
    const salesById = new Map<Id<"sales">, Doc<"sales">>();
    for (const sale of await Promise.all(saleIdSet.map((id) => ctx.db.get(id)))) {
      if (sale) salesById.set(sale._id, sale);
    }
    const customerTotals = new Map<Id<"customers">, number>();
    for (const payment of kpiPayments) {
      const sale = salesById.get(payment.saleId);
      if (!sale) continue;
      customerTotals.set(
        sale.customerId,
        (customerTotals.get(sale.customerId) ?? 0) + payment.amount
      );
    }
    const topCustomerIds = [...customerTotals.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);
    const customerDocs = await Promise.all(topCustomerIds.map(([id]) => ctx.db.get(id)));
    const topCustomers = topCustomerIds.map(([customerId, revenue], i) => ({
      customerId,
      revenue,
      name: customerDocs[i]?.name ?? "—",
    }));

    // Stock value: the same bounded product walk as collectLowStock — active
    // products → active variants → ledger sum × weighted-average cost.
    const products = await ctx.db.query("products").withIndex("by_nameLower", (q) => q).take(1000);
    let totalValue = 0;
    let totalUnits = 0;
    for (const product of products) {
      if (!product.active) continue;
      const variants = await ctx.db
        .query("productVariants")
        .withIndex("by_product", (q) => q.eq("productId", product._id))
        .collect();
      for (const variant of variants) {
        if (!variant.active) continue;
        const qty = Math.max(0, await variantQty(ctx, variant._id));
        if (qty <= 0) continue;
        totalUnits += qty;
        totalValue += qty * (await weightedAvgCost(ctx, variant._id, variant, product));
      }
    }

    // Still owed: the same bounded scan as sales.listUnpaid (no index can
    // express "remaining > 0") — recent orders per owing status, paid
    // computed per order, remaining summed in memory.
    const SCAN = 250;
    const batches = await Promise.all(
      OWED_STATUSES.map((status) =>
        ctx.db
          .query("sales")
          .withIndex("by_status_createdAt", (q) => q.eq("status", status))
          .order("desc")
          .take(SCAN)
      )
    );
    const merged = batches.flat().sort((a, b) => b.createdAt - a.createdAt);
    let salesDue = 0;
    for (const sale of merged) {
      const [total, paid] = await Promise.all([
        computeTotal(ctx, sale),
        computePaid(ctx, sale._id),
      ]);
      const remaining = total - paid;
      if (remaining > 0) salesDue += remaining;
    }

    // Low stock: the shared T23 walk — computed ledger sums against the
    // shop's threshold, worst offenders first.
    const { items: lowStockItems } = await collectLowStock(ctx, shop);

    // Explicit literal union: the ternary alone infers `string` here because
    // the handler's return type is inferred before the `returns:` validator
    // contextually types it, and the conditional's branches widen.
    const chartType: "day" | "month" = monthBuckets ? "month" : "day";

    return {
      range: args.range,
      fromDay: kpi.from,
      toDay: kpi.to,
      kpis: {
        sales: kpiSales,
        purchases: kpiPurchases,
        salesDue,
        invoices,
        profit: pl.profit,
      },
      chart: {
        type: chartType,
        buckets: bucketKeys.map((key) => {
          const bucket = buckets.get(key) ?? { sales: 0, purchases: 0 };
          return { key, sales: bucket.sales, purchases: bucket.purchases };
        }),
      },
      topProducts,
      otherQty: totalQty - topFive.reduce((sum, r) => sum + r.qty, 0),
      topCustomers,
      stockValue: { totalValue, totalUnits },
      lowStock: lowStockItems.slice(0, 20),
      recentSales,
    };
  },
});
