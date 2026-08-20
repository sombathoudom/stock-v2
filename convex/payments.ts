import { ConvexError, v } from "convex/values";

import { mutation } from "./_generated/server";
import { assertCents, dayString, getShop, moneyStr, requireUser } from "./helpers";
import { applyRefund, computeOwed, computePaid } from "./sales";
import { checkoutPaymentMethod, paymentDoc } from "./types";

// T11 — payments on existing orders (AGENTS.md rule #2). Money is recognized
// on the day it is RECEIVED, so every row stores receivedDay (shop timezone,
// indexed — daily reports never scan). A refund is a payment with a negative
// amount (method "refund") — money in and money out live in one table, so
// paid/remaining and daily totals can never drift. Every row appends a
// saleEvents entry for the audit trail (rule #8). All amounts are re-derived
// against the order server-side; the client sends ids + intents only.

const notFound = () =>
  new ConvexError({ code: "NOT_FOUND", message: "Order not found." });

const badAmount = (message: string) =>
  new ConvexError({ code: "INVALID_PAYMENT", message });

/**
 * Record money received for a sale (cash / bank transfer / other). Partial
 * payments are the norm — remaining is always order total − payments.
 * Cancelled orders never take money (money back is `refund`).
 */
export const receive = mutation({
  args: {
    saleId: v.id("sales"),
    amount: v.number(),
    method: checkoutPaymentMethod,
    note: v.optional(v.string()),
    receivedAt: v.optional(v.number()), // optional backdated payment date (epoch ms)
  },
  returns: paymentDoc,
  handler: async (ctx, args) => {
    const { staff } = await requireUser(ctx);
    const shop = await getShop(ctx);
    const sale = await ctx.db.get(args.saleId);
    if (!sale) throw notFound();
    const amount = assertCents(args.amount, "amount");
    if (amount <= 0) throw badAmount("Amount must be more than zero.");
    const owed = await computeOwed(ctx, sale);
    // A cancelled order normally owes nothing, so it takes no money. The
    // exception is the trip that was still charged when it was cancelled
    // (the package went out, the customer refused the goods): that shipping
    // fee is a real debt, so the payment goes through like any other.
    if (sale.status === "cancelled" && owed === 0) {
      throw new ConvexError({
        code: "INVALID_INPUT",
        message: "Cancelled orders don't take payments.",
      });
    }
    const paid = await computePaid(ctx, sale._id);
    const remaining = Math.max(0, owed - paid);
    // Overpay is CLAMPED, never rejected — same as checkout: the cashier may
    // receive more than what's still owed, and the change (entered − recorded)
    // goes back to the customer, so only the net kept is stored. Concurrent
    // receives are safe: Convex OCC retries re-compute `paid` in-transaction.
    const recorded = Math.min(amount, remaining);
    if (recorded <= 0) {
      throw badAmount("That's more than the order is still owed.");
    }
    // Optional backdated payment date (epoch ms, never the future) — same
    // validation as checkout. Money counts on the day it was actually
    // received, so the row's receivedDay derives from this moment, not now.
    const now = Date.now();
    let receivedAt = now;
    if (args.receivedAt !== undefined) {
      if (
        !Number.isFinite(args.receivedAt) ||
        args.receivedAt <= 0 ||
        args.receivedAt > now
      ) {
        throw new ConvexError({
          code: "INVALID_PAYMENT",
          message: "Payment date can't be in the future.",
        });
      }
      receivedAt = Math.floor(args.receivedAt);
    }
    const note = args.note?.trim() || undefined;
    const paymentId = await ctx.db.insert("payments", {
      saleId: sale._id,
      amount: recorded,
      receivedAt,
      receivedDay: dayString(receivedAt, shop.timezone),
      method: args.method,
      userId: staff._id,
      note,
    });
    await ctx.db.insert("saleEvents", {
      saleId: sale._id,
      type: "payment_received",
      summary: `Payment of ${moneyStr(recorded)} received.`,
      payload: {
        amount: String(recorded), // integer cents, like the refund event
        method: args.method,
        ...(note ? { note } : {}),
      },
      userId: staff._id,
      ts: now,
    });
    return (await ctx.db.get(paymentId))!;
  },
});

/**
 * Give money back to the customer: a payments row with a NEGATIVE amount
 * (method "refund") — paid/remaining and daily reports recompute themselves.
 * Can't refund more than has actually been paid. Thin wrapper over the
 * shared `applyRefund` engine (sales.ts) so saveEdit / setStatus refunds
 * write exactly the same row and event.
 */
export const refund = mutation({
  args: {
    saleId: v.id("sales"),
    amount: v.number(),
    note: v.optional(v.string()),
  },
  returns: paymentDoc,
  handler: async (ctx, args) => {
    const { staff } = await requireUser(ctx);
    const shop = await getShop(ctx);
    const sale = await ctx.db.get(args.saleId);
    if (!sale) throw notFound();
    const paymentId = await applyRefund(
      ctx,
      sale,
      staff,
      args.amount,
      args.note,
      shop.timezone,
      Date.now()
    );
    return (await ctx.db.get(paymentId))!;
  },
});
