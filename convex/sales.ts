import { ConvexError, v } from "convex/values";
import { paginationOptsValidator } from "convex/server";

import type { Doc, Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { mutation, query } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import {
  assertCents,
  assertQty,
  dayString,
  getShop,
  moneyStr,
  requireUser,
  startOfDay,
} from "./helpers";
import { variantQty } from "./stock";
import {
  checkoutLine,
  checkoutPayment,
  saleDetail,
  saleEditData,
  saleEditItemInput,
  saleListRow,
  saleStatus,
} from "./types";

// T10/T11/T12 — POS checkout, the sales list, and the order lifecycle
// (AGENTS.md). The client sends ids + quantities + intents only; every
// business value is re-derived here: prices from the variant/product, cost
// snapshots from the ledger, stock from the ledger, totals from the lines.
// Checkout creates a CONFIRMED sale and deducts stock immediately — always
// via ledger rows, never counters (rule #1). Overselling is impossible:
// stock is re-checked at checkout time.

const LINES_MAX = 200;

/**
 * The ONE oversell rule, shared by checkout and saveEdit: every variant that
 * flows OUT must have the pieces on the shelf. `outflowByVariant` maps
 * variantId → pieces leaving (a positive number is outflow; zero/negative
 * entries are stock coming back and are always writable). Checkout fills it
 * cumulatively per line (the same variant may be sold twice), saveEdit with
 * the NET per variant (a drop on one line can fund a raise on another).
 */
export async function assertStockCovers(
  ctx: { db: QueryCtx["db"] },
  outflowByVariant: Map<Id<"productVariants">, number>
): Promise<void> {
  for (const [variantId, outflow] of outflowByVariant) {
    if (outflow <= 0) continue;
    const stock = await variantQty(ctx, variantId);
    if (stock < outflow) {
      throw new ConvexError({
        code: "OUT_OF_STOCK",
        message: "Not enough stock for this item.",
      });
    }
  }
}

/**
 * Weighted-average cost of a variant at sale time (rule #3): the average
 * unit cost over the RECEIVED purchase batches currently feeding the shelf
 * (purchase ledger rows → their purchaseItems). Falls back to the variant
 * override, then the product's reference cost, when nothing was purchased.
 */
export async function weightedAvgCost(
  ctx: { db: QueryCtx["db"] },
  variantId: Id<"productVariants">,
  variant: Doc<"productVariants">,
  product: Doc<"products">
): Promise<number> {
  const rows = await ctx.db
    .query("stockLedger")
    .withIndex("by_variant_ts", (q) => q.eq("variantId", variantId))
    .collect();
  const purchaseItemIds = [
    ...new Set(
      rows
        .filter((r) => r.reason === "purchase" && r.purchaseItemId !== undefined)
        .map((r) => r.purchaseItemId!)
    ),
  ];
  const items = await Promise.all(purchaseItemIds.map((id) => ctx.db.get(id)));
  let totalQty = 0;
  let totalCost = 0;
  for (const item of items) {
    if (!item) continue;
    totalQty += item.qty;
    totalCost += item.qty * item.unitCost;
  }
  if (totalQty > 0) return Math.round(totalCost / totalQty);
  return variant.cost ?? product.defaultCost;
}

/** Next display code "20260815-001" — shop-day based; mutations serialize so count + 1 never collides. */
async function nextSaleCode(ctx: MutationCtx, now: number): Promise<string> {
  const shop = await getShop(ctx);
  const prefix = `${dayString(now, shop.timezone).replace(/-/g, "")}-`;
  const count = (
    await ctx.db
      .query("sales")
      .withIndex("by_code", (q) => q.gte("code", prefix).lt("code", `${prefix}￿`))
      .collect()
  ).length;
  return `${prefix}${String(count + 1).padStart(3, "0")}`;
}

/** One line's money value: the pieces that actually went out (ordered −
 * cancelled − returned) at unit price, minus the line's discount. Shared by
 * computeTotal / computeOwed and the batch summary math (batchMoney) so the
 * per-order totals and the summary cards can never drift apart. */
function lineValue(item: Doc<"saleItems">): number {
  return (
    item.unitPrice * (item.qtyOrdered - item.qtyCancelled - item.qtyReturned) -
    (item.discount ?? 0)
  );
}

/** The shipping fee that still counts on an order (integer cents).
 *
 * A live order always charges its fee. A CANCELLED order normally charges
 * nothing — the customer walked away, so the whole bill goes. The exception
 * is the trip that actually happened: the package went out, the delivery man
 * knocked, and the customer refused the goods. The owner ticks "customer
 * still pays shipping" while cancelling and the fee survives as the only
 * thing owed. Orders cancelled before that flag existed have it undefined,
 * so their bill stays exactly zero. */
export function chargedDeliveryFee(sale: Doc<"sales">): number {
  if (sale.status !== "cancelled") return sale.deliveryFee;
  return sale.chargeDeliveryOnCancel ? sale.deliveryFee : 0;
}

/** Order total from its lines + discount + delivery fee (integer cents).
 * Counts only the pieces that actually went out (ordered − cancelled −
 * returned), so cancelled lines and returned pieces never inflate the money.
 * A cancelled order has no goods left to bill, so its total is just the
 * shipping fee (zero unless the trip is being charged) — the order-level
 * discount applied to goods that are back on the shelf. */
export async function computeTotal(
  ctx: { db: QueryCtx["db"] },
  sale: Doc<"sales">
): Promise<number> {
  if (sale.status === "cancelled") return chargedDeliveryFee(sale);
  const items = await ctx.db
    .query("saleItems")
    .withIndex("by_sale", (q) => q.eq("saleId", sale._id))
    .collect();
  let total = 0;
  for (const item of items) total += lineValue(item);
  return total - sale.discount + sale.deliveryFee;
}

/** What the customer still owes: the value of the pieces that actually went
 * out (ordered − cancelled − returned), minus discounts, plus the delivery
 * fee. A cancelled order owes nothing — except the shipping fee when the trip
 * happened and is being charged. Floor at 0 — never a negative debt. */
export async function computeOwed(
  ctx: { db: QueryCtx["db"] },
  sale: Doc<"sales">
): Promise<number> {
  if (sale.status === "cancelled") return chargedDeliveryFee(sale);
  const items = await ctx.db
    .query("saleItems")
    .withIndex("by_sale", (q) => q.eq("saleId", sale._id))
    .collect();
  let owed = 0;
  for (const item of items) owed += lineValue(item);
  return Math.max(0, owed - sale.discount + sale.deliveryFee);
}

/** Sum of payment rows — refunds are negative rows, so this nets money out. */
export async function computePaid(
  ctx: { db: QueryCtx["db"] },
  saleId: Id<"sales">
): Promise<number> {
  const payments = await ctx.db
    .query("payments")
    .withIndex("by_sale", (q) => q.eq("saleId", saleId))
    .collect();
  let paid = 0;
  for (const payment of payments) paid += payment.amount;
  return paid;
}

/** Epoch range of a YYYY-MM-DD day in the shop timezone. Noon UTC is the
 * same calendar day in every timezone (±12h), so startOfDay lands on D. */
export function dayRange(day: string, timeZone: string): { from: number; to: number } {
  const noon = new Date(`${day}T12:00:00Z`).getTime();
  const from = startOfDay(noon, timeZone);
  return { from, to: from + 86_400_000 };
}

/**
 * Full order detail with computed money (all integer cents): order total,
 * paid, remaining, and per-order profit (rule #3). Shared by checkout's
 * return value, payments.ts, and the T12 order-detail page. Also joins the
 * full event trail (rule #8), newest first, with each actor's name.
 */
export async function buildDetail(
  ctx: { db: QueryCtx["db"] },
  sale: Doc<"sales">
) {
  const customer = (await ctx.db.get(sale.customerId))!;
  const channel = (await ctx.db.get(sale.salesChannelId))!;
  const companyDoc = sale.deliveryCompanyId
    ? await ctx.db.get(sale.deliveryCompanyId)
    : null;
  const itemDocs = await ctx.db
    .query("saleItems")
    .withIndex("by_sale", (q) => q.eq("saleId", sale._id))
    .collect();

  // Join reads, deduped by id: one get per distinct variant / product.
  const variantIds = [...new Set(itemDocs.map((item) => item.variantId))];
  const variants = await Promise.all(variantIds.map((id) => ctx.db.get(id)));
  const variantById = new Map(
    variants.filter((v) => v !== null).map((v) => [v._id, v] as const)
  );
  const productIds = [...new Set([...variantById.values()].map((v) => v.productId))];
  const products = await Promise.all(productIds.map((id) => ctx.db.get(id)));
  const productById = new Map(
    products.filter((p) => p !== null).map((p) => [p._id, p] as const)
  );

  const items = [];
  for (const item of itemDocs) {
    const variant = variantById.get(item.variantId);
    const product = variant ? productById.get(variant.productId) : undefined;
    if (!variant || !product) continue; // defensive — nothing is hard-deleted
    items.push({
      item,
      variant,
      product,
      // Invariant 6: what the customer currently holds is always the derived
      // difference — delivered is historical and never decremented.
      withCustomer: item.qtyDelivered - item.qtyReturned,
    });
  }

  const payments = await ctx.db
    .query("payments")
    .withIndex("by_sale", (q) => q.eq("saleId", sale._id))
    .collect();

  const total = await computeTotal(ctx, sale);
  const paid = await computePaid(ctx, sale._id);
  const owed = await computeOwed(ctx, sale);

  // Profit counts only what actually sold (ordered − cancelled − returned);
  // a cancelled order sold nothing, so its profit is zero — the pieces are
  // back on the shelf (cancel ledger rows) and the delivery cost, if any, is
  // an expense. The one exception is a cancelled order whose trip is still
  // billed: that trip IS a transaction, so it earns the fee and carries the
  // company's cost.
  let profit = 0;
  if (sale.status === "cancelled") {
    if (sale.chargeDeliveryOnCancel) {
      profit = sale.deliveryFee - sale.deliveryCost;
    }
  } else {
    for (const { item } of items) {
      profit +=
        (item.unitPrice - item.unitCostSnapshot) *
          (item.qtyOrdered - item.qtyCancelled - item.qtyReturned) -
        (item.discount ?? 0);
    }
    profit = profit - sale.discount + sale.deliveryFee - sale.deliveryCost;
  }

  const eventDocs = await ctx.db
    .query("saleEvents")
    .withIndex("by_sale_ts", (q) => q.eq("saleId", sale._id))
    .collect();
  eventDocs.sort((a, b) => b.ts - a.ts); // newest first
  const eventUserIds = [...new Set(eventDocs.map((e) => e.userId))];
  const eventUsers = await Promise.all(eventUserIds.map((id) => ctx.db.get(id)));
  const eventUserById = new Map(
    eventUsers.filter((u) => u !== null).map((u) => [u._id, u.name] as const)
  );
  const events = eventDocs.map((event) => ({
    event,
    userName: eventUserById.get(event.userId) ?? "—",
  }));

  const creator = await ctx.db.get(sale.userId);
  return {
    sale,
    customer,
    channel,
    ...(companyDoc !== null ? { company: companyDoc } : {}),
    items,
    payments,
    events,
    total,
    paid,
    remaining: Math.max(0, owed - paid),
    profit,
    createdByName: creator?.name ?? "—",
  };
}

export const checkout = mutation({
  args: {
    customerId: v.id("customers"),
    salesChannelId: v.id("salesChannels"),
    deliveryCompanyId: v.optional(v.id("deliveryCompanies")),
    deliveryFee: v.optional(v.number()), // defaults to the company's fee — the popup sends none
    deliveryCost: v.optional(v.number()), // defaults to the company's fee — the popup sends none
    discount: v.number(),
    items: v.array(checkoutLine),
    payment: v.optional(checkoutPayment),
    note: v.optional(v.string()), // sale note — stored on the sale row
    createdAt: v.optional(v.number()), // optional backdated sale date (epoch ms)
  },
  returns: saleDetail,
  handler: async (ctx, args) => {
    const { staff } = await requireUser(ctx);
    const shop = await getShop(ctx);
    const now = Date.now();

    // Optional backdated sale date (epoch ms, never the future). The sale
    // row, its stock movements, and the "created" event all carry this same
    // moment, so a sale made today for yesterday lands in yesterday's order
    // code, day, and reports — stock left the shelf when the sale happened.
    let createdAt = now;
    if (args.createdAt !== undefined) {
      if (
        !Number.isFinite(args.createdAt) ||
        args.createdAt <= 0 ||
        args.createdAt > now
      ) {
        throw new ConvexError({
          code: "INVALID_SALE_DATE",
          message: "Sale date can't be in the future.",
        });
      }
      createdAt = Math.floor(args.createdAt);
    }

    if (args.items.length === 0 || args.items.length > LINES_MAX) {
      throw new ConvexError({
        code: "EMPTY_CART",
        message: "Add at least one item.",
      });
    }

    const customer = await ctx.db.get(args.customerId);
    if (!customer) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Customer not found." });
    }
    const channel = await ctx.db.get(args.salesChannelId);
    if (!channel) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Sales page not found." });
    }

    // Delivery off → no company, no fees (in-store pickup or own delivery).
    // A fee sent while the module is off is a mistake, not something to drop
    // silently — the cashier saw that amount in the total.
    let companyDoc: Doc<"deliveryCompanies"> | null = null;
    let deliveryFee = 0;
    let deliveryCost = 0;
    if (!shop.deliveryEnabled) {
      if (args.deliveryFee !== undefined || args.deliveryCost !== undefined) {
        throw new ConvexError({
          code: "INVALID_INPUT",
          message: "Delivery is turned off in shop settings.",
        });
      }
    } else {
      if (args.deliveryCompanyId !== undefined) {
        companyDoc = await ctx.db.get(args.deliveryCompanyId);
        if (!companyDoc) {
          throw new ConvexError({
            code: "NOT_FOUND",
            message: "Delivery company not found.",
          });
        }
      }
      // Shipping fee CHARGED TO THE CUSTOMER: the POS sends it explicitly
      // (prefilled from the picked company's default fee, then overridable),
      // so it stands on its own when the shop delivers the package itself —
      // no company, still a shipping charge. Nothing sent + a company →
      // fall back to that company's default fee.
      deliveryFee =
        args.deliveryFee === undefined
          ? (companyDoc?.defaultFee ?? 0)
          : assertCents(args.deliveryFee, "delivery fee");
      // What the shop PAYS the company — only ever owed when a company
      // actually handled the package.
      deliveryCost =
        companyDoc === null
          ? 0
          : args.deliveryCost === undefined
            ? companyDoc.defaultFee
            : assertCents(args.deliveryCost, "delivery cost");
      if (deliveryFee < 0 || deliveryCost < 0) {
        throw new ConvexError({
          code: "INVALID_MONEY",
          message: "Delivery fees can't be negative.",
        });
      }
    }

    // Lines: re-derive every price and cost; check stock against the ledger.
    const prepared: {
      line: { variantId: Id<"productVariants">; qty: number; discount?: number };
      qty: number;
      variant: Doc<"productVariants">;
      product: Doc<"products">;
      price: number;
      unitCostSnapshot: number;
      itemDiscount: number;
    }[] = [];
    let subtotal = 0;
    // The POS keeps every add as its OWN line — the same variant may appear
    // several times ("never merged"). Oversell protection must therefore be
    // CUMULATIVE: track the running qty per variant here and let the shared
    // assertStockCovers below check the ledger once per variant at the end —
    // two lines that each pass on their own can't double-spend the shelf.
    const qtyByVariant = new Map<Id<"productVariants">, number>();
    for (const line of args.items) {
      const qty = assertQty(line.qty, 1, "qty");
      const variant = await ctx.db.get(line.variantId);
      const product = variant ? await ctx.db.get(variant.productId) : null;
      if (!variant || !variant.active || !product || !product.active) {
        throw new ConvexError({ code: "NOT_FOUND", message: "Item not found." });
      }
      const price = assertCents(variant.price ?? product.defaultPrice, "price");
      qtyByVariant.set(line.variantId, (qtyByVariant.get(line.variantId) ?? 0) + qty);
      const unitCostSnapshot = await weightedAvgCost(ctx, line.variantId, variant, product);
      const itemDiscount =
        line.discount === undefined ? 0 : assertCents(line.discount, "item discount");
      if (itemDiscount < 0 || itemDiscount > price * qty) {
        throw new ConvexError({
          code: "INVALID_MONEY",
          message: "Item discount is out of range.",
        });
      }
      subtotal += price * qty - itemDiscount;
      prepared.push({ line, qty, variant, product, price, unitCostSnapshot, itemDiscount });
    }

    // Oversell is impossible: the shared rule re-checks the ledger for every
    // variant the cart draws from, cumulatively across repeated lines.
    await assertStockCovers(ctx, qtyByVariant);

    const discount = assertCents(args.discount, "discount");
    if (discount < 0 || discount > subtotal) {
      throw new ConvexError({
        code: "INVALID_MONEY",
        message: "Order discount is out of range.",
      });
    }
    const total = subtotal - discount + deliveryFee;

    // Payment: manual entry (cash / bank / other), full or partial. The
    // cashier may receive MORE than the total — the change goes back to the
    // customer, so the recorded row is CLAMPED to the total (the net kept).
    // Money is recognized on the day it is received; receivedAt may backdate
    // to any past moment, never into the future.
    let paymentAmount = 0;
    let paymentNote: string | undefined;
    let receivedAt = now;
    if (args.payment !== undefined) {
      const entered = assertCents(args.payment.amount, "payment");
      if (entered < 0) {
        throw new ConvexError({
          code: "INVALID_PAYMENT",
          message: "Payment can't be negative.",
        });
      }
      paymentAmount = Math.min(entered, total);
      paymentNote = args.payment.note?.trim().slice(0, 500) || undefined;
      if (args.payment.receivedAt !== undefined) {
        if (
          !Number.isFinite(args.payment.receivedAt) ||
          args.payment.receivedAt <= 0 ||
          args.payment.receivedAt > now
        ) {
          throw new ConvexError({
            code: "INVALID_PAYMENT",
            message: "Payment date can't be in the future.",
          });
        }
        receivedAt = Math.floor(args.payment.receivedAt);
      }
    }
    const saleNote = args.note?.trim().slice(0, 500) || undefined;

    const code = await nextSaleCode(ctx, createdAt);
    const saleId = await ctx.db.insert("sales", {
      code,
      customerId: args.customerId,
      salesChannelId: args.salesChannelId,
      deliveryCompanyId: companyDoc?._id,
      status: "confirmed",
      deliveryFee,
      deliveryCost,
      discount,
      userId: staff._id,
      createdAt,
      note: saleNote,
    });

    for (const p of prepared) {
      const itemId = await ctx.db.insert("saleItems", {
        saleId,
        variantId: p.line.variantId,
        unitPrice: p.price,
        unitCostSnapshot: p.unitCostSnapshot,
        qtyOrdered: p.qty,
        qtyDelivered: 0,
        qtyCancelled: 0,
        qtyReturned: 0,
        discount: p.itemDiscount === 0 ? undefined : p.itemDiscount,
      });
      await ctx.db.insert("stockLedger", {
        variantId: p.line.variantId,
        delta: -p.qty,
        reason: "sale",
        saleItemId: itemId,
        userId: staff._id,
        ts: createdAt,
        note: `Sale ${code}`,
      });
    }

    if (paymentAmount > 0) {
      await ctx.db.insert("payments", {
        saleId,
        amount: paymentAmount,
        receivedAt,
        receivedDay: dayString(receivedAt, shop.timezone),
        method: args.payment!.method,
        userId: staff._id,
        note: paymentNote,
      });
    }

    await ctx.db.insert("saleEvents", {
      saleId,
      type: "created",
      summary: `Order ${code} created — confirmed.`,
      userId: staff._id,
      ts: createdAt,
    });

    const sale = (await ctx.db.get(saleId))!;
    return await buildDetail(ctx, sale);
  },
});

