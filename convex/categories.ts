import { paginationOptsValidator } from "convex/server";
import { ConvexError, v } from "convex/values";

import { mutation, query } from "./_generated/server";
import { requireOwner, requireUser } from "./helpers";
import { categoryDoc } from "./types";

// Categories are a day-to-day catalog tool — any signed-in staff member
// (owner or cashier) can manage them. Auth is enforced server-side by
// requireUser; hiding buttons in the UI is UX only.

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

export const create = mutation({
  args: { name: v.string() },
  returns: categoryDoc,
  handler: async (ctx, args) => {
    await requireUser(ctx);
    const name = cleanName(args.name);
    const id = await ctx.db.insert("categories", {
      name,
      nameLower: name.toLowerCase(),
      active: true,
    });
    return (await ctx.db.get(id))!;
  },
});

// Rename and/or soft-delete (active=false). Nothing is ever hard-deleted —
// products keep pointing at the same category row.
export const update = mutation({
  args: {
    categoryId: v.id("categories"),
    name: v.string(),
    active: v.boolean(),
  },
  returns: categoryDoc,
  handler: async (ctx, args) => {
    await requireUser(ctx);
    const existing = await ctx.db.get(args.categoryId);
    if (!existing) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Category not found." });
    }
    // Soft-delete flips are owner-only; normal edits stay open to staff.
    if (existing.active !== args.active) await requireOwner(ctx);
    const name = cleanName(args.name);
    await ctx.db.patch(args.categoryId, {
      name,
      nameLower: name.toLowerCase(),
      active: args.active,
    });
    return (await ctx.db.get(args.categoryId))!;
  },
});

// All categories, alphabetical — the product form combobox and the product
// list filter need the full set (small table, no pagination needed).
export const listAll = query({
  args: {},
  returns: v.array(categoryDoc),
  handler: async (ctx) => {
    await requireUser(ctx);
    return await ctx.db.query("categories").withIndex("by_nameLower").order("asc").collect();
  },
});

// One category by id — null (not an error) while the edit page loads.
export const get = query({
  args: { categoryId: v.id("categories") },
  returns: v.union(categoryDoc, v.null()),
  handler: async (ctx, args) => {
    await requireUser(ctx);
    return await ctx.db.get(args.categoryId);
  },
});

// Paginated list, alphabetical. The optional search is a case-insensitive
// PREFIX match on the indexed nameLower column — index-driven, never a scan.
export const list = query({
  args: {
    paginationOpts: paginationOptsValidator,
    search: v.optional(v.string()),
  },
  returns: v.object({
    page: v.array(categoryDoc),
    continueCursor: v.string(),
    total: v.number(),
  }),
  handler: async (ctx, args) => {
    await requireUser(ctx);
    const term = args.search?.trim().toLowerCase() ?? "";
    // Query builders are single-use — a factory keeps page + total separate.
    const build = () =>
      ctx.db.query("categories").withIndex("by_nameLower", (q) =>
        term ? q.gte("nameLower", term).lt("nameLower", `${term}￿`) : q
      );
    const page = await build().order("asc").paginate(args.paginationOpts);
    const total = (await build().take(1000)).length;
    return { page: page.page, continueCursor: page.isDone ? "" : page.continueCursor, total };
  },
});
