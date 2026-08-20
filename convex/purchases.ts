import { paginationOptsValidator } from "convex/server";
import { ConvexError, v } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel";
import { mutation, query } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import { assertCents, assertQty, dayString, getShop, requireUser } from "./helpers";
import {
  purchaseDetail,
  purchaseDoc,
  purchaseListItem,
  purchaseStatus,
} from "./types";

// T5 — Purchases + purchaseItems (AGENTS.md). A purchase carries a business
// date (purchasedAt) and an optional arrival date (receivedAt): filled =
// arrived → stock enters on that day via one stockLedger row per line, with
// ts = the arrival date; empty = draft, not yet arrived, no stock.
// Purchases stay editable at any time: editing a received purchase rewrites
// its ledger rows (clear + fresh) whenever qty/membership/arrival changed, so
// stock — a pure aggregation — corrects itself; unit-cost-only edits touch
// no ledger rows. The per-line sale price written during the purchase is
// applied to the variant (or removed when it follows the product default
// again) inside the same transaction — the server never trusts the client.
// The server re-validates everything (qty/cost/price bounds, line ownership,
// duplicate variants, variant/supplier existence) and never trusts the client.

const NOTES_MAX = 2000;
const LINES_MAX = 500; // one purchase can carry at most this many lines

function invalid(): never {
  throw new ConvexError({ code: "INVALID_INPUT", message: "Check the form values." });
}

/** Optional free text: empty string means "not set". */
function cleanNotes(text: string | undefined): string | undefined {
  const trimmed = text?.trim();
  if (trimmed && trimmed.length > NOTES_MAX) invalid();
  return trimmed || undefined;
}

/**
 * A purchase/arrival date: finite integer epoch ms, not before 2000-01-01
 * and not in the future (a future purchase or arrival date is a typo).
 */
function assertDate(ms: unknown, label: string): number {
  if (
    typeof ms !== "number" ||
    !Number.isFinite(ms) ||
    !Number.isInteger(ms) ||
    ms < Date.UTC(2000, 0, 1) ||
    ms > Date.now()
  ) {
    throw new ConvexError({ code: "INVALID_INPUT", message: `${label} is not a valid date.` });
  }
  return ms;
}

type LineInput = {
  purchaseItemId?: Id<"purchaseItems">;
  variantId: Id<"productVariants">;
  qty: number;
  unitCost: number;
  price?: number;
};

/**
 * Bounds + variant existence for the raw line payloads. qty ≥ 1, unit cost
 * and price are bounded integers (assertQty/assertCents reject NaN/Infinity/
 * out-of-range). A variantId may appear only ONCE across the whole payload —
 * the same size twice is a form bug, not a bulk-apply. New lines must point
 * at an active variant; existing lines only need the variant to exist (their
 * size may have been removed since). Returns the validated lines plus the
 * fetched variants keyed by id so handlers don't re-fetch.
 */
async function validateLineValues(
  ctx: MutationCtx,
  lines: LineInput[]
): Promise<{ lines: LineInput[]; variantById: Map<Id<"productVariants">, Doc<"productVariants">> }> {
  if (lines.length === 0 || lines.length > LINES_MAX) invalid();
  const seen = new Set<Id<"productVariants">>();
  const out: LineInput[] = [];
  const variantById = new Map<Id<"productVariants">, Doc<"productVariants">>();
  for (const line of lines) {
    if (seen.has(line.variantId)) {
      throw new ConvexError({
        code: "INVALID_INPUT",
        message: "The same size can only appear once.",
      });
    }
    seen.add(line.variantId);
    const qty = assertQty(line.qty, 1);
    const unitCost = assertCents(line.unitCost, "unit cost");
    if (unitCost < 0) {
      throw new ConvexError({ code: "INVALID_MONEY", message: "Cost can't be negative." });
    }
    if (line.price !== undefined) {
      const price = assertCents(line.price, "price");
      if (price < 0) {
        throw new ConvexError({ code: "INVALID_MONEY", message: "Price can't be negative." });
      }
    }
    const variant = await ctx.db.get(line.variantId);
    if (!variant) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Item not found." });
    }
    if (line.purchaseItemId === undefined && !variant.active) {
      throw new ConvexError({
        code: "INVALID_INPUT",
        message: "That size is no longer active.",
      });
    }
    variantById.set(line.variantId, variant);
    out.push({ ...line, qty, unitCost });
  }
  return { lines: out, variantById };
}