// One order with everything the detail page and the invoice need — null for
// an unknown id (the page shows "not found").
export const getDetail = query({
  args: { saleId: v.id("sales") },
  returns: v.union(saleDetail, v.null()),
  handler: async (ctx, args) => {
    await requireUser(ctx);
    const sale = await ctx.db.get(args.saleId);
    if (!sale) return null;
    return await buildDetail(ctx, sale);
  },
});

/**
 * Everything the full-page edit screen needs, in one read: the order, who and
 * where it's for, and each line with the numbers its quantity box depends on.
 *
 * Kept separate from `getDetail` on purpose — `saleDetail` is the shared
 * return shape of eight functions, so widening it for one screen would ripple
 * through all of them.
 *
 * The quantity a line can be raised to needs care. `stock` is what's on the
 * shelf right now, and the pieces already on THIS order were deducted when it
 * was created — so the shelf figure alone reads far too low. The real ceiling
 * is `maxQty` = what the line bills now + what's on the shelf. The floor is
 * the line's `qtyDelivered` (already in the returned item doc): those pieces
 * are with the customer and only the return flow can take them off the bill.
 * Both are UX guides — `saveEdit` re-checks the ledger when it saves.
 */
export const getEditData = query({
  args: { saleId: v.id("sales") },
  returns: v.union(saleEditData, v.null()),
  handler: async (ctx, args) => {
    await requireUser(ctx);
    const sale = await ctx.db.get(args.saleId);
    if (!sale) return null;
    const customer = await ctx.db.get(sale.customerId);
    const channel = await ctx.db.get(sale.salesChannelId);
    if (!customer || !channel) return null;
    const companyDoc = sale.deliveryCompanyId
      ? await ctx.db.get(sale.deliveryCompanyId)
      : null;

    const itemDocs = await ctx.db
      .query("saleItems")
      .withIndex("by_sale", (q) => q.eq("saleId", sale._id))
      .collect();

    // Join reads deduped by id, and ONE stock read per distinct variant —
    // a line repeated across the order must not re-walk the same ledger.
    const variantIds = [...new Set(itemDocs.map((item) => item.variantId))];
    const variants = await Promise.all(variantIds.map((id) => ctx.db.get(id)));
    const variantById = new Map(
      variants.filter((variant) => variant !== null).map((variant) => [variant._id, variant] as const)
    );
    const productIds = [...new Set([...variantById.values()].map((variant) => variant.productId))];
    const products = await Promise.all(productIds.map((id) => ctx.db.get(id)));
    const productById = new Map(
      products.filter((product) => product !== null).map((product) => [product._id, product] as const)
    );
    const stockByVariant = new Map<string, number>();
    for (const variantId of variantIds) {
      stockByVariant.set(variantId, await variantQty(ctx, variantId));
    }

    const items = [];
    for (const item of itemDocs) {
      const variant = variantById.get(item.variantId);
      const product = variant ? productById.get(variant.productId) : undefined;
      if (!variant || !product) continue; // defensive — nothing is hard-deleted
      const billedQty = item.qtyOrdered - item.qtyCancelled - item.qtyReturned;
      const stock = stockByVariant.get(item.variantId) ?? 0;
      items.push({ item, variant, product, billedQty, stock, maxQty: billedQty + stock });
    }

    const total = await computeTotal(ctx, sale);
    const paid = await computePaid(ctx, sale._id);
    const owed = await computeOwed(ctx, sale);
    return {
      sale,
      customer,
      channel,
      ...(companyDoc !== null ? { company: companyDoc } : {}),
      items,
      total,
      paid,
      remaining: Math.max(0, owed - paid),
      // The order's edit counter — saveEdit rejects a save whose version no
      // longer matches (see the stale-edit guard there).
      version: sale.editedVersion ?? 0,
    };
  },
});

