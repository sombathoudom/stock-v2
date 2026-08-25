import { paginationOptsValidator } from "convex/server";
import { ConvexError, v } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { query } from "./_generated/server";
import { dayString, getShop, requireUser, startOfDay } from "./helpers";
import {
  chargedDeliveryFee,
  computePaid,
  computeTotal,
  dayRange,
  variantLabel,
  weightedAvgCost,
} from "./sales";
import { variantQty } from "./stock";
import {
  channelReportRow,
  customerDebtReport,
  deadStockReport,
  deadStockThreshold,
  inventoryValueReport,
  ledgerReason,
  plReport,
  productPerformanceReport,
  reorderDays,
  reorderPlanningReport,
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
// COGS recognition for partial payments: each payment gets the difference
// between the rounded allocation at cumulative paid before and after that
// row. This preserves proportional cash-basis recognition while guaranteeing
// that a fully paid order recognizes its exact cost across payment days and a
// refund reverses the corresponding allocation. Delivery income / delivery
// cost use the same allocation policy for the fee and company cost — shown as
// their own lines (rule #7), while the actual payout lands in expenses.

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-\d{2}$/;
const YEAR_RE = /^\d{4}$/;

type DebtAging = {
  days0To7: number;
  days8To30: number;
  days31To60: number;
  over60Days: number;
};

function emptyDebtAging(): DebtAging {
  return { days0To7: 0, days8To30: 0, days31To60: 0, over60Days: 0 };
}

function addDebtToAging(aging: DebtAging, ageDays: number, amount: number) {
  if (ageDays <= 7) aging.days0To7 += amount;
  else if (ageDays <= 30) aging.days8To30 += amount;
  else if (ageDays <= 60) aging.days31To60 += amount;
  else aging.over60Days += amount;
}

function calendarDayOrdinal(day: string): number {
  const [year, month, date] = day.split("-").map(Number);
  return Math.floor(Date.UTC(year, month - 1, date) / 86_400_000);
}

function dayFromOrdinal(ordinal: number): string {
  return new Date(ordinal * 86_400_000).toISOString().slice(0, 10);
}

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
  if (sale.status === "cancelled") {
    return {
      total: chargedDeliveryFee(sale),
      itemCost: 0,
      deliveryFee: chargedDeliveryFee(sale),
      deliveryCost: sale.deliveryCost,
    };
  }
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

/** Split an integer total proportionally while preserving every cent. */
function allocateProportionally(total: number, weights: number[]): number[] {
  const weightTotal = weights.reduce((sum, weight) => sum + Math.max(0, weight), 0);
  if (total === 0 || weightTotal <= 0) return weights.map(() => 0);
  const sign = total < 0 ? -1 : 1;
  const absolute = Math.abs(total);
  const allocations = weights.map((weight) =>
    Math.floor((absolute * Math.max(0, weight)) / weightTotal)
  );
  const remaining = absolute - allocations.reduce((sum, value) => sum + value, 0);
  const order = weights
    .map((weight, index) => ({
      index,
      remainder: (absolute * Math.max(0, weight)) % weightTotal,
    }))
    .sort((a, b) => b.remainder - a.remainder || a.index - b.index);
  for (let i = 0; i < remaining; i++) allocations[order[i].index] += 1;
  return allocations.map((value) => value * sign);
}

type VariantPaymentAllocation = {
  variantId: Id<"productVariants">;
  revenue: number;
  landedCost: number;
};

/** Cash-basis payment allocation down to variant lines. */
async function loadPaymentVariantAllocations(
  ctx: { db: QueryCtx["db"] },
  matchedPayments: Doc<"payments">[]
): Promise<Map<string, VariantPaymentAllocation[]>> {
  const saleIds = [...new Set(matchedPayments.map((payment) => payment.saleId))];
  const byPayment = new Map<string, VariantPaymentAllocation[]>();
  await Promise.all(
    saleIds.map(async (saleId) => {
      const [sale, payments, items] = await Promise.all([
        ctx.db.get(saleId),
        ctx.db
          .query("payments")
          .withIndex("by_sale", (q) => q.eq("saleId", saleId))
          .collect(),
        ctx.db
          .query("saleItems")
          .withIndex("by_sale", (q) => q.eq("saleId", saleId))
          .collect(),
      ]);
      if (!sale || sale.status === "cancelled") return;
      const lines = items
        .map((item) => {
          const qty = item.qtyOrdered - item.qtyCancelled - item.qtyReturned;
          return {
            item,
            gross: Math.max(0, item.unitPrice * qty - (item.discount ?? 0)),
            cost: Math.max(0, item.unitCostSnapshot * qty),
          };
        })
        .filter((line) => line.gross > 0 || line.cost > 0)
        .sort((a, b) => a.item._id.localeCompare(b.item._id));
      if (lines.length === 0) return;
      const grossWeights = lines.map((line) => line.gross);
      const grossTotal = grossWeights.reduce((sum, value) => sum + value, 0);
      const discount = Math.min(Math.max(sale.discount, 0), grossTotal);
      const discountShares = allocateProportionally(discount, grossWeights);
      const revenueWeights = lines.map((line, index) => line.gross - discountShares[index]);
      const merchandiseTotal = revenueWeights.reduce((sum, value) => sum + value, 0);
      const costWeights = lines.map((line) => line.cost);
      const costTotal = costWeights.reduce((sum, value) => sum + value, 0);
      const orderTotal = merchandiseTotal + sale.deliveryFee;
      if (orderTotal <= 0) return;

      payments.sort(
        (a, b) =>
          a.receivedAt - b.receivedAt ||
          a._creationTime - b._creationTime ||
          a._id.localeCompare(b._id)
      );
      let cumulativePaid = 0;
      let previousRevenue = lines.map(() => 0);
      let previousCost = lines.map(() => 0);
      for (const payment of payments) {
        cumulativePaid += payment.amount;
        const revenueTarget = Math.round(
          (cumulativePaid / orderTotal) * merchandiseTotal
        );
        const costTarget = Math.round((cumulativePaid / orderTotal) * costTotal);
        const currentRevenue = allocateProportionally(revenueTarget, revenueWeights);
        const currentCost = allocateProportionally(costTarget, costWeights);
        const byVariant = new Map<Id<"productVariants">, VariantPaymentAllocation>();
        for (let index = 0; index < lines.length; index++) {
          const variantId = lines[index].item.variantId;
          const entry = byVariant.get(variantId) ?? {
            variantId,
            revenue: 0,
            landedCost: 0,
          };
          entry.revenue += currentRevenue[index] - previousRevenue[index];
          entry.landedCost += currentCost[index] - previousCost[index];
          byVariant.set(variantId, entry);
        }
        byPayment.set(payment._id, [...byVariant.values()]);
        previousRevenue = currentRevenue;
        previousCost = currentCost;
      }
    })
  );
  return byPayment;
}

type PaymentAllocation = {
  itemCost: number;
  deliveryFee: number;
  deliveryCost: number;
};

/**
 * Allocate matched payment rows against each sale's complete payment history.
 * The period read stays on by_receivedDay; by_sale reads only supply the prior
 * cumulative balance needed to make separate day queries additive.
 */
async function loadPaymentAllocations(
  ctx: { db: QueryCtx["db"] },
  matchedPayments: Doc<"payments">[]
): Promise<Map<string, PaymentAllocation>> {
  const saleIds = [...new Set(matchedPayments.map((payment) => payment.saleId))];
  const allocationByPayment = new Map<string, PaymentAllocation>();

  await Promise.all(
    saleIds.map(async (saleId) => {
      const [costs, salePayments] = await Promise.all([
        orderCosts(ctx, saleId),
        ctx.db
          .query("payments")
          .withIndex("by_sale", (q) => q.eq("saleId", saleId))
          .collect(),
      ]);
      if (costs.total <= 0) return;

      salePayments.sort(
        (a, b) =>
          a.receivedAt - b.receivedAt ||
          a._creationTime - b._creationTime ||
          String(a._id).localeCompare(String(b._id))
      );
      let cumulativeAmount = 0;
      let previous: PaymentAllocation = { itemCost: 0, deliveryFee: 0, deliveryCost: 0 };
      for (const payment of salePayments) {
        cumulativeAmount += payment.amount;
        const next = {
          itemCost: Math.round((cumulativeAmount / costs.total) * costs.itemCost),
          deliveryFee: Math.round((cumulativeAmount / costs.total) * costs.deliveryFee),
          deliveryCost: Math.round((cumulativeAmount / costs.total) * costs.deliveryCost),
        };
        allocationByPayment.set(payment._id, {
          itemCost: next.itemCost - previous.itemCost,
          deliveryFee: next.deliveryFee - previous.deliveryFee,
          deliveryCost: next.deliveryCost - previous.deliveryCost,
        });
        previous = next;
      }
    })
  );

  return allocationByPayment;
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

  const allocationByPayment = await loadPaymentAllocations(ctx, payments);

  let moneyIn = 0;
  let refunds = 0;
  let cogs = 0;
  let deliveryIncome = 0;
  let deliveryCost = 0;
  for (const payment of payments) {
    moneyIn += payment.amount;
    if (payment.amount < 0) refunds += -payment.amount;
    const allocation = allocationByPayment.get(payment._id);
    if (!allocation) continue;
    cogs += allocation.itemCost;
    deliveryIncome += allocation.deliveryFee;
    deliveryCost += allocation.deliveryCost;
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

    const allocationByPayment = await loadPaymentAllocations(ctx, payments);

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
        cogs += allocationByPayment.get(payment._id)?.itemCost ?? 0;
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
    const allocationByPayment = await loadPaymentAllocations(ctx, payments);
    const saleById = new Map<string, (typeof salesInPeriod)[number]>();
    await Promise.all(
      saleIds.map(async (saleId) => {
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
      const allocation = allocationByPayment.get(payment._id);
      if (!sale || !allocation) continue;
      const entry =
        byChannel.get(sale.salesChannelId) ?? { orders: 0, revenue: 0, profit: 0 };
      entry.revenue += payment.amount;
      entry.profit +=
        payment.amount -
        allocation.itemCost -
        allocation.deliveryCost;
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

// Current customer balances grouped by customer. This is a balance report,
// not cash-basis revenue: every payment ever recorded against an order is
// netted, refunds reopen debt, and each order keeps its own non-negative
// balance. No stored customer total exists that could drift.
export const getCustomerDebtReport = query({
  args: {
    paginationOpts: paginationOptsValidator,
    search: v.optional(v.string()),
  },
  returns: customerDebtReport,
  handler: async (ctx, args) => {
    await requireUser(ctx);
    const shop = await getShop(ctx);
    const asOfDay = dayString(Date.now(), shop.timezone);
    const asOfOrdinal = calendarDayOrdinal(asOfDay);
    const sales = await ctx.db.query("sales").withIndex("by_createdAt").collect();
    const owingOrders = (
      await Promise.all(
        sales
          .filter((sale) => sale.status !== "draft")
          .map(async (sale) => {
            const [total, paid] = await Promise.all([
              computeTotal(ctx, sale),
              computePaid(ctx, sale._id),
            ]);
            const remaining = Math.max(0, total - paid);
            if (remaining <= 0) return null;
            const ageDays = Math.max(
              0,
              asOfOrdinal - calendarDayOrdinal(dayString(sale.createdAt, shop.timezone))
            );
            return { sale, remaining, ageDays };
          })
      )
    ).filter((row) => row !== null);

    const grouped = new Map<
      Id<"customers">,
      {
        totalOwed: number;
        unpaidOrderCount: number;
        aging: DebtAging;
        oldest: (typeof owingOrders)[number];
      }
    >();
    for (const order of owingOrders) {
      const existing = grouped.get(order.sale.customerId);
      if (existing) {
        existing.totalOwed += order.remaining;
        existing.unpaidOrderCount += 1;
        addDebtToAging(existing.aging, order.ageDays, order.remaining);
        if (order.sale.createdAt < existing.oldest.sale.createdAt) {
          existing.oldest = order;
        }
      } else {
        const aging = emptyDebtAging();
        addDebtToAging(aging, order.ageDays, order.remaining);
        grouped.set(order.sale.customerId, {
          totalOwed: order.remaining,
          unpaidOrderCount: 1,
          aging,
          oldest: order,
        });
      }
    }

    const customers = await Promise.all(
      [...grouped.keys()].map((customerId) => ctx.db.get(customerId))
    );
    const search = args.search?.trim().toLowerCase() ?? "";
    const phoneSearch = search.replace(/[^0-9]/g, "").replace(/^0+/, "");
    const rows = customers
      .filter((customer) => customer !== null)
      .map((customer) => {
        const debt = grouped.get(customer._id)!;
        return {
          customerId: customer._id,
          customerName: customer.name,
          customerPhone: customer.phone,
          totalOwed: debt.totalOwed,
          unpaidOrderCount: debt.unpaidOrderCount,
          aging: debt.aging,
          oldestOrderId: debt.oldest.sale._id,
          oldestOrderCode: debt.oldest.sale.code,
          oldestOrderAt: debt.oldest.sale.createdAt,
          oldestAgeDays: debt.oldest.ageDays,
        };
      })
      .filter(
        (row) =>
          !search ||
          row.customerName.toLowerCase().includes(search) ||
          (phoneSearch.length > 0 && row.customerPhone.includes(phoneSearch))
      )
      .sort(
        (a, b) =>
          b.totalOwed - a.totalOwed ||
          a.oldestOrderAt - b.oldestOrderAt ||
          a.customerId.localeCompare(b.customerId)
      );

    const aging = emptyDebtAging();
    let totalOwed = 0;
    for (const row of rows) {
      totalOwed += row.totalOwed;
      aging.days0To7 += row.aging.days0To7;
      aging.days8To30 += row.aging.days8To30;
      aging.days31To60 += row.aging.days31To60;
      aging.over60Days += row.aging.over60Days;
    }
    const requestedOffset = Number(args.paginationOpts.cursor ?? "0");
    const offset =
      Number.isSafeInteger(requestedOffset) && requestedOffset >= 0
        ? requestedOffset
        : 0;
    const pageSize = Math.min(Math.max(Math.floor(args.paginationOpts.numItems), 1), 100);
    const page = rows.slice(offset, offset + pageSize);
    const nextOffset = offset + page.length;
    return {
      asOfDay,
      totalOwed,
      customerCount: rows.length,
      aging,
      page,
      continueCursor: nextOffset < rows.length ? String(nextOffset) : "",
      total: rows.length,
    };
  },
});

export const getProductPerformanceReport = query({
  args: {
    period: v.object({
      type: v.union(v.literal("day"), v.literal("month"), v.literal("year")),
      value: v.string(),
    }),
    search: v.optional(v.string()),
    paginationOpts: paginationOptsValidator,
  },
  returns: productPerformanceReport,
  handler: async (ctx, args) => {
    await requireUser(ctx);
    const shop = await getShop(ctx);
    const { from, to } = periodRange(args.period.type, args.period.value);
    const fromMs = dayRange(from, shop.timezone).from;
    const toMs = dayRange(to, shop.timezone).from;
    const [movements, payments] = await Promise.all([
      ctx.db
        .query("stockLedger")
        .withIndex("by_ts", (q) => q.gte("ts", fromMs).lt("ts", toMs))
        .collect(),
      ctx.db
        .query("payments")
        .withIndex("by_receivedDay", (q) =>
          q.gte("receivedDay", from).lt("receivedDay", to)
        )
        .collect(),
    ]);

    const metrics = new Map<
      Id<"productVariants">,
      {
        unitsSold: number;
        returnedUnits: number;
        exchangedUnits: number;
        revenue: number;
        landedCost: number;
      }
    >();
    const getMetrics = (variantId: Id<"productVariants">) => {
      const current = metrics.get(variantId) ?? {
        unitsSold: 0,
        returnedUnits: 0,
        exchangedUnits: 0,
        revenue: 0,
        landedCost: 0,
      };
      metrics.set(variantId, current);
      return current;
    };
    for (const movement of movements) {
      if (
        movement.reason === "sale" ||
        movement.reason === "cancel" ||
        movement.reason === "return" ||
        movement.reason === "exchange_out" ||
        movement.reason === "exchange_in"
      ) {
        getMetrics(movement.variantId).unitsSold -= movement.delta;
      }
      if (movement.reason === "return" && movement.delta > 0) {
        getMetrics(movement.variantId).returnedUnits += movement.delta;
      }
      if (movement.reason === "exchange_out" && movement.delta > 0) {
        getMetrics(movement.variantId).exchangedUnits += movement.delta;
      }
    }

    const allocations = await loadPaymentVariantAllocations(ctx, payments);
    for (const payment of payments) {
      for (const allocation of allocations.get(payment._id) ?? []) {
        const row = getMetrics(allocation.variantId);
        row.revenue += allocation.revenue;
        row.landedCost += allocation.landedCost;
      }
    }

    const variants = await Promise.all(
      [...metrics.keys()].map((variantId) => ctx.db.get(variantId))
    );
    const productIds = [
      ...new Set(
        variants.filter((variant) => variant !== null).map((variant) => variant.productId)
      ),
    ];
    const products = await Promise.all(productIds.map((productId) => ctx.db.get(productId)));
    const productById = new Map(
      products.filter((product) => product !== null).map((product) => [product._id, product])
    );
    const search = args.search?.trim().toLowerCase() ?? "";
    const rows = variants
      .filter((variant) => variant !== null)
      .map((variant) => {
        const product = productById.get(variant.productId);
        if (!product) return null;
        const values = metrics.get(variant._id)!;
        return {
          productId: product._id,
          variantId: variant._id,
          productName: product.name,
          productCode: product.code,
          size: variant.size,
          color: variant.color,
          sku: variant.sku,
          ...values,
          profit: values.revenue - values.landedCost,
        };
      })
      .filter((row) => row !== null)
      .filter(
        (row) =>
          !search ||
          [row.productName, row.productCode, row.size, row.color, row.sku]
            .filter((value) => value !== undefined)
            .some((value) => value.toLowerCase().includes(search))
      )
      .sort(
        (a, b) =>
          b.unitsSold - a.unitsSold ||
          b.revenue - a.revenue ||
          a.productName.localeCompare(b.productName) ||
          a.size.localeCompare(b.size) ||
          (a.color ?? "").localeCompare(b.color ?? "") ||
          a.variantId.localeCompare(b.variantId)
      );

    const totals = {
      unitsSold: 0,
      returnedUnits: 0,
      exchangedUnits: 0,
      revenue: 0,
      landedCost: 0,
      profit: 0,
    };
    for (const row of rows) {
      totals.unitsSold += row.unitsSold;
      totals.returnedUnits += row.returnedUnits;
      totals.exchangedUnits += row.exchangedUnits;
      totals.revenue += row.revenue;
      totals.landedCost += row.landedCost;
      totals.profit += row.profit;
    }
    const requestedOffset = Number(args.paginationOpts.cursor ?? "0");
    const offset =
      Number.isSafeInteger(requestedOffset) && requestedOffset >= 0
        ? requestedOffset
        : 0;
    const pageSize = Math.min(Math.max(Math.floor(args.paginationOpts.numItems), 1), 100);
    const page = rows.slice(offset, offset + pageSize);
    const nextOffset = offset + page.length;
    return {
      periodType: args.period.type,
      periodValue: args.period.value,
      fromDay: from,
      toDay: to,
      totals,
      page,
      continueCursor: nextOffset < rows.length ? String(nextOffset) : "",
      total: rows.length,
    };
  },
});

export const getInventoryValueReport = query({
  args: {
    search: v.optional(v.string()),
    status: v.optional(
      v.union(v.literal("all"), v.literal("active"), v.literal("inactive"))
    ),
    paginationOpts: paginationOptsValidator,
  },
  returns: inventoryValueReport,
  handler: async (ctx, args) => {
    await requireUser(ctx);
    const products = await ctx.db.query("products").withIndex("by_nameLower").collect();
    const variantsByProduct = await Promise.all(
      products.map(async (product) => ({
        product,
        variants: await ctx.db
          .query("productVariants")
          .withIndex("by_product", (q) => q.eq("productId", product._id))
          .collect(),
      }))
    );
    const valuedRows = await Promise.all(
      variantsByProduct.flatMap(({ product, variants }) =>
        variants.map(async (variant) => {
          const [currentQty, weightedLandedUnitCost] = await Promise.all([
            variantQty(ctx, variant._id),
            weightedAvgCost(ctx, variant._id, variant, product),
          ]);
          const active = product.active && variant.active;
          return {
            productId: product._id,
            variantId: variant._id,
            productName: product.name,
            productCode: product.code,
            size: variant.size,
            color: variant.color,
            sku: variant.sku,
            productActive: product.active,
            variantActive: variant.active,
            active,
            currentQty,
            weightedLandedUnitCost,
            totalValue: Math.max(0, currentQty) * weightedLandedUnitCost,
          };
        })
      )
    );
    const search = args.search?.trim().toLowerCase() ?? "";
    const status = args.status ?? "all";
    const rows = valuedRows
      .filter(
        (row) =>
          status === "all" ||
          (status === "active" ? row.active : !row.active)
      )
      .filter(
        (row) =>
          !search ||
          [row.productName, row.productCode, row.size, row.color, row.sku]
            .filter((value): value is string => value !== undefined)
            .some((value) => value.toLowerCase().includes(search))
      )
      .sort(
        (a, b) =>
          b.totalValue - a.totalValue ||
          a.productName.localeCompare(b.productName) ||
          a.size.localeCompare(b.size) ||
          (a.color ?? "").localeCompare(b.color ?? "") ||
          a.variantId.localeCompare(b.variantId)
      );
    const totals = {
      totalUnits: 0,
      totalValue: 0,
      variantCount: rows.length,
      inactiveVariantCount: 0,
    };
    for (const row of rows) {
      totals.totalUnits += Math.max(0, row.currentQty);
      totals.totalValue += row.totalValue;
      if (!row.active) totals.inactiveVariantCount += 1;
    }
    const requestedOffset = Number(args.paginationOpts.cursor ?? "0");
    const offset =
      Number.isSafeInteger(requestedOffset) && requestedOffset >= 0
        ? requestedOffset
        : 0;
    const pageSize = Math.min(Math.max(Math.floor(args.paginationOpts.numItems), 1), 100);
    const page = rows.slice(offset, offset + pageSize);
    const nextOffset = offset + page.length;
    return {
      totals,
      page,
      continueCursor: nextOffset < rows.length ? String(nextOffset) : "",
      total: rows.length,
    };
  },
});

export const getDeadStockReport = query({
  args: {
    thresholdDays: deadStockThreshold,
    search: v.optional(v.string()),
    paginationOpts: paginationOptsValidator,
  },
  returns: deadStockReport,
  handler: async (ctx, args) => {
    await requireUser(ctx);
    const shop = await getShop(ctx);
    const asOfDay = dayString(Date.now(), shop.timezone);
    const asOfOrdinal = calendarDayOrdinal(asOfDay);
    const products = await ctx.db.query("products").withIndex("by_nameLower").collect();
    const variantsByProduct = await Promise.all(
      products.map(async (product) => ({
        product,
        variants: await ctx.db
          .query("productVariants")
          .withIndex("by_product", (q) => q.eq("productId", product._id))
          .collect(),
      }))
    );
    const candidates = await Promise.all(
      variantsByProduct.flatMap(({ product, variants }) =>
        variants.map(async (variant) => {
          const ledger = await ctx.db
            .query("stockLedger")
            .withIndex("by_variant_ts", (q) => q.eq("variantId", variant._id))
            .collect();
          let currentQty = 0;
          let firstStockedAt: number | undefined;
          let lastSoldAt: number | undefined;
          for (const movement of ledger) {
            currentQty += movement.delta;
            if (
              movement.delta > 0 &&
              (firstStockedAt === undefined || movement.ts < firstStockedAt)
            ) {
              firstStockedAt = movement.ts;
            }
            if (
              movement.delta < 0 &&
              (movement.reason === "sale" || movement.reason === "exchange_in") &&
              (lastSoldAt === undefined || movement.ts > lastSoldAt)
            ) {
              lastSoldAt = movement.ts;
            }
          }
          if (currentQty <= 0) return null;
          const agingAnchorAt = lastSoldAt ?? firstStockedAt ?? variant._creationTime;
          const ageDays = Math.max(
            0,
            asOfOrdinal -
              calendarDayOrdinal(dayString(agingAnchorAt, shop.timezone))
          );
          if (ageDays < args.thresholdDays) return null;
          const weightedLandedUnitCost = await weightedAvgCost(
            ctx,
            variant._id,
            variant,
            product
          );
          return {
            productId: product._id,
            variantId: variant._id,
            productName: product.name,
            productCode: product.code,
            size: variant.size,
            color: variant.color,
            sku: variant.sku,
            active: product.active && variant.active,
            currentQty,
            ...(lastSoldAt !== undefined ? { lastSoldAt } : {}),
            agingAnchorAt,
            ageDays,
            weightedLandedUnitCost,
            tiedUpValue: currentQty * weightedLandedUnitCost,
          };
        })
      )
    );
    const search = args.search?.trim().toLowerCase() ?? "";
    const rows = candidates
      .filter((row) => row !== null)
      .filter(
        (row) =>
          !search ||
          [row.productName, row.productCode, row.size, row.color, row.sku]
            .filter((value): value is string => value !== undefined)
            .some((value) => value.toLowerCase().includes(search))
      )
      .sort(
        (a, b) =>
          b.ageDays - a.ageDays ||
          b.tiedUpValue - a.tiedUpValue ||
          a.productName.localeCompare(b.productName) ||
          a.size.localeCompare(b.size) ||
          (a.color ?? "").localeCompare(b.color ?? "") ||
          a.variantId.localeCompare(b.variantId)
      );
    const totals = {
      totalUnits: 0,
      tiedUpValue: 0,
      variantCount: rows.length,
      neverSoldCount: 0,
      inactiveVariantCount: 0,
    };
    for (const row of rows) {
      totals.totalUnits += row.currentQty;
      totals.tiedUpValue += row.tiedUpValue;
      if (row.lastSoldAt === undefined) totals.neverSoldCount += 1;
      if (!row.active) totals.inactiveVariantCount += 1;
    }
    const requestedOffset = Number(args.paginationOpts.cursor ?? "0");
    const offset =
      Number.isSafeInteger(requestedOffset) && requestedOffset >= 0
        ? requestedOffset
        : 0;
    const pageSize = Math.min(Math.max(Math.floor(args.paginationOpts.numItems), 1), 100);
    const page = rows.slice(offset, offset + pageSize);
    const nextOffset = offset + page.length;
    return {
      asOfDay,
      thresholdDays: args.thresholdDays,
      totals,
      page,
      continueCursor: nextOffset < rows.length ? String(nextOffset) : "",
      total: rows.length,
    };
  },
});

export const getReorderPlanningReport = query({
  args: {
    lookbackDays: reorderDays,
    targetDays: reorderDays,
    search: v.optional(v.string()),
    paginationOpts: paginationOptsValidator,
  },
  returns: reorderPlanningReport,
  handler: async (ctx, args) => {
    await requireUser(ctx);
    const shop = await getShop(ctx);
    const asOfDay = dayString(Date.now(), shop.timezone);
    const asOfOrdinal = calendarDayOrdinal(asOfDay);
    const fromDay = dayFromOrdinal(asOfOrdinal - args.lookbackDays + 1);
    const nextDay = dayFromOrdinal(asOfOrdinal + 1);
    const fromMs = dayRange(fromDay, shop.timezone).from;
    const toMs = dayRange(nextDay, shop.timezone).from;
    const products = (
      await ctx.db.query("products").withIndex("by_nameLower").collect()
    ).filter((product) => product.active);
    const variantsByProduct = await Promise.all(
      products.map(async (product) => ({
        product,
        variants: (
          await ctx.db
            .query("productVariants")
            .withIndex("by_product", (q) => q.eq("productId", product._id))
            .collect()
        ).filter((variant) => variant.active),
      }))
    );
    const planned = await Promise.all(
      variantsByProduct.flatMap(({ product, variants }) =>
        variants.map(async (variant) => {
          const ledger = await ctx.db
            .query("stockLedger")
            .withIndex("by_variant_ts", (q) => q.eq("variantId", variant._id))
            .collect();
          let currentQty = 0;
          let unitsSoldInLookback = 0;
          for (const movement of ledger) {
            currentQty += movement.delta;
            if (movement.ts < fromMs || movement.ts >= toMs) continue;
            if (
              movement.reason === "sale" ||
              movement.reason === "cancel" ||
              movement.reason === "return" ||
              movement.reason === "exchange_out" ||
              movement.reason === "exchange_in"
            ) {
              unitsSoldInLookback -= movement.delta;
            }
          }
          unitsSoldInLookback = Math.max(0, unitsSoldInLookback);
          if (unitsSoldInLookback === 0) return null;
          const averageDaily = unitsSoldInLookback / args.lookbackDays;
          const targetQty = Math.ceil(averageDaily * args.targetDays);
          const suggestedReorderQty = Math.max(0, targetQty - Math.max(0, currentQty));
          if (suggestedReorderQty === 0) return null;
          const weightedLandedUnitCost = await weightedAvgCost(
            ctx,
            variant._id,
            variant,
            product
          );
          return {
            productId: product._id,
            variantId: variant._id,
            productName: product.name,
            productCode: product.code,
            size: variant.size,
            color: variant.color,
            sku: variant.sku,
            currentQty,
            unitsSoldInLookback,
            averageDailyUnits: Math.round(averageDaily * 100) / 100,
            estimatedDaysRemaining: Math.floor(Math.max(0, currentQty) / averageDaily),
            suggestedReorderQty,
            weightedLandedUnitCost,
            estimatedReorderCost: suggestedReorderQty * weightedLandedUnitCost,
          };
        })
      )
    );
    const search = args.search?.trim().toLowerCase() ?? "";
    const rows = planned
      .filter((row) => row !== null)
      .filter(
        (row) =>
          !search ||
          [row.productName, row.productCode, row.size, row.color, row.sku]
            .filter((value): value is string => value !== undefined)
            .some((value) => value.toLowerCase().includes(search))
      )
      .sort(
        (a, b) =>
          b.suggestedReorderQty - a.suggestedReorderQty ||
          a.estimatedDaysRemaining - b.estimatedDaysRemaining ||
          a.productName.localeCompare(b.productName) ||
          a.size.localeCompare(b.size) ||
          a.variantId.localeCompare(b.variantId)
      );
    const totals = {
      variantCount: rows.length,
      suggestedUnits: 0,
      estimatedReorderCost: 0,
    };
    for (const row of rows) {
      totals.suggestedUnits += row.suggestedReorderQty;
      totals.estimatedReorderCost += row.estimatedReorderCost;
    }
    const requestedOffset = Number(args.paginationOpts.cursor ?? "0");
    const offset =
      Number.isSafeInteger(requestedOffset) && requestedOffset >= 0
        ? requestedOffset
        : 0;
    const pageSize = Math.min(Math.max(Math.floor(args.paginationOpts.numItems), 1), 100);
    const page = rows.slice(offset, offset + pageSize);
    const nextOffset = offset + page.length;
    return {
      asOfDay,
      lookbackDays: args.lookbackDays,
      targetDays: args.targetDays,
      fromDay,
      totals,
      page,
      continueCursor: nextOffset < rows.length ? String(nextOffset) : "",
      total: rows.length,
    };
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