/**
 * Next display code, e.g. "PO-20260815-001" — day derived from the purchase's
 * business date (purchasedAt), not "now". Mutations serialize, so count + 1
 * never collides. Codes are display labels, never access keys (the UUID _id
 * is the public identifier).
 */
async function nextCode(ctx: MutationCtx, purchasedAt: number): Promise<string> {
  const shop = await getShop(ctx);
  const prefix = `PO-${dayString(purchasedAt, shop.timezone).replace(/-/g, "")}-`;
  const count = (
    await ctx.db
      .query("purchases")
      .withIndex("by_code", (q) => q.gte("code", prefix).lt("code", `${prefix}￿`))
      .collect()
  ).length;
  return `${prefix}${String(count + 1).padStart(3, "0")}`;
}

/** One ledger row: +qty in for this purchase line, stamped at the arrival date. */
async function writeLineLedger(
  ctx: MutationCtx,
  purchase: Doc<"purchases">,
  variantId: Id<"productVariants">,
  purchaseItemId: Id<"purchaseItems">,
  qty: number,
  userId: Id<"users">,
  ts: number
) {
  await ctx.db.insert("stockLedger", {
    variantId,
    delta: qty, // bounded by assertQty above
    reason: "purchase",
    purchaseItemId,
    userId,
    ts,
    note: `Purchase ${purchase.code}`,
  });
}

/**
 * Remove every ledger row owned by the given lines (a line deleted, or a
 * full purchase-ledger rewrite). The ledger is immutable — a rewrite is a
 * delete-then-insert, never a patch.
 */
async function clearPurchaseLedger(
  ctx: MutationCtx,
  purchaseItemIds: Id<"purchaseItems">[]
) {
  for (const purchaseItemId of purchaseItemIds) {
    const rows = await ctx.db
      .query("stockLedger")
      .withIndex("by_purchaseItem", (q) => q.eq("purchaseItemId", purchaseItemId))
      .collect();
    for (const row of rows) await ctx.db.delete(row._id);
  }
}

/**
 * Apply the sale price written during the purchase to each variant that has
 * one: if it differs from the variant's current effective price (override or
 * product default), store it as an override — or REMOVE the override when the
 * new price equals the product default again (the variant follows defaults).
 * Runs inline in the caller's transaction; never calls another mutation.
 */
async function applySalePrices(
  ctx: MutationCtx,
  lines: LineInput[],
  variantById: Map<Id<"productVariants">, Doc<"productVariants">>
) {
  const productById = new Map<Id<"products">, Doc<"products">>();
  for (const line of lines) {
    if (line.price === undefined) continue;
    const variant = variantById.get(line.variantId)!;
    let product = productById.get(variant.productId);
    if (product === undefined) {
      const loaded = await ctx.db.get(variant.productId);
      if (!loaded) continue; // defensive — nothing is hard-deleted
      productById.set(variant.productId, loaded);
      product = loaded;
    }
    const effective = variant.price ?? product.defaultPrice;
    if (line.price !== effective) {
      if (line.price === product.defaultPrice) {
        await ctx.db.patch(variant._id, { price: undefined }); // follows defaults again
      } else {
        await ctx.db.patch(variant._id, { price: line.price });
      }
    }
  }
}