/** What a sale is owed minus what was paid. A cancelled order owes nothing.
 * Shared by toListRow and the summary aggregates. */
function remainingOf(_sale: Doc<"sales">, total: number, paid: number): number {
  // No cancelled special case here: a cancelled order's total is already the
  // charged shipping fee (zero unless the trip is billed), so total − paid is
  // right for every status and can't disagree with computeOwed.
  return Math.max(0, total - paid);
}

/** One sale's money line — total / paid / remaining, all integer cents. */
async function moneyRow(
  ctx: { db: QueryCtx["db"] },
  sale: Doc<"sales">
): Promise<{ sale: Doc<"sales">; total: number; paid: number; remaining: number }> {
  const total = await computeTotal(ctx, sale);
  const paid = await computePaid(ctx, sale._id);
  return { sale, total, paid, remaining: remainingOf(sale, total, paid) };
}

/** Join one sale into a list row: names + computed money (integer cents). */
export async function toListRow(
  ctx: { db: QueryCtx["db"] },
  sale: Doc<"sales">
) {
  const customer = await ctx.db.get(sale.customerId);
  const channel = await ctx.db.get(sale.salesChannelId);
  const { total, paid, remaining } = await moneyRow(ctx, sale);
  return {
    sale,
    customerName: customer?.name ?? "—",
    customerPhone: customer?.phone ?? "",
    channelName: channel?.name ?? "—",
    total,
    paid,
    remaining,
  };
}

// Extra list filters (customer / date range / payment state). No single
// index can express "customer AND status AND date range" — and payment state
// can't be indexed at all: it lives in the payments table and is derived on
// read. So when ANY of these is set, the list routes through a bounded-window
// scan modeled on listUnpaid: the 250 most recent of each status, money
// computed per row, filtered in memory. Same tradeoff as listUnpaid: rows
// older than the window are invisible to the filter. At single-shop scale
// the window covers far more than any real backlist, and the summary cards
// (see summary below) read the same filtered set, so the list and the cards
// always agree.
const FILTER_SCAN = 250;

const ALL_SALE_STATUSES: Doc<"sales">["status"][] = [
  "draft",
  "confirmed",
  "pending",
  "packed",
  "delivering",
  "delivered",
  "partially_delivered",
  "cancelled",
];

/** The list's filter args minus pagination — shared by list and summary. */
type SaleListFilters = {
  search?: string;
  status?: Doc<"sales">["status"];
  channelId?: Id<"salesChannels">;
  day?: string;
  customerId?: Id<"customers">;
  fromDay?: string;
  toDay?: string;
  paymentStatus?: "paid" | "partly_paid" | "unpaid";
};

/** Derived payment state of a row: paid when nothing is left, unpaid when
 * nothing was paid, partly_paid in between. Cancelled and draft rows are
 * excluded before this runs (see filteredRows) — cancelled would otherwise
 * compute to "paid" via the forced-0 remaining. */
function paymentStateOf(
  row: { paid: number; remaining: number }
): "paid" | "partly_paid" | "unpaid" {
  if (row.remaining <= 0) return "paid";
  if (row.paid === 0) return "unpaid";
  return "partly_paid";
}

/**
 * The filtered sale list rows for the extra-filter path (any of customerId /
 * fromDay / toDay / paymentStatus set). Bounded-window scan: the 250 most
 * recent of each status via by_status_createdAt, money per order via
 * toListRow (indexed by_sale reads), filtered in memory. No index can
 * express payment status, so the window is the tradeoff — same as listUnpaid.
 * Filter order: date range → customer → status → channel → code prefix →
 * payment state. Drafts are unfinished orders and never appear as paid /
 * unpaid rows, so a payment filter excludes them (cancelled rows keep
 * remaining = 0 and stay, whichever state they compute to).
 */
async function filteredRows(
  ctx: { db: QueryCtx["db"] },
  args: SaleListFilters
): Promise<Awaited<ReturnType<typeof toListRow>>[]> {
  const term = args.search?.trim().toLowerCase() ?? "";
  const shop = await getShop(ctx);
  // [fromMs, toMs) in the shop timezone: fromDay = start of that day, toDay
  // = end of that day (exclusive). Partial ranges allowed — one side only.
  const fromMs =
    args.fromDay !== undefined ? dayRange(args.fromDay, shop.timezone).from : null;
  const toMs =
    args.toDay !== undefined ? dayRange(args.toDay, shop.timezone).to : null;
  const batches = await Promise.all(
    ALL_SALE_STATUSES.map((status) =>
      ctx.db
        .query("sales")
        .withIndex("by_status_createdAt", (q) => q.eq("status", status))
        .order("desc")
        .take(FILTER_SCAN)
    )
  );
  const merged = batches.flat().sort((a, b) => b.createdAt - a.createdAt);
  const rows = [];
  for (const sale of merged) {
    if (fromMs !== null && sale.createdAt < fromMs) continue;
    if (toMs !== null && sale.createdAt >= toMs) continue;
    if (args.customerId !== undefined && sale.customerId !== args.customerId) continue;
    if (args.status !== undefined && sale.status !== args.status) continue;
    if (args.channelId !== undefined && sale.salesChannelId !== args.channelId) continue;
    if (term && !sale.code.toLowerCase().startsWith(term)) continue;
    // Drafts are unfinished orders and cancelled rows show no payment badge
    // ("—") — neither belongs in a paid/unpaid view.
    if (
      args.paymentStatus !== undefined &&
      (sale.status === "draft" || sale.status === "cancelled")
    ) {
      continue;
    }
    const row = await toListRow(ctx, sale);
    if (
      args.paymentStatus !== undefined &&
      paymentStateOf(row) !== args.paymentStatus
    ) {
      continue;
    }
    rows.push(row);
  }
  return rows;
}

// T12 — the sales list. Filters are index-driven: order-code prefix search,
// a status, a sales page (channel), or a shop day (status+day compose).
// Money is computed per page row — pages are ≤100 and every read is an
// indexed by_sale lookup, so this stays cheap. An empty continueCursor
// signals "no more pages" to the client. Customer / date-range / payment
// state filters can't be indexed (payment state lives in the payments
// table) — when any of those is set, the handler routes through the
// bounded-window scan above instead.
export const list = query({
  args: {
    paginationOpts: paginationOptsValidator,
    search: v.optional(v.string()),
    status: v.optional(saleStatus),
    channelId: v.optional(v.id("salesChannels")),
    day: v.optional(v.string()),
    customerId: v.optional(v.id("customers")),
    fromDay: v.optional(v.string()), // YYYY-MM-DD, start of that shop-tz day
    toDay: v.optional(v.string()), // YYYY-MM-DD, end of that shop-tz day
    paymentStatus: v.optional(
      v.union(v.literal("paid"), v.literal("partly_paid"), v.literal("unpaid"))
    ),
  },
  returns: v.object({
    page: v.array(saleListRow),
    continueCursor: v.string(),
    total: v.number(),
  }),
  handler: async (ctx, args) => {
    await requireUser(ctx);
    // Extra filters (customer / date range / payment state) can't be
    // expressed by any single index — see filteredRows. When any of them is
    // set, route through the bounded-window scan; pagination is the same
    // manual offset-cursor as listUnpaid. With none of them set, the indexed
    // paths below run unchanged.
    const hasExtraFilters =
      args.customerId !== undefined ||
      args.fromDay !== undefined ||
      args.toDay !== undefined ||
      args.paymentStatus !== undefined;
    if (hasExtraFilters) {
      const rows = await filteredRows(ctx, args);
      const offset = args.paginationOpts.cursor
        ? Math.max(0, Number(args.paginationOpts.cursor) || 0)
        : 0;
      const page = rows.slice(offset, offset + args.paginationOpts.numItems);
      return {
        page,
        continueCursor:
          offset + page.length < rows.length ? String(offset + page.length) : "",
        total: rows.length,
      };
    }
    const term = args.search?.trim().toLowerCase() ?? "";
    let range: { from: number; to: number } | null = null;
    if (args.day !== undefined) {
      const shop = await getShop(ctx);
      range = dayRange(args.day, shop.timezone);
    }
    const build = () => {
      if (term) {
        return ctx.db
          .query("sales")
          .withIndex("by_code", (q) =>
            q.gte("code", term).lt("code", `${term}￿`)
          );
      }
      if (args.status !== undefined) {
        return ctx.db.query("sales").withIndex("by_status_createdAt", (q) => {
          const eq = q.eq("status", args.status!);
          return range
            ? eq.gte("createdAt", range.from).lte("createdAt", range.to)
            : eq;
        });
      }
      if (args.channelId !== undefined) {
        const channelId = args.channelId;
        return ctx.db
          .query("sales")
          .withIndex("by_channel", (q) => q.eq("salesChannelId", channelId));
      }
      return ctx.db.query("sales").withIndex("by_createdAt", (q) => {
        return range
          ? q.gte("createdAt", range.from).lte("createdAt", range.to)
          : q;
      });
    };
    const page = await build().order("desc").paginate(args.paginationOpts);
    const total = (await build().take(1000)).length;
    const rows = await Promise.all(page.page.map((sale) => toListRow(ctx, sale)));
    return { page: rows, continueCursor: page.isDone ? "" : page.continueCursor, total };
  },
});

