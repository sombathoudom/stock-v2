import { ConvexError, v } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { mutation, query } from "./_generated/server";
import { assertCents, dayString, getShop, moneyStr, requireUser } from "./helpers";
import {
  applyDeliveredAdjustments,
  buildDetail,
  cancelOutstanding,
  computeOwed,
  computePaid,
  computeTotal,
  dayRange,
  fillAllDelivered,
  variantLabel,
} from "./sales";
import { deliveryOutcome, deliveryReport, saleDetail } from "./types";

// T17 — the evening delivery ritual (AGENTS.md). Today's orders out for
// delivery are grouped by delivery company; the owner marks each one's
// outcome from whatever confirmation they got (a forwarded photo, a call,
// a paper list — the app assumes no report format). Outcomes drive stock
// flow-back and the fee payable per company. Owners without a delivery
// flow never see this screen (the nav hides it).

const notFoundSale = () =>
  new ConvexError({ code: "NOT_FOUND", message: "Order not found." });

const lockedSale = () =>
  new ConvexError({
    code: "INVALID_INPUT",
    message: "This order can't be changed anymore.",
  });

/** "Basic Tee — M · Black ×2" — plain-language list of what's in the package. */
async function itemSummary(
  ctx: { db: QueryCtx["db"] },
  saleId: Id<"sales">
): Promise<string> {
  const items = await ctx.db
    .query("saleItems")
    .withIndex("by_sale", (q) => q.eq("saleId", saleId))
    .collect();
  const parts: string[] = [];
  for (const item of items) {
    const variant = await ctx.db.get(item.variantId);
    const product = variant ? await ctx.db.get(variant.productId) : null;
    const qty = item.qtyOrdered - item.qtyCancelled - item.qtyReturned;
    if (qty > 0) parts.push(`${variantLabel(product, variant)} ×${qty}`);
  }
  return parts.join(", ") || "—";
}

/** One row on the evening screen — money is derived, never stored. */
async function row(
  ctx: { db: QueryCtx["db"] },
  sale: Doc<"sales">
): Promise<{
  sale: Doc<"sales">;
  customerName: string;
  customerPhone: string;
  customerAddress?: string;
  itemSummary: string;
  total: number;
  paid: number;
  remaining: number;
}> {
  const customer = await ctx.db.get(sale.customerId);
  const [total, owed, paid] = await Promise.all([
    computeTotal(ctx, sale),
    computeOwed(ctx, sale),
    computePaid(ctx, sale._id),
  ]);
  return {
    sale,
    customerName: customer?.name ?? "—",
    customerPhone: customer?.phone ?? "—",
    customerAddress: customer?.address,
    itemSummary: await itemSummary(ctx, sale._id),
    total,
    paid,
    remaining: Math.max(0, owed - paid),
  };
}

/** The evening screen: every order still out for delivery (no day cutoff —
 * nothing gets lost) grouped by delivery company, plus today's marked
 * outcomes, with per-company summaries. */