// A purchase is created with its business date and — when the goods have
// already arrived — its arrival date: a filled arrival date means received,
// so the ledger rows are written right here (ts = arrival date) and stock is
// in from day one. Drafts (no arrival date) touch no stock until the owner
// fills the arrival date on edit.
export const create = mutation({
  args: {
    supplierId: v.id("suppliers"),
    purchasedAt: v.number(),
    receivedAt: v.optional(v.number()),
    notes: v.optional(v.string()),
    deliveryCost: v.optional(v.number()), // what transport cost us, integer cents
    otherCost: v.optional(v.number()), // any other purchase cost, integer cents
    lines: v.array(
      v.object({
        variantId: v.id("productVariants"),
        qty: v.number(),
        unitCost: v.number(),
        price: v.optional(v.number()),
      })
    ),
  },
  returns: purchaseDoc,
  handler: async (ctx, args) => {
    const { staff } = await requireUser(ctx);
    const supplier = await ctx.db.get(args.supplierId);
    if (!supplier) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Supplier not found." });
    }
    const purchasedAt = assertDate(args.purchasedAt, "Purchase date");
    let receivedAt: number | undefined;
    if (args.receivedAt !== undefined) {
      receivedAt = assertDate(args.receivedAt, "Arrival date");
      if (receivedAt < purchasedAt) {
        throw new ConvexError({
          code: "INVALID_INPUT",
          message: "The arrival date can't be before the purchase date.",
        });
      }
    }
    let deliveryCost: number | undefined;
    if (args.deliveryCost !== undefined) {
      deliveryCost = assertCents(args.deliveryCost, "delivery cost");
      if (deliveryCost < 0) {
        throw new ConvexError({ code: "INVALID_MONEY", message: "Cost can't be negative." });
      }
    }
    let otherCost: number | undefined;
    if (args.otherCost !== undefined) {
      otherCost = assertCents(args.otherCost, "other cost");
      if (otherCost < 0) {
        throw new ConvexError({ code: "INVALID_MONEY", message: "Cost can't be negative." });
      }
    }
    const { lines, variantById } = await validateLineValues(
      ctx,
      args.lines.map((line) => ({ ...line, purchaseItemId: undefined }))
    );
    const code = await nextCode(ctx, purchasedAt);
    const now = Date.now();
    const purchaseId = await ctx.db.insert("purchases", {
      supplierId: args.supplierId,
      code,
      status: receivedAt ? "received" : "draft",
      receivedAt,
      purchasedAt,
      notes: cleanNotes(args.notes),
      ...(deliveryCost !== undefined ? { deliveryCost } : {}),
      ...(otherCost !== undefined ? { otherCost } : {}),
      userId: staff._id,
      createdAt: now,
    });
    const purchase = (await ctx.db.get(purchaseId))!;
    for (const line of lines) {
      const itemId = await ctx.db.insert("purchaseItems", {
        purchaseId,
        variantId: line.variantId,
        qty: line.qty,
        unitCost: line.unitCost,
      });
      if (receivedAt !== undefined) {
        await writeLineLedger(ctx, purchase, line.variantId, itemId, line.qty, staff._id, receivedAt);
      }
    }
    await applySalePrices(ctx, lines, variantById);
    return (await ctx.db.get(purchaseId))!;
  },
});