// T11/T12 — the "still owed" view: recent orders in any money-owing status
// that are not fully paid. Cancelled orders owe nothing, so they are never
// scanned. No index can express "remaining > 0", so this scans a bounded
// window (the 250 most recent of each status), computes paid per order
// (indexed by_sale reads), filters in memory, and paginates the result
// manually — the cursor is the row offset, "" means "done".
const OWED_STATUSES: Doc<"sales">["status"][] = [
  "confirmed",
  "pending",
  "packed",
  "delivering",
  "delivered",
  "partially_delivered",
];

export const listUnpaid = query({
  args: { paginationOpts: paginationOptsValidator },
  returns: v.object({
    page: v.array(saleListRow),
    continueCursor: v.string(),
    total: v.number(),
  }),
  handler: async (ctx, args) => {
    await requireUser(ctx);
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
    const rows = [];
    for (const sale of merged) {
      const row = await toListRow(ctx, sale);
      if (row.total - row.paid <= 0) continue; // fully paid — not "owed"
      rows.push(row);
    }
    const offset = args.paginationOpts.cursor
      ? Math.max(0, Number(args.paginationOpts.cursor) || 0)
      : 0;
    const page = rows.slice(offset, offset + args.paginationOpts.numItems);
    return {
      page,
      continueCursor: offset + page.length < rows.length ? String(offset + page.length) : "",
      total: rows.length,
    };
  },
});

// T20/T12 — the summary cards above the sales list (Sales count / Total /
// Paid / Due). Aggregates EXACTLY the set the list shows for the same
// filters: the extra-filter path shares filteredRows with list (same
// bounded window, same in-memory filters); the index-only path collects the
// FULL matching set — list pages only the visible window, the cards count
// everything the list would page through. All money integer cents.
export const summary = query({
  args: {
    search: v.optional(v.string()),
    status: v.optional(saleStatus),
    channelId: v.optional(v.id("salesChannels")),
    day: v.optional(v.string()),
    customerId: v.optional(v.id("customers")),
    fromDay: v.optional(v.string()), // YYYY-MM-DD, start of that shop-tz day
    toDay: v.optional(v.string()), // YYYY-MM-DD, end of that shop-tz day
    paymentStatus: v.optional(
      v.union(v.literal("paid"), v.literal("partly_paid"), v.literal("unpaid"))
    ),
  },
  returns: v.object({
    count: v.number(),
    total: v.number(), // Σ order totals, integer cents
    paid: v.number(), // Σ payments received, integer cents
    due: v.number(), // Σ remaining — cancelled orders owe nothing
  }),
  handler: async (ctx, args) => {
    await requireUser(ctx);
    const hasExtraFilters =
      args.customerId !== undefined ||
      args.fromDay !== undefined ||
      args.toDay !== undefined ||
      args.paymentStatus !== undefined;
    if (hasExtraFilters) {
      // Same bounded window + filters as list — the cards match the list.
      const rows = await filteredRows(ctx, args);
      let count = 0;
      let total = 0;
      let paid = 0;
      let due = 0;
      for (const row of rows) {
        count++;
        total += row.total;
        paid += row.paid;
        due += row.remaining;
      }
      return { count, total, paid, due };
    }
    // Index-only filters: aggregate the ENTIRE matched set (the same set the
    // indexed list paths page through). Money is batched in two collects
    // (saleItems + payments) instead of per-sale reads — same arithmetic as
    // toListRow, so the cards always match the per-order totals.
    const sales = await fullMatchedSales(ctx, args);
    const money = await batchMoney(ctx, sales);
    let total = 0;
    let paid = 0;
    let due = 0;
    for (const sale of sales) {
      const m = money.get(sale._id)!;
      total += m.total;
      paid += m.paid;
      due += m.remaining;
    }
    return { count: sales.length, total, paid, due };
  },
});

/** The whole matched sale set for the index-only filters — same precedence
 * as list's indexed paths (term → status+day → channel → createdAt+day).
 * Collects the ENTIRE range: summary aggregates what list pages. At
 * single-shop scale a full indexed collect is cheap; the 16k-doc read
 * ceiling is the practical cap on how large the set can be. */
async function fullMatchedSales(
  ctx: { db: QueryCtx["db"] },
  args: SaleListFilters
): Promise<Doc<"sales">[]> {
  const term = args.search?.trim().toLowerCase() ?? "";
  let range: { from: number; to: number } | null = null;
  if (args.day !== undefined) {
    const shop = await getShop(ctx);
    range = dayRange(args.day, shop.timezone);
  }
  const build = () => {
    if (term) {
      return ctx.db
        .query("sales")
        .withIndex("by_code", (q) => q.gte("code", term).lt("code", `${term}￿`));
    }
    if (args.status !== undefined) {
      return ctx.db.query("sales").withIndex("by_status_createdAt", (q) => {
        const eq = q.eq("status", args.status!);
        return range
          ? eq.gte("createdAt", range.from).lte("createdAt", range.to)
          : eq;
      });
    }
    if (args.channelId !== undefined) {
      const channelId = args.channelId;
      return ctx.db
        .query("sales")
        .withIndex("by_channel", (q) => q.eq("salesChannelId", channelId));
    }
    return ctx.db.query("sales").withIndex("by_createdAt", (q) => {
      return range ? q.gte("createdAt", range.from).lte("createdAt", range.to) : q;
    });
  };
  return await build().order("desc").collect();
}

/** Batch money for many sales in TWO reads — one collect of saleItems, one
 * of payments — grouped in memory by saleId. Same arithmetic as
 * computeTotal / computePaid (lineValue + Σ amounts), so the cards always
 * match per-order totals. Whole-table collects are fine at single-shop
 * scale; the 16k-doc read ceiling is the upper bound (a shop big enough to
 * bust it gets paginated lists instead of cards). */
async function batchMoney(
  ctx: { db: QueryCtx["db"] },
  sales: Doc<"sales">[]
): Promise<Map<Id<"sales">, { total: number; paid: number; remaining: number }>> {
  const items = await ctx.db.query("saleItems").collect();
  const payments = await ctx.db.query("payments").collect();
  const itemTotals = new Map<Id<"sales">, number>();
  for (const item of items) {
    itemTotals.set(item.saleId, (itemTotals.get(item.saleId) ?? 0) + lineValue(item));
  }
  const paidBySale = new Map<Id<"sales">, number>();
  for (const payment of payments) {
    paidBySale.set(payment.saleId, (paidBySale.get(payment.saleId) ?? 0) + payment.amount);
  }
  const out = new Map<Id<"sales">, { total: number; paid: number; remaining: number }>();
  for (const sale of sales) {
    // Same rule as computeTotal: a cancelled order bills only the charged
    // shipping fee, so the summary cards and the rows can never disagree.
    const total =
      sale.status === "cancelled"
        ? chargedDeliveryFee(sale)
        : (itemTotals.get(sale._id) ?? 0) - sale.discount + sale.deliveryFee;
    const paid = paidBySale.get(sale._id) ?? 0;
    out.set(sale._id, { total, paid, remaining: remainingOf(sale, total, paid) });
  }
  return out;
}

// T27 — the customer credit ledger: every order this customer still owes
// money on, newest first, plus the total outstanding. DERIVED on read — no
// stored balance anywhere (a counter would drift; the sum never does). The
// by_customer index walks only this customer's orders (bounded — one
// customer's open orders are a handful), with per-sale indexed reads, so no
// scan of the sales table. The cursor is the row offset, "" means "done".
export const listOwedByCustomer = query({
  args: {
    customerId: v.id("customers"),
    paginationOpts: paginationOptsValidator,
  },
  returns: v.object({
    page: v.array(saleListRow),
    continueCursor: v.string(),
    total: v.number(),
    totalOwed: v.number(), // Σ remaining, integer cents
  }),
  handler: async (ctx, args) => {
    await requireUser(ctx);
    const SCAN = 200;
    const sales = await ctx.db
      .query("sales")
      .withIndex("by_customer", (q) => q.eq("customerId", args.customerId))
      .order("desc")
      .take(SCAN);
    const rows = [];
    let totalOwed = 0;
    for (const sale of sales) {
      const row = await toListRow(ctx, sale);
      if (row.remaining <= 0) continue; // fully paid / cancelled — not debt
      totalOwed += row.remaining;
      rows.push(row);
    }
    const offset = args.paginationOpts.cursor
      ? Math.max(0, Number(args.paginationOpts.cursor) || 0)
      : 0;
    const page = rows.slice(offset, offset + args.paginationOpts.numItems);
    return {
      page,
      continueCursor: offset + page.length < rows.length ? String(offset + page.length) : "",
      total: rows.length,
      totalOwed,
    };
  },
});

// T12 — order lifecycle. One saleEvents row per change, always. Cancelling
// flows every outstanding piece back to the shelf via `cancel` ledger rows
// (rule #1: the ledger is the only stock writer). Forward steps may be
// skipped (an owner may not pack at all); delivering/delivered corrections
// may move backward one step. Cancelled is terminal — a reopened order is a
// new order.
// Stages may be SKIPPED forward (a self-delivered order never needs a
// "delivering" stage), but a finished delivery never re-opens: "delivered"
// can only fall back to "partially_delivered" (a mistaken mark at the
// door), never back to "delivering".
const ALLOWED_TRANSITIONS: Record<string, string[]> = {
  // Drafts stay closed here: confirming one must ALSO deduct its stock, and
  // this mutation only moves the status. Checkout creates confirmed sales
  // directly, so nothing writes a draft today — when a draft flow lands it
  // gets its own confirm mutation that writes the ledger rows.
  draft: [],
  // Pending is a post-confirm regression ("wait before processing"): stock
  // is already out from checkout, so no movement is written here. From
  // pending ANY later stage is reachable, including back to confirmed.
  pending: ["confirmed", "packed", "delivering", "delivered", "partially_delivered", "cancelled"],
  confirmed: ["pending", "packed", "delivering", "delivered", "partially_delivered", "cancelled"],
  packed: ["delivering", "delivered", "partially_delivered", "cancelled"],
  delivering: ["delivered", "partially_delivered", "cancelled"],
  delivered: ["partially_delivered"],
  partially_delivered: ["delivered", "delivering", "cancelled"],
  cancelled: [],
};

