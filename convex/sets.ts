import { paginationOptsValidator } from "convex/server";
import { ConvexError, v } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel";
import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { assertCents, assertQty, requireOwner, requireUser } from "./helpers";
import { setDetail, setDoc } from "./types";

// Combo sets (bundles). A set is a SAVED RECIPE of existing products sold
// together at a special price (each component carries its own set price). The
// set holds no stock — selling one deducts each component variant from the
// ledger at checkout (convex/sales.ts). Soft-delete only.

const SET_ITEMS_MAX = 20;

/** Trim + length-check the name. Server re-validates every write. */
function cleanName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > 100) {
    throw new ConvexError({
      code: "INVALID_INPUT",
      message: "Name must be 1–100 characters.",
    });
  }
  return trimmed;
}

/** Validate one recipe component and confirm the product exists + is active.
 *  Returns the normalized row to insert. */
async function cleanItem(
  ctx: { db: MutationCtx["db"] },
  item: { productId: Id<"products">; qty: number; setPrice: number }
): Promise<{ productId: Id<"products">; qty: number; setPrice: number }> {
  const product = await ctx.db.get(item.productId);
  if (!product || !product.active) {
    throw new ConvexError({ code: "NOT_FOUND", message: "Product not found." });
  }
  const qty = assertQty(item.qty, 1, "component qty");
  if (qty < 1) {
    throw new ConvexError({ code: "INVALID_QTY", message: "Quantity must be at least 1." });
  }
  const setPrice = assertCents(item.setPrice, "set price");
  if (setPrice < 0) {
    throw new ConvexError({ code: "INVALID_MONEY", message: "Set price can't be negative." });
  }
  return { productId: item.productId, qty, setPrice };
}

/** The component input shared by create + update. */
const setItemInput = v.object({
  productId: v.id("products"),
  qty: v.number(),
  setPrice: v.number(),
});

/** Insert a set's component rows (used on create and on update after the old
 *  rows are cleared). At least one component is required. */
async function insertItems(
  ctx: { db: MutationCtx["db"] },
  setId: Id<"sets">,
  items: { productId: Id<"products">; qty: number; setPrice: number }[]
): Promise<void> {
  if (items.length === 0 || items.length > SET_ITEMS_MAX) {
    throw new ConvexError({
      code: "INVALID_INPUT",
      message: "A set needs 1–20 items.",
    });
  }
  for (const raw of items) {
    const clean = await cleanItem(ctx, raw);
    await ctx.db.insert("setItems", { setId, ...clean });
  }
}

export const create = mutation({
  args: {
    name: v.string(),
    imageStorageId: v.optional(v.id("_storage")),
    items: v.array(setItemInput),
  },
  returns: setDoc,
  handler: async (ctx, args) => {
    await requireUser(ctx);
    const name = cleanName(args.name);
    const setId = await ctx.db.insert("sets", {
      name,
      nameLower: name.toLowerCase(),
      imageStorageId: args.imageStorageId,
      active: true,
    });
    await insertItems(ctx, setId, args.items);
    return (await ctx.db.get(setId))!;
  },
});

// Rename, change photo/components, soft-delete. Components are REPLACED: the
// old rows are cleared and re-inserted (recipes have no history to preserve —
// a sold set already snapshotted its prices onto the sale lines).
export const update = mutation({
  args: {
    setId: v.id("sets"),
    name: v.string(),
    imageStorageId: v.optional(v.id("_storage")),
    items: v.array(setItemInput),
    active: v.boolean(),
  },
  returns: setDoc,
  handler: async (ctx, args) => {
    await requireUser(ctx);
    const existing = await ctx.db.get(args.setId);
    if (!existing) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Set not found." });
    }
    // Soft-delete flips are owner-only; normal edits stay open to staff.
    if (existing.active !== args.active) await requireOwner(ctx);
    const name = cleanName(args.name);
    await ctx.db.patch(args.setId, {
      name,
      nameLower: name.toLowerCase(),
      imageStorageId: args.imageStorageId,
      active: args.active,
    });
    const oldItems = await ctx.db
      .query("setItems")
      .withIndex("by_set", (q) => q.eq("setId", args.setId))
      .collect();
    for (const item of oldItems) await ctx.db.delete(item._id);
    await insertItems(ctx, args.setId, args.items);
    return (await ctx.db.get(args.setId))!;
  },
});

/** Build the set + its component lines joined with each product, plus the set
 *  total (Σ setPrice × qty). Shared by get() and listActive() for the POS. */
async function buildSetDetail(ctx: { db: QueryCtx["db"] }, set: Doc<"sets">) {
  const itemRows = await ctx.db
    .query("setItems")
    .withIndex("by_set", (q) => q.eq("setId", set._id))
    .collect();
  const items = [];
  let setTotal = 0;
  for (const item of itemRows) {
    const product = await ctx.db.get(item.productId);
    if (!product) continue; // defensive — products are soft-deleted only
    items.push({ item, product });
    setTotal += item.setPrice * item.qty;
  }
  return { set, items, setTotal };
}

// One set with its components — null (not an error) while an edit page loads.
export const get = query({
  args: { setId: v.id("sets") },
  returns: v.union(setDetail, v.null()),
  handler: async (ctx, args) => {
    await requireUser(ctx);
    const set = await ctx.db.get(args.setId);
    if (!set) return null;
    return await buildSetDetail(ctx, set);
  },
});

// Paginated list, alphabetical, optional case-insensitive PREFIX search on the
// nameLower index — index-driven, never a scan.
export const list = query({
  args: {
    paginationOpts: paginationOptsValidator,
    search: v.optional(v.string()),
  },
  returns: v.object({
    page: v.array(setDoc),
    continueCursor: v.string(),
    total: v.number(),
  }),
  handler: async (ctx, args) => {
    await requireUser(ctx);
    const term = args.search?.trim().toLowerCase() ?? "";
    const build = () =>
      ctx.db.query("sets").withIndex("by_nameLower", (q) =>
        term ? q.gte("nameLower", term).lt("nameLower", `${term}\uffff`) : q
      );
    const page = await build().order("asc").paginate(args.paginationOpts);
    const total = (await build().take(1000)).length;
    return {
      page: page.page,
      continueCursor: page.isDone ? "" : page.continueCursor,
      total,
    };
  },
});

// All active sets WITH their components for the POS grid + size popup. A shop
// has a handful, so a capped take with per-set joins is plenty.
export const listActive = query({
  args: {},
  returns: v.array(setDetail),
  handler: async (ctx) => {
    await requireUser(ctx);
    const rows = await ctx.db
      .query("sets")
      .withIndex("by_nameLower")
      .order("asc")
      .take(100);
    const active = rows.filter((s) => s.active);
    return await Promise.all(active.map((set) => buildSetDetail(ctx, set)));
  },
});