// Reconciles the full line set: existing lines patch in place (no per-line
// ledger writes here), new lines insert, removed lines delete together with
// the ledger rows they own. The ledger is rewritten in one shot when the
// arrival status, the arrival date, or the line membership/qty changed —
// unit-cost-only edits are ledger-neutral (stock doesn't care what a piece
// cost). Supplier, notes, purchase date and arrival date patch alongside.
// Works for draft and received alike; un-arriving (receivedAt = null) removes
// the ledger rows and the field.
export const update = mutation({
  args: {
    purchaseId: v.id("purchases"),
    supplierId: v.id("suppliers"),
    purchasedAt: v.optional(v.number()),
    receivedAt: v.optional(v.union(v.number(), v.null())), // undefined = keep; null = un-arrive
    deliveryCost: v.optional(v.union(v.number(), v.null())), // undefined = keep; null = clear
    otherCost: v.optional(v.union(v.number(), v.null())), // undefined = keep; null = clear
    notes: v.optional(v.string()),
    lines: v.array(
      v.object({
        purchaseItemId: v.optional(v.id("purchaseItems")),
        variantId: v.id("productVariants"),
        qty: v.number(),
        unitCost: v.number(),
        price: v.optional(v.number()),
      })
    ),
  },
  returns: purchaseDoc,
  handler: async (ctx, args) => {
    const { staff } = await requireUser(ctx);
    const purchase = await ctx.db.get(args.purchaseId);
    if (!purchase) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Purchase not found." });
    }
    const supplier = await ctx.db.get(args.supplierId);
    if (!supplier) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Supplier not found." });
    }

    // Dates: provided values are asserted; absent ones keep the stored values
    // (purchasedAt always exists after the backfill — createdAt is a
    // defensive fallback for rows written before it).
    if (args.purchasedAt !== undefined) assertDate(args.purchasedAt, "Purchase date");
    const effectivePurchasedAt = args.purchasedAt ?? purchase.purchasedAt ?? purchase.createdAt;
    const effectiveReceivedAt: number | undefined =
      args.receivedAt === undefined ? (purchase.receivedAt ?? undefined) : args.receivedAt ?? undefined;
    if (typeof args.receivedAt === "number") {
      const receivedAt = assertDate(args.receivedAt, "Arrival date");
      if (receivedAt < effectivePurchasedAt) {
        throw new ConvexError({
          code: "INVALID_INPUT",
          message: "The arrival date can't be before the purchase date.",
        });
      }
    }

    // Costs: provided values are asserted (undefined = keep, null = clear).
    if (typeof args.deliveryCost === "number") {
      const deliveryCost = assertCents(args.deliveryCost, "delivery cost");
      if (deliveryCost < 0) {
        throw new ConvexError({ code: "INVALID_MONEY", message: "Cost can't be negative." });
      }
    }
    if (typeof args.otherCost === "number") {
      const otherCost = assertCents(args.otherCost, "other cost");
      if (otherCost < 0) {
        throw new ConvexError({ code: "INVALID_MONEY", message: "Cost can't be negative." });
      }
    }

    const existing = await ctx.db
      .query("purchaseItems")
      .withIndex("by_purchase", (q) => q.eq("purchaseId", args.purchaseId))
      .collect();
    const byId = new Map(existing.map((item) => [item._id, item]));
    // Ownership + variant-unchanged checks first — a line keeps its item;
    // changing it means remove + add a new line.
    for (const line of args.lines) {
      if (line.purchaseItemId === undefined) continue;
      const old = byId.get(line.purchaseItemId);
      if (!old || old.purchaseId !== args.purchaseId) invalid();
      if (old.variantId !== line.variantId) {
        throw new ConvexError({
          code: "INVALID_INPUT",
          message: "A line's item can't change — remove it and add a new line.",
        });
      }
    }
    // Duplicate-variantId rejection covers the FULL final set: kept lines
    // carry their variantId in the payload, so new lines can't collide with
    // each other or with kept items.
    const { lines, variantById } = await validateLineValues(ctx, args.lines);

    // Reconcile items. No per-line ledger writes here — the ledger is
    // rewritten below in one shot when anything stock-relevant changed.
    const kept = new Set<Id<"purchaseItems">>();
    const involvedIds: Id<"purchaseItems">[] = []; // one id per line, same order as `lines`
    let membershipChanged = false;
    for (const line of lines) {
      if (line.purchaseItemId !== undefined) {
        const old = byId.get(line.purchaseItemId)!;
        kept.add(line.purchaseItemId);
        involvedIds.push(line.purchaseItemId);
        if (old.qty !== line.qty || old.unitCost !== line.unitCost) {
          await ctx.db.patch(line.purchaseItemId, {
            qty: line.qty,
            unitCost: line.unitCost,
          });
          if (old.qty !== line.qty) membershipChanged = true;
        }
      } else {
        const itemId = await ctx.db.insert("purchaseItems", {
          purchaseId: args.purchaseId,
          variantId: line.variantId,
          qty: line.qty,
          unitCost: line.unitCost,
        });
        involvedIds.push(itemId);
        membershipChanged = true;
      }
    }
    // Removed lines: delete the line and the ledger rows it owns (stock
    // flows back out — the ledger is the only source of truth).
    for (const old of existing) {
      if (!kept.has(old._id)) {
        await ctx.db.delete(old._id);
        involvedIds.push(old._id);
        membershipChanged = true;
      }
    }

    // Ledger rewrite decision: on a status flip (draft ↔ received), or for a
    // received purchase whose arrival date or line membership/qty changed,
    // clear every involved line's rows and write one fresh row per current
    // line with ts = the (new) arrival date. Otherwise the ledger is
    // untouched — unit-cost-only edits are ledger-neutral.
    const wasReceived = purchase.receivedAt != null;
    const isReceived = effectiveReceivedAt != null;
    const receivedAtChanged =
      args.receivedAt !== undefined && args.receivedAt !== purchase.receivedAt;
    if (wasReceived !== isReceived || (isReceived && (receivedAtChanged || membershipChanged))) {
      await clearPurchaseLedger(ctx, involvedIds);
      if (isReceived) {
        for (let i = 0; i < lines.length; i++) {
          await writeLineLedger(
            ctx,
            purchase,
            lines[i].variantId,
            involvedIds[i],
            lines[i].qty,
            staff._id,
            effectiveReceivedAt!
          );
        }
      }
    }

    // Sale prices apply on save — drafts and received alike.
    await applySalePrices(ctx, lines, variantById);

    await ctx.db.patch(args.purchaseId, {
      supplierId: args.supplierId,
      notes: cleanNotes(args.notes),
      ...(args.purchasedAt !== undefined ? { purchasedAt: args.purchasedAt } : {}),
      status: isReceived ? "received" : "draft",
      receivedAt: effectiveReceivedAt ?? undefined, // undefined removes the field on un-arrive
      ...(args.deliveryCost === undefined ? {} : { deliveryCost: args.deliveryCost ?? undefined }),
      ...(args.otherCost === undefined ? {} : { otherCost: args.otherCost ?? undefined }),
    });
    return (await ctx.db.get(args.purchaseId))!;
  },
});