/**
 * Move an order to a new stage: guard the transition, flow stock the stage
 * implies, patch the row, and append the audit event. Shared by `setStatus`
 * and by the full-page edit (`saveEdit`), so there is exactly ONE place that
 * knows what each stage does to stock.
 *
 * `deliveryFee` is passed in rather than read off `sale` because an edit can
 * change the fee in the same transaction — the "still charged" note has to
 * quote the fee the customer actually ends up owing.
 *
 * Callers must pass the sale doc as it was BEFORE any order-field patch in
 * this transaction: only `status`, `code` and `deliveredAt` are read here,
 * and none of those are touched by a field edit.
 */
async function transitionSaleStatus(
  ctx: { db: MutationCtx["db"] },
  sale: Doc<"sales">,
  staff: Doc<"users">,
  target: Doc<"sales">["status"],
  opts: { deliveryFee: number; chargeDeliveryFee?: boolean; note?: string },
  now: number
): Promise<void> {
  const allowed = ALLOWED_TRANSITIONS[sale.status] ?? [];
  if (!allowed.includes(target)) {
    throw new ConvexError({
      code: "INVALID_INPUT",
      message: `Can't move this order from ${sale.status} to ${target}.`,
    });
  }
  if (target === "cancelled") {
    // Flow every outstanding piece back to the shelf. Per-line cancels
    // (T13) do the same for single lines.
    await cancelOutstanding(ctx, sale, staff, `Cancelled ${sale.code}`, now);
  }
  // Only a cancel can bill the trip, and only when a fee was set on the
  // order — anything else is a client mistake, so it's ignored rather than
  // silently written onto the row.
  const chargeTrip =
    opts.chargeDeliveryFee === true && target === "cancelled" && opts.deliveryFee > 0;
  if (target === "delivered") {
    // "Delivered" means the customer took everything: fill every line's
    // delivered qty. Pieces previously cancelled came back to the shelf,
    // so they leave again (oversell-checked, same as checkout); lines
    // never adjusted had their pieces deducted at checkout already, so
    // filling them is bookkeeping only — no stock change.
    await fillAllDelivered(ctx, sale, staff, now);
  }

  const deliveredAt =
    target === "delivered" || target === "partially_delivered"
      ? (sale.deliveredAt ?? now)
      : sale.deliveredAt;
  const patch: Partial<Doc<"sales">> = { status: target };
  if (deliveredAt !== undefined) patch.deliveredAt = deliveredAt;
  if (chargeTrip) patch.chargeDeliveryOnCancel = true;
  await ctx.db.patch(sale._id, patch);
  await ctx.db.insert("saleEvents", {
    saleId: sale._id,
    type: "status_changed",
    summary: chargeTrip
      ? `Status ${sale.status} → ${target}. Shipping ${moneyStr(opts.deliveryFee)} still charged.`
      : `Status ${sale.status} → ${target}.`,
    payload: {
      from: sale.status,
      to: target,
      ...(opts.note?.trim() ? { note: opts.note.trim() } : {}),
    },
    userId: staff._id,
    ts: now,
  });
}

export const setStatus = mutation({
  args: {
    saleId: v.id("sales"),
    status: saleStatus,
    note: v.optional(v.string()),
    // Cancelling only: the package went out and the trip happened, so the
    // customer still pays shipping even though the goods came back.
    chargeDeliveryFee: v.optional(v.boolean()),
  },
  returns: saleDetail,
  handler: async (ctx, args) => {
    const { staff } = await requireUser(ctx);
    const sale = await ctx.db.get(args.saleId);
    if (!sale) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Order not found." });
    }
    if (args.status === sale.status) return await buildDetail(ctx, sale);
    await transitionSaleStatus(
      ctx,
      sale,
      staff,
      args.status,
      {
        deliveryFee: sale.deliveryFee,
        chargeDeliveryFee: args.chargeDeliveryFee,
        note: args.note,
      },
      Date.now()
    );
    return await buildDetail(ctx, (await ctx.db.get(sale._id))!);
  },
});

/** One order-level field that changed, resolved before the patch so the
 * audit event can show the true before → after. */
type OrderFieldChange = { field: string; label: string; from: string; to: string };

/** The order-level fields an edit may set. undefined = keep, null = clear. */
type OrderFieldArgs = {
  customerId?: Id<"customers">;
  salesChannelId?: Id<"salesChannels">;
  deliveryCompanyId?: Id<"deliveryCompanies"> | null;
  deliveryFee?: number | null;
  deliveryCost?: number | null;
  discount?: number;
  note?: string | null;
};

/**
 * Validate and resolve the order-level fields of an edit, returning the patch
 * to apply and the list of changes to log. Writes nothing — `saveEdit` decides
 * when to commit, which is what lets it validate everything before it touches
 * a single row.
 *
 * `subtotal` is the POST-edit item subtotal the order discount has to fit
 * under: the discount has to fit the order you end up with, not the one you
 * started from.
 *
 * `alwaysCheckDiscount` is true from `saveEdit` because an edit can shrink the
 * subtotal itself (a lowered quantity or a removed line), so the discount must
 * be re-checked against the new subtotal on every save.
 */
async function planOrderFields(
  ctx: { db: MutationCtx["db"] },
  sale: Doc<"sales">,
  shop: Doc<"shop">,
  args: OrderFieldArgs,
  opts: { subtotal: number; alwaysCheckDiscount: boolean }
): Promise<{
  patch: Partial<Doc<"sales">>;
  changes: OrderFieldChange[];
  deliveryFee: number;
}> {
  // Referenced rows must exist (no active check — past orders of
  // deactivated customers / pages stay editable).
  if (args.customerId !== undefined) {
    const customer = await ctx.db.get(args.customerId);
    if (!customer) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Customer not found." });
    }
  }
  if (args.salesChannelId !== undefined) {
    const channel = await ctx.db.get(args.salesChannelId);
    if (!channel) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Sales page not found." });
    }
  }
  const companySet =
    args.deliveryCompanyId !== undefined && args.deliveryCompanyId !== null;
  const companyDoc = companySet ? await ctx.db.get(args.deliveryCompanyId!) : null;
  if (companySet && !companyDoc) {
    throw new ConvexError({
      code: "NOT_FOUND",
      message: "Delivery company not found.",
    });
  }

  // Delivery module off → no company, no fees (checkout forces them to
  // zero); editing delivery fields while it's off is a mistake.
  if (
    !shop.deliveryEnabled &&
    (args.deliveryCompanyId !== undefined ||
      args.deliveryFee !== undefined ||
      args.deliveryCost !== undefined)
  ) {
    throw new ConvexError({
      code: "INVALID_INPUT",
      message: "Delivery is turned off in shop settings.",
    });
  }

  // Money: provided values are asserted (undefined = keep, null = clear).
  if (typeof args.deliveryFee === "number") {
    const fee = assertCents(args.deliveryFee, "delivery fee");
    if (fee < 0) {
      throw new ConvexError({
        code: "INVALID_MONEY",
        message: "Delivery fees can't be negative.",
      });
    }
  }
  if (typeof args.deliveryCost === "number") {
    const cost = assertCents(args.deliveryCost, "delivery cost");
    if (cost < 0) {
      throw new ConvexError({
        code: "INVALID_MONEY",
        message: "Delivery fees can't be negative.",
      });
    }
  }
  let discount: number | undefined;
  if (args.discount !== undefined) {
    discount = assertCents(args.discount, "discount");
    if (discount < 0) {
      throw new ConvexError({
        code: "INVALID_MONEY",
        message: "Order discount is out of range.",
      });
    }
    // Discount must fit under the item subtotal (see the doc comment for
    // why `alwaysCheckDiscount` exists).
    if (opts.alwaysCheckDiscount || discount !== sale.discount) {
      if (discount > opts.subtotal) {
        throw new ConvexError({
          code: "INVALID_MONEY",
          message: "Order discount is out of range.",
        });
      }
    }
  }

  // Effective values (undefined = keep, null = clear). Fees default to the
  // company's default fee when a company is (re)set and no explicit amount
  // was sent — same as checkout; clearing the company clears its fees.
  const deliveryCompanyId: Id<"deliveryCompanies"> | undefined =
    args.deliveryCompanyId === undefined
      ? sale.deliveryCompanyId
      : args.deliveryCompanyId === null
        ? undefined
        : args.deliveryCompanyId;
  let deliveryFee: number;
  if (args.deliveryFee === null) deliveryFee = 0;
  else if (args.deliveryFee !== undefined) deliveryFee = args.deliveryFee;
  else if (args.deliveryCompanyId === undefined) deliveryFee = sale.deliveryFee;
  else if (args.deliveryCompanyId === null) deliveryFee = 0;
  else deliveryFee = companyDoc!.defaultFee;
  let deliveryCost: number;
  if (args.deliveryCost === null) deliveryCost = 0;
  else if (args.deliveryCost !== undefined) deliveryCost = args.deliveryCost;
  else if (args.deliveryCompanyId === undefined) deliveryCost = sale.deliveryCost;
  else if (args.deliveryCompanyId === null) deliveryCost = 0;
  else deliveryCost = companyDoc!.defaultFee;
  let note = sale.note;
  if (args.note !== undefined) {
    note =
      args.note === null ? undefined : args.note.trim().slice(0, 500) || undefined;
  }

  // Collect the actual changes (old/new values resolved BEFORE the patch so
  // the audit events show the true before/after).
  const patch: Partial<Doc<"sales">> = {};
  const changes: { field: string; label: string; from: string; to: string }[] = [];
  if (args.customerId !== undefined && args.customerId !== sale.customerId) {
    const oldDoc = await ctx.db.get(sale.customerId);
    const newDoc = await ctx.db.get(args.customerId);
    patch.customerId = args.customerId;
    changes.push({
      field: "customer",
      label: "Customer",
      from: oldDoc?.name ?? "—",
      to: newDoc?.name ?? "—",
    });
  }
  if (
    args.salesChannelId !== undefined &&
    args.salesChannelId !== sale.salesChannelId
  ) {
    const oldDoc = await ctx.db.get(sale.salesChannelId);
    const newDoc = await ctx.db.get(args.salesChannelId);
    patch.salesChannelId = args.salesChannelId;
    changes.push({
      field: "channel",
      label: "Sales page",
      from: oldDoc?.name ?? "—",
      to: newDoc?.name ?? "—",
    });
  }
  if (deliveryCompanyId !== sale.deliveryCompanyId) {
    patch.deliveryCompanyId = deliveryCompanyId;
    const oldCompany = sale.deliveryCompanyId
      ? await ctx.db.get(sale.deliveryCompanyId)
      : null;
    const newCompany = deliveryCompanyId ? await ctx.db.get(deliveryCompanyId) : null;
    changes.push({
      field: "deliveryCompany",
      label: "Delivery company",
      from: oldCompany?.name ?? "Self / pickup",
      to: newCompany?.name ?? "Self / pickup",
    });
  }
  if (deliveryFee !== sale.deliveryFee) {
    patch.deliveryFee = deliveryFee;
    changes.push({
      field: "deliveryFee",
      label: "Delivery fee",
      from: moneyStr(sale.deliveryFee),
      to: moneyStr(deliveryFee),
    });
  }
  if (deliveryCost !== sale.deliveryCost) {
    patch.deliveryCost = deliveryCost;
    changes.push({
      field: "deliveryCost",
      label: "Delivery cost",
      from: moneyStr(sale.deliveryCost),
      to: moneyStr(deliveryCost),
    });
  }
  if (discount !== undefined && discount !== sale.discount) {
    patch.discount = discount;
    changes.push({
      field: "discount",
      label: "Discount",
      from: moneyStr(sale.discount),
      to: moneyStr(discount),
    });
  }
  if (note !== sale.note) {
    patch.note = note;
    changes.push({
      field: "note",
      label: "Note",
      from: sale.note ?? "",
      to: note ?? "",
    });
  }

  return { patch, changes, deliveryFee };
}

