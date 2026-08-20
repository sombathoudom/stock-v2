import { paginationOptsValidator } from "convex/server";
import { ConvexError, v } from "convex/values";

import type { Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { query } from "./_generated/server";
import { getShop, requireUser, startOfDay } from "./helpers";
import { dayRange, variantLabel } from "./sales";
import {
  channelReportRow,
  ledgerReason,
  plReport,
  purchaseTraceItem,
  reportCsvRow,
  stockMovementRow,
} from "./types";

// T19 — cash-basis P/L reports (AGENTS.md rules #2 and #7). Money counts on
// the day it is RECEIVED, not the day the order was created: revenue is the
// period's payment rows (refunds are negative rows, so money back nets out),
// and spends are the period's expense rows. Both ride indexed day-string
// range queries (receivedDay / spentDay) — reports never scan.
//
// COGS recognition for partial payments: each payment row of amount A against
// an order with total T and cost C recognizes round(A/T × C) of cost. A fully
// paid order recognizes exactly its full cost across the payment days; a
// refund recognizes negative cost. Delivery income / delivery cost are the
// same proportion of the delivery fee and the company cost — shown as their
// own lines (rule #7), while the actual company payout lands in expenses.

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-\d{2}$/;
const YEAR_RE = /^\d{4}$/;

/** [from, to) day-string range for a period value (to is exclusive). */
function periodRange(
  type: "day" | "month" | "year",
  value: string
): { from: string; to: string } {
  if (type === "day") {
    if (!DAY_RE.test(value)) throw new ConvexError({ code: "INVALID_INPUT", message: "Invalid day." });
    const [y, m, d] = value.split("-").map(Number);
    const next = new Date(Date.UTC(y, m - 1, d + 1));
    const pad = (n: number) => String(n).padStart(2, "0");
    return { from: value, to: `${next.getUTCFullYear()}-${pad(next.getUTCMonth() + 1)}-${pad(next.getUTCDate())}` };
  }
  if (type === "month") {
    if (!MONTH_RE.test(value)) throw new ConvexError({ code: "INVALID_INPUT", message: "Invalid month." });
    let [y, m] = value.split("-").map(Number);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
    return { from: `${value}-01`, to: `${y}-${String(m).padStart(2, "0")}-01` };
  }
  if (!YEAR_RE.test(value)) throw new ConvexError({ code: "INVALID_INPUT", message: "Invalid year." });
  return { from: `${value}-01-01`, to: `${Number(value) + 1}-01-01` };
}

/** The order's customer-facing total and its cost (items + delivery company).
 * Mirrors computeTotal but also sums cost in the same pass. */
async function orderCosts(
  ctx: { db: QueryCtx["db"] },
  saleId: Id<"sales">
): Promise<{ total: number; itemCost: number; deliveryFee: number; deliveryCost: number }> {
  const sale = await ctx.db.get(saleId);
  if (!sale) return { total: 0, itemCost: 0, deliveryFee: 0, deliveryCost: 0 };
  const items = await ctx.db
    .query("saleItems")
    .withIndex("by_sale", (q) => q.eq("saleId", saleId))
    .collect();
  let total = 0;
  let itemCost = 0;
  for (const item of items) {
    const qty = item.qtyOrdered - item.qtyCancelled - item.qtyReturned;
    total += item.unitPrice * qty - (item.discount ?? 0);
    itemCost += item.unitCostSnapshot * qty;
  }
  return {
    total: total - sale.discount + sale.deliveryFee,
    itemCost,
    deliveryFee: sale.deliveryFee,
    deliveryCost: sale.deliveryCost,
  };
}

/**
 * Shared cash-basis P/L over a day-string range [from, to): the period's
 * payments (refunds net out) minus pro-rata COGS minus expenses. Used by
 * getPlReport (day/month/year) and by the dashboard's range KPIs (7d/30d/
 * mtd/ytd) — one implementation, so the dashboard and the reports page can
 * never disagree. Callers authenticate before calling.
 */
export async function computePl(
  ctx: { db: QueryCtx["db"] },
  from: string,
  to: string
): Promise<{
  moneyIn: number;
  refunds: number;
  cogs: number;
  deliveryIncome: number;
  deliveryCost: number;
  expenses: number;
  profit: number;
  paymentsCount: number;
  expensesByCategory: { category: string; amount: number }[];
}> {
  const payments = await ctx.db
    .query("payments")
    .withIndex("by_receivedDay", (q) => q.gte("receivedDay", from).lt("receivedDay", to))
    .collect();

  // One costs pass per sale, not per payment.
  const saleIds = [...new Set(payments.map((p) => p.saleId))];
  const costsBySale = new Map<
    string,
    { total: number; itemCost: number; deliveryFee: number; deliveryCost: number }
  >();
  await Promise.all(
    saleIds.map(async (saleId) => {
      costsBySale.set(saleId, await orderCosts(ctx, saleId));
    })
  );

  let moneyIn = 0;
  let refunds = 0;
  let cogs = 0;
  let deliveryIncome = 0;
  let deliveryCost = 0;
  for (const payment of payments) {
    moneyIn += payment.amount;
    if (payment.amount < 0) refunds += -payment.amount;
    const costs = costsBySale.get(payment.saleId);
    if (!costs || costs.total <= 0) continue;
    const ratio = payment.amount / costs.total;
    cogs += Math.round(ratio * costs.itemCost);
    deliveryIncome += Math.round(ratio * costs.deliveryFee);
    deliveryCost += Math.round(ratio * costs.deliveryCost);
  }

  const expenseRows = await ctx.db
    .query("expenses")
    .withIndex("by_spentDay", (q) => q.gte("spentDay", from).lt("spentDay", to))
    .collect();
  const byCategory = new Map<string, number>();
  let expenses = 0;
  for (const row of expenseRows) {
    expenses += row.amount;
    byCategory.set(row.category, (byCategory.get(row.category) ?? 0) + row.amount);
  }

  return {
    moneyIn,
    refunds,
    cogs,
    deliveryIncome,
    deliveryCost,
    expenses,
    profit: moneyIn - cogs - expenses,
    paymentsCount: payments.length,
    expensesByCategory: [...byCategory.entries()]
      .map(([category, amount]) => ({ category, amount }))
      .sort((a, b) => b.amount - a.amount),
  };
}

/**
 * Daily / monthly / yearly P/L. Monthly and yearly are aggregates of the same
 * daily rows (the range spans the whole month / year) — never stored totals.
 */
export const getPlReport = query({
  args: {
    period: v.object({
      type: v.union(v.literal("day"), v.literal("month"), v.literal("year")),
      value: v.string(),
    }),
  },
  returns: plReport,
  handler: async (ctx, args) => {
    await requireUser(ctx);
    const { from, to } = periodRange(args.period.type, args.period.value);
    const pl = await computePl(ctx, from, to);
    return {
      periodType: args.period.type,
      periodValue: args.period.value,
      fromDay: from,
      toDay: to,
      ...pl,
    };
  },
});

// T24 — Report CSV export: the same cash-basis P/L as getPlReport, but
// split per day. Two indexed range queries (payments, expenses) and ONE
// costs pass per sale; the day loop is in memory — a year exports cheaply.
export const getReportCsv = query({
  args: {
    period: v.object({
      type: v.union(v.literal("day"), v.literal("month"), v.literal("year")),
      value: v.string(),
    }),
  },
  returns: v.object({
    periodType: v.string(),
    periodValue: v.string(),
    rows: v.array(reportCsvRow),
  }),
  handler: async (ctx, args) => {
    await requireUser(ctx);
    const { from, to } = periodRange(args.period.type, args.period.value);

    const payments = await ctx.db
      .query("payments")
      .withIndex("by_receivedDay", (q) => q.gte("receivedDay", from).lt("receivedDay", to))
      .collect();
    const expenses = await ctx.db
      .query("expenses")
      .withIndex("by_spentDay", (q) => q.gte("spentDay", from).lt("spentDay", to))
      .collect();

    // One costs pass per sale — never per payment (same math as getPlReport).
    const saleIds = [...new Set(payments.map((p) => p.saleId))];
    const costsBySale = new Map<
      string,
      { total: number; itemCost: number }
    >();
    await Promise.all(
      saleIds.map(async (saleId) => {
        const costs = await orderCosts(ctx, saleId);
        costsBySale.set(saleId, { total: costs.total, itemCost: costs.itemCost });
      })
    );

    // Group the rows by their day bucket, then walk the days in order —
    // days with no activity export a zero row too, so the CSV matches the
    // on-screen period exactly.
    const paymentsByDay = new Map<string, typeof payments>();
    for (const p of payments) {
      const list = paymentsByDay.get(p.receivedDay) ?? [];
      list.push(p);
      paymentsByDay.set(p.receivedDay, list);
    }
    const expensesByDay = new Map<string, number>();
    for (const e of expenses) {
      expensesByDay.set(e.spentDay, (expensesByDay.get(e.spentDay) ?? 0) + e.amount);
    }

    const rows: { day: string; moneyIn: number; refunds: number; cogs: number; expenses: number; profit: number }[] = [];
    const start = new Date(`${from}T00:00:00Z`);
    const end = new Date(`${to}T00:00:00Z`);
    for (let t = start.getTime(); t < end.getTime(); t += 86_400_000) {
      const day = new Date(t).toISOString().slice(0, 10);
      let moneyIn = 0;
      let refunds = 0;
      let cogs = 0;
      for (const payment of paymentsByDay.get(day) ?? []) {
        moneyIn += payment.amount;
        if (payment.amount < 0) refunds += -payment.amount;
        const costs = costsBySale.get(payment.saleId);
        if (!costs || costs.total <= 0) continue;
        cogs += Math.round((payment.amount / costs.total) * costs.itemCost);
      }
      const dayExpenses = expensesByDay.get(day) ?? 0;
      rows.push({
        day,
        moneyIn,
        refunds,
        cogs,
        expenses: dayExpenses,
        profit: moneyIn - cogs - dayExpenses,
      });
    }
    return {
      periodType: args.period.type,
      periodValue: args.period.value,
      rows,
    };
  },
});

// T21 — Sales by channel (page): which selling page brings the money.
// Orders are the period's created sales; revenue and profit are the period's
// payments (cash basis) attributed to the channel of their order. Profit =
// money in − the recognized item cost − the recognized delivery-company
// cost (the payout itself lands in expenses, never double-counted).
export const getChannelReport = query({
  args: {
    period: v.object({
      type: v.union(v.literal("day"), v.literal("month"), v.literal("year")),
      value: v.string(),
    }),
  },
  returns: v.array(channelReportRow),
  handler: async (ctx, args) => {
    await requireUser(ctx);
    const shop = await getShop(ctx);
    const { from, to } = periodRange(args.period.type, args.period.value);

    // Sales created in the period (by_createdAt, epoch range in shop tz).
    const fromMs = startOfDay(new Date(`${from}T12:00:00Z`).getTime(), shop.timezone);
    const toMs = startOfDay(new Date(`${to}T12:00:00Z`).getTime(), shop.timezone);
    const salesInPeriod = await ctx.db
      .query("sales")
      .withIndex("by_createdAt", (q) => q.gte("createdAt", fromMs).lt("createdAt", toMs))
      .collect();

    // Payments in the period (by_receivedDay) with one costs pass per sale.
    const payments = await ctx.db
      .query("payments")
      .withIndex("by_receivedDay", (q) => q.gte("receivedDay", from).lt("receivedDay", to))
      .collect();
    const saleIds = [...new Set(payments.map((p) => p.saleId))];
    const costsBySale = new Map<string, Awaited<ReturnType<typeof orderCosts>>>();
    const saleById = new Map<string, (typeof salesInPeriod)[number]>();
    await Promise.all(
      saleIds.map(async (saleId) => {
        costsBySale.set(saleId, await orderCosts(ctx, saleId));
        const sale = await ctx.db.get(saleId);
        if (sale) saleById.set(saleId, sale);
      })
    );

    const channels = await ctx.db.query("salesChannels").take(100); // few rows per shop
    const nameById = new Map<string, string>(
      channels.map((c) => [c._id, c.name] as const)
    );
    const byChannel = new Map<
      string,
      { orders: number; revenue: number; profit: number }
    >(channels.map((c) => [c._id, { orders: 0, revenue: 0, profit: 0 }]));

    for (const sale of salesInPeriod) {
      const entry = byChannel.get(sale.salesChannelId) ?? { orders: 0, revenue: 0, profit: 0 };
      entry.orders += 1;
      byChannel.set(sale.salesChannelId, entry);
    }
    for (const payment of payments) {
      const sale = saleById.get(payment.saleId);
      const costs = costsBySale.get(payment.saleId);
      if (!sale || !costs || costs.total <= 0) continue;
      const ratio = payment.amount / costs.total;
      const entry =
        byChannel.get(sale.salesChannelId) ?? { orders: 0, revenue: 0, profit: 0 };
      entry.revenue += payment.amount;
      entry.profit +=
        payment.amount -
        Math.round(ratio * costs.itemCost) -
        Math.round(ratio * costs.deliveryCost);
      byChannel.set(sale.salesChannelId, entry);
    }

    return [...byChannel.entries()]
      .map(([channelId, entry]) => ({
        channelId: channelId as Id<"salesChannels">,
        channelName: nameById.get(channelId) ?? "—",
        orders: entry.orders,
        revenue: entry.revenue,
        profit: entry.profit,
      }))
      .sort((a, b) => b.revenue - a.revenue);
  },
});

// T21 — Stock movement report: every ledger row in a day range, optionally
// one reason only, newest first, joined with labels + actor names. The
// "where did every piece go" answer for any window (by_ts / by_reason_ts).
export const getStockMovements = query({
  args: {
    fromDay: v.string(),
    toDay: v.string(), // inclusive
    reason: v.optional(ledgerReason),
    paginationOpts: paginationOptsValidator,
  },
  returns: v.object({
    page: v.array(stockMovementRow),
    continueCursor: v.string(),
    total: v.number(),
  }),
  handler: async (ctx, args) => {
    await requireUser(ctx);
    if (!DAY_RE.test(args.fromDay) || !DAY_RE.test(args.toDay)) {
      throw new ConvexError({ code: "INVALID_INPUT", message: "Invalid day range." });
    }
    const shop = await getShop(ctx);
    const fromMs = dayRange(args.fromDay, shop.timezone).from;
    const toMs = dayRange(args.toDay, shop.timezone).to; // start of the day after

    const build = () =>
      args.reason !== undefined
        ? ctx.db
            .query("stockLedger")
            .withIndex("by_reason_ts", (q) =>
              q.eq("reason", args.reason!).gte("ts", fromMs).lt("ts", toMs)
            )
        : ctx.db
            .query("stockLedger")
            .withIndex("by_ts", (q) => q.gte("ts", fromMs).lt("ts", toMs));
    const page = await build().order("desc").paginate(args.paginationOpts);
    const total = (await build().take(1000)).length;

    // Deduped batch joins: variants → products, users.
    const variants = await Promise.all(
      [...new Set(page.page.map((r) => r.variantId))].map((id) => ctx.db.get(id))
    );
    const variantById = new Map(
      variants.filter((v) => v !== null).map((v) => [v._id, v] as const)
    );
    const products = await Promise.all(
      [...new Set(variants.filter((v) => v !== null).map((v) => v!.productId))].map((id) =>
        ctx.db.get(id)
      )
    );
    const productById = new Map(
      products.filter((p) => p !== null).map((p) => [p._id, p] as const)
    );
    const users = await Promise.all(
      [...new Set(page.page.map((r) => r.userId))].map((id) => ctx.db.get(id))
    );
    const nameById = new Map(
      users.filter((u) => u !== null).map((u) => [u._id, u.name] as const)
    );

    const rows = page.page.map((row) => {
      const variant = variantById.get(row.variantId);
      return {
        row,
        label: variantLabel(
          variant ? (productById.get(variant.productId) ?? null) : null,
          variant ?? null
        ),
        userName: nameById.get(row.userId) ?? "—",
      };
    });
    return { page: rows, continueCursor: page.isDone ? "" : page.continueCursor, total };
  },
});

// T21 — Per-purchase stock trace: every ledger row this purchase's lines
// wrote (the stock each line brought in), newest first, with actor names.
export const purchaseTrace = query({
  args: { purchaseId: v.id("purchases") },
  returns: v.array(purchaseTraceItem),
  handler: async (ctx, args) => {
    await requireUser(ctx);
    const items = await ctx.db
      .query("purchaseItems")
      .withIndex("by_purchase", (q) => q.eq("purchaseId", args.purchaseId))
      .collect();
    const batches = await Promise.all(
      items.map((item) =>
        ctx.db
          .query("stockLedger")
          .withIndex("by_purchaseItem", (q) => q.eq("purchaseItemId", item._id))
          .collect()
      )
    );
    const rows = batches.flat().sort((a, b) => b.ts - a.ts);
    const users = await Promise.all(
      [...new Set(rows.map((r) => r.userId))].map((id) => ctx.db.get(id))
    );
    const nameById = new Map(
      users.filter((u) => u !== null).map((u) => [u._id, u.name] as const)
    );
    return rows.map((row) => ({ row, userName: nameById.get(row.userId) ?? "—" }));
  },
});