export const listToday = query({
  args: {},
  returns: deliveryReport,
  handler: async (ctx) => {
    await requireUser(ctx);
    const shop = await getShop(ctx);
    if (!shop.deliveryEnabled) {
      return { deliveryEnabled: false, groups: [] };
    }
    const now = Date.now();
    const { from, to } = dayRange(dayString(now, shop.timezone), shop.timezone);

    const openSales = await ctx.db
      .query("sales")
      .withIndex("by_status_createdAt", (q) => q.eq("status", "delivering"))
      .collect();
    const markedSales = await ctx.db
      .query("sales")
      .withIndex("by_outcomeMarkedAt", (q) =>
        q.gte("outcomeMarkedAt", from).lt("outcomeMarkedAt", to)
      )
      .collect();

    const companies = await ctx.db
      .query("deliveryCompanies")
      .withIndex("by_nameLower")
      .collect();
    const companyById = new Map(companies.map((c) => [c._id, c]));

    // One bucket per company that actually has orders (open or marked),
    // plus a self-delivery bucket for orders with no company.
    const buckets = new Map<string, Doc<"deliveryCompanies"> | null>();
    const openByKey = new Map<string, Doc<"sales">[]>();
    const markedByKey = new Map<string, Doc<"sales">[]>();
    const bucketKey = (sale: Doc<"sales">) => sale.deliveryCompanyId ?? "self";
    for (const sale of [...openSales, ...markedSales]) {
      const key = bucketKey(sale);
      if (!buckets.has(key)) {
        buckets.set(key, sale.deliveryCompanyId ? companyById.get(sale.deliveryCompanyId) ?? null : null);
      }
    }
    for (const sale of openSales) {
      const key = bucketKey(sale);
      let list = openByKey.get(key);
      if (!list) {
        list = [];
        openByKey.set(key, list);
      }
      list.push(sale);
    }
    for (const sale of markedSales) {
      const key = bucketKey(sale);
      let list = markedByKey.get(key);
      if (!list) {
        list = [];
        markedByKey.set(key, list);
      }
      list.push(sale);
    }

    const groups = [];
    for (const [key, company] of buckets) {
      const open = openByKey.get(key) ?? [];
      const marked = markedByKey.get(key) ?? [];
      const rows = await Promise.all(
        [...open, ...marked].map((s) => row(ctx, s))
      );
      groups.push({
        company: company ?? undefined,
        open: rows.slice(0, open.length),
        marked: rows.slice(open.length),
        handledCount: open.length + marked.length,
        deliveredCount: marked.filter((s) => s.deliveryOutcome === "delivered").length,
        partialCount: marked.filter((s) => s.deliveryOutcome === "partial").length,
        returnsCount: marked.filter((s) => s.deliveryOutcome === "returned").length,
        cancellationsCount: marked.filter((s) => s.deliveryOutcome === "cancelled").length,
        feeTotal: [...open, ...marked].reduce((sum, s) => sum + s.deliveryCost, 0),
      });
    }
    groups.sort((a, b) =>
      (a.company?.nameLower ?? "￿").localeCompare(b.company?.nameLower ?? "￿")
    );
    return { deliveryEnabled: true, groups };
  },
});

/** Mark how one package ended. Outcomes drive the stock ledger:
 * delivered → everything left the shelf; partial → per-line quantities with
 * the rest flowing back; returned / cancelled → everything flows back. */
export const markOutcome = mutation({
  args: {
    saleId: v.id("sales"),
    outcome: deliveryOutcome,
    adjustments: v.optional(
      v.array(
        v.object({
          saleItemId: v.id("saleItems"),
          qtyDelivered: v.number(),
        })
      )
    ),
    note: v.optional(v.string()),
    // Returned / cancelled only: the delivery man made the trip and the
    // customer refused the goods, so the shipping fee stays on the bill.
    chargeDeliveryFee: v.optional(v.boolean()),
  },
  returns: saleDetail,
  handler: async (ctx, args) => {
    const { staff } = await requireUser(ctx);
    const sale = await ctx.db.get(args.saleId);
    if (!sale) throw notFoundSale();
    // Only packages out for delivery can be marked — everything else
    // already has a known outcome.
    if (sale.status !== "delivering") {
      throw new ConvexError({
        code: "INVALID_INPUT",
        message: "Only orders out for delivery can be marked.",
      });
    }
    const now = Date.now();
    let status: Doc<"sales">["status"];
    switch (args.outcome) {
      case "delivered": {
        // The customer took everything — fill every line (oversell-checked).
        await fillAllDelivered(ctx, sale, staff, now);
        status = "delivered";
        break;
      }
      case "partial": {
        // The customer took some pieces: record per line what actually went
        // out, then every remaining outstanding piece (lines the customer
        // didn't take at all included) flows back to the shelf.
        const adjustments = args.adjustments ?? [];
        if (!adjustments.some((a) => a.qtyDelivered > 0)) {
          throw new ConvexError({
            code: "INVALID_INPUT",
            message:
              "For a partial delivery, record how many of each item the customer took.",
          });
        }
        await applyDeliveredAdjustments(ctx, sale, staff, adjustments, now);
        await cancelOutstanding(ctx, sale, staff, `Not taken — ${sale.code}`, now);
        status = "partially_delivered";
        break;
      }
      case "returned": {
        // Nothing was taken — everything flows back.
        await cancelOutstanding(ctx, sale, staff, `Returned — ${sale.code}`, now);
        status = "cancelled";
        break;
      }
      case "cancelled": {
        await cancelOutstanding(ctx, sale, staff, `Cancelled ${sale.code}`, now);
        status = "cancelled";
        break;
      }
    }
    const patch: Partial<Doc<"sales">> = {
      status,
      deliveryOutcome: args.outcome,
      outcomeMarkedAt: now,
    };
    if (status === "delivered" || status === "partially_delivered") {
      patch.deliveredAt = sale.deliveredAt ?? now;
    }
    // The trip happened even though the goods came back: keep the shipping
    // fee owed. Only meaningful on a cancelling outcome with a fee set —
    // anything else is ignored rather than written onto the row.
    const chargeTrip =
      args.chargeDeliveryFee === true &&
      status === "cancelled" &&
      sale.deliveryFee > 0;
    if (chargeTrip) patch.chargeDeliveryOnCancel = true;
    await ctx.db.patch(sale._id, patch);
    await ctx.db.insert("saleEvents", {
      saleId: sale._id,
      type: "delivery_outcome",
      summary: chargeTrip
        ? `Delivery outcome: ${args.outcome}. Shipping ${moneyStr(sale.deliveryFee)} still charged.`
        : `Delivery outcome: ${args.outcome}.`,
      payload: {
        outcome: args.outcome,
        ...(args.note?.trim() ? { note: args.note.trim() } : {}),
      },
      userId: staff._id,
      ts: now,
    });
    return await buildDetail(ctx, (await ctx.db.get(sale._id))!);
  },
});