/** Write the audit row for each order-level field an edit changed (rule #8):
 * nothing on an order is ever silently edited. */
async function logOrderFieldChanges(
  ctx: { db: MutationCtx["db"] },
  sale: Doc<"sales">,
  staff: Doc<"users">,
  changes: OrderFieldChange[],
  now: number
): Promise<void> {
  for (const change of changes) {
    await ctx.db.insert("saleEvents", {
      saleId: sale._id,
      type: "sale_edited",
      summary: `Order ${sale.code} edited — ${change.label}: ${change.from} → ${change.to}.`,
      payload: { field: change.field, from: change.from, to: change.to },
      userId: staff._id,
      ts: now,
    });
  }
}

// T12 — the full-page "Edit Sale" screen saves the WHOLE order in one go:
// line quantities, prices and discounts, the order-level fields, and the
// status, all in ONE transaction. Nothing is applied while the user types —
// the page sends the order it wants and this works out the difference.
//
// Why a desired end state instead of a list of commands: Convex retries the
// loser of a concurrent stock write, and a retry re-measures the difference
// against the rows as they are then. So a retry can never double-deduct, and
// re-sending an already-applied save is a no-op.
//
// Lines the client doesn't send are left alone — a dropped row can never
// silently cancel stock. A line sent with qty 0 is removed: the row survives
// (rule #10, nothing with history is deleted), its pieces are cancelled and
// flow back to the shelf.
//
// An existing line may also send a different `variantId` to sell another
// item (size exchange before delivery, changed item): the old billed pieces
// flow back (exchange_out) and the new billed qty leaves the shelf
// (exchange_in, oversell-checked) — allowed only while nothing on the line
// was delivered yet; pieces already in the customer's hands belong to the
// return flow.
//
// `expectedVersion` (from getEditData) guards concurrent edits: every save
// bumps the order's editedVersion, and a save whose version no longer
// matches is rejected — nobody silently overwrites somebody else's work.
export const saveEdit = mutation({
  args: {
    saleId: v.id("sales"),
    items: v.array(saleEditItemInput),
    expectedVersion: v.optional(v.number()),
    customerId: v.optional(v.id("customers")),
    salesChannelId: v.optional(v.id("salesChannels")),
    deliveryCompanyId: v.optional(v.union(v.id("deliveryCompanies"), v.null())),
    deliveryFee: v.optional(v.union(v.number(), v.null())),
    deliveryCost: v.optional(v.union(v.number(), v.null())),
    discount: v.optional(v.number()),
    note: v.optional(v.union(v.string(), v.null())),
    status: v.optional(saleStatus),
    chargeDeliveryFee: v.optional(v.boolean()),
  },
  returns: saleDetail,
  handler: async (ctx, args) => {
    const { staff } = await requireUser(ctx);
    const shop = await getShop(ctx);
    const sale = await ctx.db.get(args.saleId);
    if (!sale) throw notFoundSale();
    if (sale.status === "draft" || sale.status === "cancelled") throw lockedSale();
    // Stale-edit guard: the page saves the version it loaded; a concurrent
    // save (another tab, another staff member) already bumped the counter,
    // so this one refuses instead of overwriting their work. Omitted = skip
    // (older clients).
    if (
      args.expectedVersion !== undefined &&
      (sale.editedVersion ?? 0) !== args.expectedVersion
    ) {
      throw new ConvexError({
        code: "STALE_EDIT",
        message: "This order changed in another window. Reload and try again.",
      });
    }
    if (args.items.length > LINES_MAX) {
      throw new ConvexError({
        code: "INVALID_INPUT",
        message: "Too many lines on one order.",
      });
    }

    // ---- Phase 1: work everything out and check it. Nothing is written
    // here, so any rejection below leaves the order exactly as it was. ----

    type LinePlan =
      | {
          kind: "existing";
          item: Doc<"saleItems">;
          // The variant the line sells AFTER the edit — its original one, or
          // the swap target when the entry sends a different variantId.
          variant: Doc<"productVariants"> | null;
          product: Doc<"products"> | null;
          // What the line sold BEFORE the edit (the swap's exchange_out rows
          // and its from → to audit event need the original item).
          fromVariant: Doc<"productVariants"> | null;
          fromProduct: Doc<"products"> | null;
          swapped: boolean;
          billedOld: number;
          qty: number;
          deltaBilled: number;
          price: number;
          discount: number;
        }
      | {
          kind: "new";
          variant: Doc<"productVariants">;
          product: Doc<"products">;
          qty: number;
          price: number;
          discount: number;
        };

    const plans: LinePlan[] = [];
    const seenLines = new Set<string>();

    for (const entry of args.items) {
      if (entry.saleItemId !== undefined) {
        const item = await ctx.db.get(entry.saleItemId);
        if (!item || item.saleId !== sale._id) throw lineNotInSale();
        if (seenLines.has(item._id)) throw duplicateLine();
        seenLines.add(item._id);
        const fromVariant = await ctx.db.get(item.variantId);
        const fromProduct = fromVariant
          ? await ctx.db.get(fromVariant.productId)
          : null;
        // A different variantId on an existing line = this line now sells
        // that item (the T14 exchange flow, now an edit). Only while nothing
        // was delivered: pieces already in the customer's hands are the
        // return flow's to move, never a silent re-label.
        const swapped =
          entry.variantId !== undefined && entry.variantId !== item.variantId;
        let variant = fromVariant;
        let product = fromProduct;
        if (swapped) {
          if (item.qtyDelivered - item.qtyReturned > 0) {
            throw new ConvexError({
              code: "INVALID_INPUT",
              message:
                "Pieces were already delivered — return them first, then add the right item.",
            });
          }
          variant = await ctx.db.get(entry.variantId!);
          product = variant ? await ctx.db.get(variant.productId) : null;
          if (!variant || !variant.active || !product || !product.active) {
            throw new ConvexError({ code: "NOT_FOUND", message: "Item not found." });
          }
        }
        const billedOld = item.qtyOrdered - item.qtyCancelled - item.qtyReturned;
        const qty = assertQty(entry.qty, 0, "qty");
        // Pieces currently with the customer were charged AND already left
        // the shelf. Taking them off the bill belongs to the return flow,
        // which gives the money back and writes `return` rows — cancelling
        // them here would drop the charge and leave the goods out there.
        // Returned pieces are not held, so a line may go below its historical
        // delivered count (down to delivered − returned).
        if (qty < item.qtyDelivered - item.qtyReturned) {
          throw new ConvexError({
            code: "INVALID_QTY",
            message:
              "Can't go below the quantity the customer has — return those pieces instead.",
          });
        }
        const price =
          entry.price === undefined
            ? swapped
              ? assertCents(variant!.price ?? product!.defaultPrice, "price")
              : item.unitPrice
            : nonNegativeCents(entry.price, "price", "Price can't be negative.");
        const discount =
          entry.discount === undefined
            ? (item.discount ?? 0)
            : entry.discount === null
              ? 0
              : nonNegativeCents(
                  entry.discount,
                  "item discount",
                  "Item discount is out of range."
                );
        if (discount > price * qty) throw itemDiscountOutOfRange();
        plans.push({
          kind: "existing",
          item,
          variant,
          product,
          fromVariant,
          fromProduct,
          swapped,
          billedOld,
          qty,
          deltaBilled: qty - billedOld,
          price,
          discount,
        });
      } else {
        if (entry.variantId === undefined) {
          throw new ConvexError({
            code: "INVALID_INPUT",
            message: "Pick an item for the new line.",
          });
        }
        const variant = await ctx.db.get(entry.variantId);
        const product = variant ? await ctx.db.get(variant.productId) : null;
        if (!variant || !variant.active || !product || !product.active) {
          throw new ConvexError({ code: "NOT_FOUND", message: "Item not found." });
        }
        const qty = assertQty(entry.qty, 1, "qty");
        // Price is re-derived from the variant/product unless the user typed
        // one — the client never gets to invent a default.
        const price =
          entry.price === undefined
            ? assertCents(variant.price ?? product.defaultPrice, "price")
            : nonNegativeCents(entry.price, "price", "Price can't be negative.");
        const discount =
          entry.discount === undefined || entry.discount === null
            ? 0
            : nonNegativeCents(
                entry.discount,
                "item discount",
                "Item discount is out of range."
              );
        if (discount > price * qty) throw itemDiscountOutOfRange();
        plans.push({ kind: "new", variant, product, qty, price, discount });
      }
    }

    // Invariant 4: a DELIVERED order is finished — every line has its final
    // outcome, so the line set is locked. Adding a line, changing a billed
    // quantity or swapping an item would leave lines with no outcome on a
    // "delivered" order. Returns, exchanges and door adjustments have their
    // own flows (returnItems / setLineDelivered); order-level field edits
    // (fees, customer, channel, prices, discounts) stay allowed here.
    if (sale.status === "delivered") {
      const structural = plans.some(
        (p) => p.kind === "new" || p.swapped || p.deltaBilled !== 0
      );
      if (structural) {
        throw new ConvexError({
          code: "DELIVERED_LOCKED_LINES",
          message:
            "This order is delivered — item changes go through the return and exchange flows.",
        });
      }
    }

    const allItems = await ctx.db
      .query("saleItems")
      .withIndex("by_sale", (q) => q.eq("saleId", sale._id))
      .collect();
    const plannedByItem = new Map<string, Extract<LinePlan, { kind: "existing" }>>();
    for (const plan of plans) {
      if (plan.kind === "existing") plannedByItem.set(plan.item._id, plan);
    }

    // Only the NET outflow per variant has to be on the shelf: dropping 3
    // pieces off one line pays for adding 3 to another in the same save.
    // Measured against the pre-write ledger, so "stock ≥ net" here is exactly
    // "the ledger never goes negative" after the writes below. A swapped
    // line moves its whole billed qty: the old variant gets every old piece
    // back, the new variant sends the new billed qty out. (The same variant
    // is deliberately allowed on several lines — the POS keeps repeat lines
    // separate, and the edit page may too.)
    const netByVariant = new Map<Id<"productVariants">, number>();
    for (const plan of plans) {
      if (plan.kind === "new") {
        netByVariant.set(
          plan.variant._id,
          (netByVariant.get(plan.variant._id) ?? 0) + plan.qty
        );
      } else if (plan.swapped) {
        netByVariant.set(
          plan.item.variantId,
          (netByVariant.get(plan.item.variantId) ?? 0) - plan.billedOld
        );
        netByVariant.set(
          plan.variant!._id,
          (netByVariant.get(plan.variant!._id) ?? 0) + plan.qty
        );
      } else {
        netByVariant.set(
          plan.item.variantId,
          (netByVariant.get(plan.item.variantId) ?? 0) + plan.deltaBilled
        );
      }
    }
    await assertStockCovers(ctx, netByVariant);

    // The order discount has to fit the order we're about to END UP with,
    // so the subtotal is measured across the planned lines plus the untouched
    // ones — never the pre-edit figure.
    let subtotal = 0;
    for (const item of allItems) {
      const plan = plannedByItem.get(item._id);
      subtotal += plan ? plan.price * plan.qty - plan.discount : lineValue(item);
    }
    for (const plan of plans) {
      if (plan.kind === "new") subtotal += plan.price * plan.qty - plan.discount;
    }

    const { patch: salePatch, changes, deliveryFee } = await planOrderFields(
      ctx,
      sale,
      shop,
      args,
      { subtotal, alwaysCheckDiscount: true }
    );

    // ---- Phase 2: apply. This is the same transaction as the checks above,
    // so if anything below throws, every write here rolls back with it. ----

    const now = Date.now();

    for (const plan of plans) {
      if (plan.kind === "new") {
        const label = variantLabel(plan.product, plan.variant);
        const unitCostSnapshot = await weightedAvgCost(
          ctx,
          plan.variant._id,
          plan.variant,
          plan.product
        );
        const itemId = await ctx.db.insert("saleItems", {
          saleId: sale._id,
          variantId: plan.variant._id,
          unitPrice: plan.price,
          unitCostSnapshot,
          qtyOrdered: plan.qty,
          qtyDelivered: 0,
          qtyCancelled: 0,
          qtyReturned: 0,
          ...(plan.discount > 0 ? { discount: plan.discount } : {}),
        });
        await ctx.db.insert("stockLedger", {
          variantId: plan.variant._id,
          delta: -plan.qty,
          reason: "sale",
          saleItemId: itemId,
          userId: staff._id,
          ts: now,
          note: `Sale ${sale.code}`,
        });
        await ctx.db.insert("saleEvents", {
          saleId: sale._id,
          type: "item_added",
          summary: `Added ${label} ×${plan.qty}.`,
          payload: { item: label, qty: String(plan.qty) },
          userId: staff._id,
          ts: now,
        });
        continue;
      }

      const { item } = plan;
      const label = variantLabel(plan.product, plan.variant);
      const itemPatch: Partial<Doc<"saleItems">> = {};

      if (plan.swapped) {
        // The whole line moves to the new item: the old billed pieces flow
        // back (exchange_out) and the new billed qty leaves the shelf
        // (exchange_in, oversell-checked above). The qty change is folded
        // into this pair — a swapped line never also writes sale/cancel
        // rows, so nothing can double-move. Zero quantities write nothing.
        const fromLabel = variantLabel(plan.fromProduct, plan.fromVariant);
        if (plan.billedOld > 0) {
          await ctx.db.insert("stockLedger", {
            variantId: item.variantId,
            delta: plan.billedOld,
            reason: "exchange_out",
            saleItemId: item._id,
            userId: staff._id,
            ts: now,
            note: `Swap from ${sale.code}`,
          });
        }
        if (plan.qty > 0) {
          await ctx.db.insert("stockLedger", {
            variantId: plan.variant!._id,
            delta: -plan.qty,
            reason: "exchange_in",
            saleItemId: item._id,
            userId: staff._id,
            ts: now,
            note: `Swap to ${sale.code}`,
          });
        }
        // The line re-prices and re-costs from the new item (rule #3: the
        // cost snapshot moves to the new variant's average — the price
        // change event below audits it).
        itemPatch.variantId = plan.variant!._id;
        itemPatch.unitCostSnapshot = await weightedAvgCost(
          ctx,
          plan.variant!._id,
          plan.variant!,
          plan.product!
        );
        if (plan.qty > 0) {
          await ctx.db.insert("saleEvents", {
            saleId: sale._id,
            type: "item_swapped",
            summary: `Swapped ${fromLabel} → ${label} (${plan.qty}).`,
            payload: {
              from: fromLabel,
              to: label,
              qty: String(plan.qty),
            },
            userId: staff._id,
            ts: now,
          });
        }
      } else if (plan.deltaBilled > 0) {
        // More pieces leave the shelf. qtyOrdered grows rather than
        // qtyCancelled shrinking — un-cancelling would rewrite what the
        // ledger already says happened.
        itemPatch.qtyOrdered = item.qtyOrdered + plan.deltaBilled;
        await ctx.db.insert("stockLedger", {
          variantId: item.variantId,
          delta: -plan.deltaBilled,
          reason: "sale",
          saleItemId: item._id,
          userId: staff._id,
          ts: now,
          note: `Sale ${sale.code}`,
        });
      } else if (plan.deltaBilled < 0) {
        // Fewer pieces: the difference is cancelled and goes back on the
        // shelf, the same move `removeItem` makes for a whole line.
        const back = -plan.deltaBilled;
        itemPatch.qtyCancelled = item.qtyCancelled + back;
        await ctx.db.insert("stockLedger", {
          variantId: item.variantId,
          delta: back,
          reason: "cancel",
          saleItemId: item._id,
          userId: staff._id,
          ts: now,
          note: plan.qty === 0 ? `Removed — ${sale.code}` : `Removed ${back} — ${sale.code}`,
        });
      }

      if (plan.deltaBilled !== 0) {
        const removed = plan.qty === 0;
        const readded = plan.billedOld === 0;
        await ctx.db.insert("saleEvents", {
          saleId: sale._id,
          type: removed ? "item_removed" : readded ? "item_added" : "item_qty_changed",
          summary: removed
            ? `Removed ${label} (${-plan.deltaBilled}).`
            : readded
              ? `Added ${label} ×${plan.qty}.`
              : `Quantity ${label}: ${plan.billedOld} → ${plan.qty}.`,
          payload:
            removed || readded
              ? { item: label, qty: String(Math.abs(plan.deltaBilled)) }
              : { item: label, from: String(plan.billedOld), to: String(plan.qty) },
          userId: staff._id,
          ts: now,
        });
      }

      if (plan.price !== item.unitPrice) {
        itemPatch.unitPrice = plan.price;
        await ctx.db.insert("saleEvents", {
          saleId: sale._id,
          type: "sale_edited",
          summary: `Order ${sale.code} edited — ${label} price: ${moneyStr(item.unitPrice)} → ${moneyStr(plan.price)}.`,
          payload: {
            field: "price",
            item: label,
            from: moneyStr(item.unitPrice),
            to: moneyStr(plan.price),
          },
          userId: staff._id,
          ts: now,
        });
      }

      const discountOld = item.discount ?? 0;
      if (plan.discount !== discountOld) {
        // Convex drops a field patched to undefined, so a cleared discount
        // leaves no zero behind.
        itemPatch.discount = plan.discount > 0 ? plan.discount : undefined;
        await ctx.db.insert("saleEvents", {
          saleId: sale._id,
          type: "sale_edited",
          summary: `Order ${sale.code} edited — ${label} discount: ${moneyStr(discountOld)} → ${moneyStr(plan.discount)}.`,
          payload: {
            field: "itemDiscount",
            item: label,
            from: moneyStr(discountOld),
            to: moneyStr(plan.discount),
          },
          userId: staff._id,
          ts: now,
        });
      }

      if (Object.keys(itemPatch).length > 0) await ctx.db.patch(item._id, itemPatch);
    }

    // Every save bumps the order's edit counter (the stale-edit guard reads
    // it) — even a no-op save, so a later save from a stale window is told
    // to reload instead of overwriting anything.
    salePatch.editedVersion = (sale.editedVersion ?? 0) + 1;
    await ctx.db.patch(sale._id, salePatch);
    if (changes.length > 0) {
      await logOrderFieldChanges(ctx, sale, staff, changes, now);
    }

    // Status LAST: cancelling has to flow back whatever the line edits left
    // outstanding, and "delivered" has to fill the quantities they ended at.
    // `sale` is deliberately the pre-patch doc — the transition only reads
    // status / code / deliveredAt, none of which a field edit touches.
    if (args.status !== undefined && args.status !== sale.status) {
      await transitionSaleStatus(
        ctx,
        sale,
        staff,
        args.status,
        { deliveryFee, chargeDeliveryFee: args.chargeDeliveryFee },
        now
      );
    }

    return await buildDetail(ctx, (await ctx.db.get(sale._id))!);
  },
});