// One purchase with its supplier and every line joined to the variant and
// product it points at (deduped reads) — null while the edit page loads.
export const get = query({
  args: { purchaseId: v.id("purchases") },
  returns: v.union(purchaseDetail, v.null()),
  handler: async (ctx, args) => {
    await requireUser(ctx);
    const purchase = await ctx.db.get(args.purchaseId);
    if (!purchase) return null;
    const supplier = await ctx.db.get(purchase.supplierId);
    if (!supplier) return null; // defensive — suppliers are soft-deleted only
    const itemDocs = await ctx.db
      .query("purchaseItems")
      .withIndex("by_purchase", (q) => q.eq("purchaseId", args.purchaseId))
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
      items.push({ item, variant, product });
    }
    return { purchase, supplier, items };
  },
});

// Paginated list, newest first. Filters: prefix search on the code index or
// a status filter; batched reads join supplier name + per-purchase line
// totals (item count = Σ qty, grand total = Σ qty × unitCost + deliveryCost
// + otherCost).
export const list = query({
  args: {
    paginationOpts: paginationOptsValidator,
    status: v.optional(purchaseStatus),
    search: v.optional(v.string()),
  },
  returns: v.object({
    page: v.array(purchaseListItem),
    continueCursor: v.string(),
    total: v.number(),
  }),
  handler: async (ctx, args) => {
    await requireUser(ctx);
    const term = args.search?.trim().toUpperCase() ?? "";
    const statusFilter = args.status;
    // Three index paths, all with cursors. Query builders are single-use —
    // a factory keeps the page + total queries separate.
    const build = () => {
      if (term) {
        return ctx.db.query("purchases").withIndex("by_code", (q) =>
          q.gte("code", term).lt("code", `${term}￿`)
        );
      }
      if (statusFilter) {
        return ctx.db
          .query("purchases")
          .withIndex("by_status", (q) => q.eq("status", statusFilter));
      }
      return ctx.db.query("purchases").withIndex("by_createdAt");
    };
    const page = await build().order("desc").paginate(args.paginationOpts);
    const total = (await build().take(1000)).length;
    const rows = await Promise.all(
      page.page.map(async (purchase) => {
        const supplier = await ctx.db.get(purchase.supplierId);
        const items = await ctx.db
          .query("purchaseItems")
          .withIndex("by_purchase", (q) => q.eq("purchaseId", purchase._id))
          .collect();
        let itemCount = 0;
        let totalCost = 0;
        for (const item of items) {
          itemCount += item.qty;
          totalCost += item.qty * item.unitCost;
        }
        totalCost += (purchase.deliveryCost ?? 0) + (purchase.otherCost ?? 0);
        return {
          purchase,
          supplierName: supplier?.name ?? "—",
          itemCount,
          totalCost,
        };
      })
    );
    return { page: rows, continueCursor: page.isDone ? "" : page.continueCursor, total };
  },
});