/** The fee the shop pays the company for this order — adjusted here on the
 * evening screen before the per-company total becomes an expense. */
export const setDeliveryCost = mutation({
  args: {
    saleId: v.id("sales"),
    amount: v.number(),
  },
  returns: saleDetail,
  handler: async (ctx, args) => {
    const { staff } = await requireUser(ctx);
    const sale = await ctx.db.get(args.saleId);
    if (!sale) throw notFoundSale();
    if (sale.status === "draft" || sale.status === "cancelled") throw lockedSale();
    const amount = assertCents(args.amount, "delivery cost");
    if (amount === sale.deliveryCost) return await buildDetail(ctx, sale);
    const now = Date.now();
    await ctx.db.patch(sale._id, { deliveryCost: amount });
    await ctx.db.insert("saleEvents", {
      saleId: sale._id,
      type: "delivery_cost_changed",
      summary: `Delivery cost ${moneyStr(sale.deliveryCost)} → ${moneyStr(amount)}.`,
      payload: { from: moneyStr(sale.deliveryCost), to: moneyStr(amount) },
      userId: staff._id,
      ts: now,
    });
    return await buildDetail(ctx, (await ctx.db.get(sale._id))!);
  },
});

/** Attach the packaging photo (shot before the package left) so the owner
 * can match a confirmation photo to the right package. */
export const setPackagingPhoto = mutation({
  args: {
    saleId: v.id("sales"),
    imageStorageId: v.id("_storage"),
  },
  returns: saleDetail,
  handler: async (ctx, args) => {
    await requireUser(ctx);
    const sale = await ctx.db.get(args.saleId);
    if (!sale) throw notFoundSale();
    if (sale.status === "draft" || sale.status === "cancelled") throw lockedSale();
    await ctx.db.patch(sale._id, { imageStorageId: args.imageStorageId });
    return await buildDetail(ctx, (await ctx.db.get(sale._id))!);
  },
});

/** First upload endpoint in the app — used by the T3 product photo and the
 * T17 packaging photo. The returned URL accepts a POST with the raw bytes;
 * the caller then hands the storage id to a mutation. */
export const generateUploadUrl = mutation({
  args: {},
  returns: v.string(),
  handler: async (ctx) => {
    await requireUser(ctx);
    return await ctx.storage.generateUploadUrl();
  },
});