/** "Basic Tee — M · Black" — the plain-language label for a line, used in
 * events and summaries. Shared with the T17 delivery screen. */
export function variantLabel(
  product: Doc<"products"> | null,
  variant: Doc<"productVariants"> | null
): string {
  if (!variant) return "—";
  const size = variant.size;
  const color = variant.color ? ` · ${variant.color}` : "";
  return `${product?.name ?? "Item"} — ${size}${color}`;
}

const notFoundSale = () =>
  new ConvexError({ code: "NOT_FOUND", message: "Order not found." });

const lockedSale = () =>
  new ConvexError({
    code: "INVALID_INPUT",
    message: "This order can't be changed anymore.",
  });

const lineNotInSale = () =>
  new ConvexError({ code: "NOT_FOUND", message: "Line not found on this order." });

const duplicateLine = () =>
  new ConvexError({
    code: "INVALID_INPUT",
    message: "The same line was sent twice.",
  });

const itemDiscountOutOfRange = () =>
  new ConvexError({
    code: "INVALID_MONEY",
    message: "Item discount is out of range.",
  });

/** Money that may not be negative: assertCents plus a sign check. */
function nonNegativeCents(value: number, label: string, message: string): number {
  const cents = assertCents(value, label);
  if (cents < 0) throw new ConvexError({ code: "INVALID_MONEY", message });
  return cents;
}

/** Flow every outstanding piece back to the shelf (cancel ledger rows) —
 * used by order cancellation and by the T17 "returned" / "cancelled"
 * delivery outcomes. */
export async function cancelOutstanding(
  ctx: { db: MutationCtx["db"] },
  sale: Doc<"sales">,
  staff: Doc<"users">,
  note: string,
  now: number
): Promise<void> {
  const items = await ctx.db
    .query("saleItems")
    .withIndex("by_sale", (q) => q.eq("saleId", sale._id))
    .collect();
  for (const item of items) {
    const outstanding =
      item.qtyOrdered - item.qtyDelivered - item.qtyCancelled - item.qtyReturned;
    if (outstanding <= 0) continue;
    await ctx.db.insert("stockLedger", {
      variantId: item.variantId,
      delta: outstanding,
      reason: "cancel",
      saleItemId: item._id,
      userId: staff._id,
      ts: now,
      note,
    });
    await ctx.db.patch(item._id, {
      qtyCancelled: item.qtyCancelled + outstanding,
    });
  }
}

/** Fill every line's delivered qty ("the customer took everything"). Pieces
 * previously cancelled came back to the shelf, so they leave again
 * (oversell-checked, same as checkout); never-adjusted lines had their
 * pieces deducted at checkout already — filling them is bookkeeping only. */
export async function fillAllDelivered(
  ctx: { db: MutationCtx["db"] },
  sale: Doc<"sales">,
  staff: Doc<"users">,
  now: number
): Promise<void> {
  const items = await ctx.db
    .query("saleItems")
    .withIndex("by_sale", (q) => q.eq("saleId", sale._id))
    .collect();
  for (const item of items) {
    if (item.qtyCancelled > 0) {
      const stock = await variantQty(ctx, item.variantId);
      if (stock < item.qtyCancelled) {
        throw new ConvexError({
          code: "OUT_OF_STOCK",
          message: "Cancelled pieces were sold to someone else in the meantime.",
        });
      }
      await ctx.db.insert("stockLedger", {
        variantId: item.variantId,
        delta: -item.qtyCancelled,
        reason: "sale",
        saleItemId: item._id,
        userId: staff._id,
        ts: now,
        note: `Sale ${sale.code}`,
      });
    }
    await ctx.db.patch(item._id, {
      // Delivered is HISTORICAL and only ever grows: max() keeps a piece
      // that was delivered before a return recorded as delivered (a returned
      // piece was still handed over). "With the customer" is the derived
      // difference qtyDelivered − qtyReturned, never stored here.
      qtyDelivered: Math.max(item.qtyDelivered, item.qtyOrdered),
      qtyCancelled: 0,
    });
  }
}

/** Per-line delivered quantities ("adjust at the door") with ledger rows and
 * a lines_adjusted event per changed line — shared by T13 and the T17
 * "partial" outcome. */
export async function applyDeliveredAdjustments(
  ctx: { db: MutationCtx["db"] },
  sale: Doc<"sales">,
  staff: Doc<"users">,
  adjustments: { saleItemId: Id<"saleItems">; qtyDelivered: number }[],
  now: number
): Promise<void> {
  for (const adj of adjustments) {
    const item = await ctx.db.get(adj.saleItemId);
    if (!item || item.saleId !== sale._id) throw lineNotInSale();
    // Delivered is HISTORICAL — returned pieces were handed over once and
    // still count in it, so the ceiling is the full ordered qty, not
    // ordered − returned (the old conflation blocked re-delivering a line
    // after a partial return).
    const maxDelivered = item.qtyOrdered;
    const qty = assertQty(adj.qtyDelivered, 0, "delivered qty");
    if (qty > maxDelivered) {
      throw new ConvexError({
        code: "INVALID_QTY",
        message: "Delivered can't be more than ordered.",
      });
    }
    // Delivered is historical and returned pieces were handed over once, so
    // it can never be marked below what was returned (invariant 1).
    if (qty < item.qtyReturned) {
      throw new ConvexError({
        code: "DELIVERED_BELOW_RETURNED",
        message: "Can't mark fewer delivered than were returned.",
      });
    }
    if (qty === item.qtyDelivered) continue;
    // Pieces are deducted at checkout; after that, the line's net stock
    // effect is −(ordered − cancelled − returned). Adjusting delivered
    // changes the cancelled qty, and stock moves by exactly that change:
    // pieces that stop being cancelled leave the shelf again, pieces that
    // become cancelled flow back. (The old sign-of-delta rule re-deducted a
    // fresh line raised from 0 — the taken piece was already deducted at
    // checkout, so the not-taken piece never came back.)
    // Returned pieces live INSIDE delivered (invariant 1), so what was never
    // handed over is ordered − delivered — subtracting returned again would
    // leave returned pieces counted as out of stock and drift the ledger.
    const cancelledNew = item.qtyOrdered - qty;
    const ledgerDelta = cancelledNew - item.qtyCancelled;
    if (ledgerDelta > 0) {
      // Pieces come back to the shelf.
      await ctx.db.insert("stockLedger", {
        variantId: item.variantId,
        delta: ledgerDelta,
        reason: "cancel",
        saleItemId: item._id,
        userId: staff._id,
        ts: now,
        note: `Not taken — ${sale.code}`,
      });
    } else if (ledgerDelta < 0) {
      // Pieces leave again — oversell is impossible.
      const stock = await variantQty(ctx, item.variantId);
      if (stock < -ledgerDelta) {
        throw new ConvexError({
          code: "OUT_OF_STOCK",
          message: "Not enough stock to mark these delivered.",
        });
      }
      await ctx.db.insert("stockLedger", {
        variantId: item.variantId,
        delta: ledgerDelta,
        reason: "sale",
        saleItemId: item._id,
        userId: staff._id,
        ts: now,
        note: `Sale ${sale.code}`,
      });
    }
    await ctx.db.patch(item._id, {
      qtyDelivered: qty,
      qtyCancelled: cancelledNew,
    });
    const variant = await ctx.db.get(item.variantId);
    const product = variant ? await ctx.db.get(variant.productId) : null;
    const label = variantLabel(product, variant);
    await ctx.db.insert("saleEvents", {
      saleId: sale._id,
      type: "lines_adjusted",
      summary: `Delivered ${label}: ${item.qtyDelivered} → ${qty}.`,
      payload: {
        item: label,
        from: String(item.qtyDelivered),
        to: String(qty),
      },
      userId: staff._id,
      ts: now,
    });
  }
}

// T13 — per-line delivered quantities ("adjust at the door"). The owner
// records how many pieces the customer actually took; the rest is cancelled
// and flows back to the shelf. Raising delivered re-deducts stock
// (oversell-checked). Every change writes ledger rows + an event — the line
// fields are never silently edited (rule #4).
export const setLineDelivered = mutation({
  args: {
    saleId: v.id("sales"),
    adjustments: v.array(
      v.object({
        saleItemId: v.id("saleItems"),
        qtyDelivered: v.number(),
      })
    ),
  },
  returns: saleDetail,
  handler: async (ctx, args) => {
    const { staff } = await requireUser(ctx);
    const sale = await ctx.db.get(args.saleId);
    if (!sale) throw notFoundSale();
    if (sale.status === "draft" || sale.status === "cancelled") throw lockedSale();
    if (args.adjustments.length === 0) return await buildDetail(ctx, sale);
    const now = Date.now();
    await applyDeliveredAdjustments(ctx, sale, staff, args.adjustments, now);
    return await buildDetail(ctx, (await ctx.db.get(sale._id))!);
  },
});

// T15 — sale returns. The customer brings pieces back: stock flows back via
// `return` ledger rows. `qtyDelivered` is HISTORICAL — it counts every piece
// that was ever handed over and is never decremented. `qtyReturned` counts
// what came back, so the pieces currently with the customer are always the
// derived difference qtyDelivered − qtyReturned (0 ≤ qtyReturned ≤
// qtyDelivered holds by construction). A returned piece can never be
// "un-delivered" again for a second stock credit. Giving money back is a
// separate refund row (payments.ts) — returning pieces and refunding are two
// deliberate steps. Only pieces the customer actually holds can come back.
export const returnItems = mutation({
  args: {
    saleId: v.id("sales"),
    returns: v.array(
      v.object({ saleItemId: v.id("saleItems"), qty: v.number() })
    ),
  },
  returns: saleDetail,
  handler: async (ctx, args) => {
    const { staff } = await requireUser(ctx);
    const sale = await ctx.db.get(args.saleId);
    if (!sale) throw notFoundSale();
    if (sale.status === "draft" || sale.status === "cancelled") {
      throw lockedSale();
    }
    // Merge duplicate line entries server-side — the client sends intents,
    // the server decides what actually happens.
    const byLine = new Map<string, number>();
    for (const ret of args.returns) {
      byLine.set(ret.saleItemId, (byLine.get(ret.saleItemId) ?? 0) + ret.qty);
    }
    const now = Date.now();
    for (const [saleItemId, rawQty] of byLine) {
      const item = await ctx.db.get(saleItemId as Id<"saleItems">);
      if (!item || item.saleId !== sale._id) throw lineNotInSale();
      // The bound is what the customer CURRENTLY holds — the derived
      // qtyDelivered − qtyReturned — never the historical delivered count.
      const maxReturnable = item.qtyDelivered - item.qtyReturned;
      const qty = assertQty(rawQty, 1, "return qty");
      if (qty > maxReturnable) {
        throw new ConvexError({
          code: "RETURN_EXCEEDS_HELD",
          message: "Can't return more than the customer currently has.",
        });
      }
      await ctx.db.insert("stockLedger", {
        variantId: item.variantId,
        delta: qty,
        reason: "return",
        saleItemId: item._id,
        userId: staff._id,
        ts: now,
        note: `Returned — ${sale.code}`,
      });
      await ctx.db.patch(item._id, {
        qtyReturned: item.qtyReturned + qty,
      });
      const variant = await ctx.db.get(item.variantId);
      const product = variant ? await ctx.db.get(variant.productId) : null;
      const label = variantLabel(product, variant);
      await ctx.db.insert("saleEvents", {
        saleId: sale._id,
        type: "items_returned",
        summary: `Returned ${label} (${qty}).`,
        payload: { item: label, qty: String(qty) },
        userId: staff._id,
        ts: now,
      });
    }
    return await buildDetail(ctx, (await ctx.db.get(sale._id))!);
  },
});
