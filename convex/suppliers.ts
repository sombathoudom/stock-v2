import { paginationOptsValidator } from "convex/server";
import { ConvexError, v } from "convex/values";

import { mutation, query } from "./_generated/server";
import { requireOwner, requireUser } from "./helpers";
import { supplierDoc } from "./types";

// Suppliers are contact records only — they never log in or use the app.
// Any signed-in staff member can manage them; auth is enforced server-side
// by requireUser (hiding buttons in the UI is UX only). Soft-delete only:
// purchases keep pointing at the same row forever.

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

/** Optional free-text fields: empty string means "not set". */
function cleanOptional(text: string | undefined, maxLength: number): string | undefined {
  const trimmed = text?.trim();
  return trimmed ? trimmed.slice(0, maxLength) : undefined;
}

export const create = mutation({
  args: {
    name: v.string(),
    phone: v.optional(v.string()),
    notes: v.optional(v.string()),
  },
  returns: supplierDoc,
  handler: async (ctx, args) => {
    await requireUser(ctx);
    const name = cleanName(args.name);
    const id = await ctx.db.insert("suppliers", {
      name,
      nameLower: name.toLowerCase(),
      phone: cleanOptional(args.phone, 50),
      notes: cleanOptional(args.notes, 2000),
      active: true,
    });
    return (await ctx.db.get(id))!;
  },
});

// Rename and/or soft-delete. Nothing is ever hard-deleted.
export const update = mutation({
  args: {
    supplierId: v.id("suppliers"),
    name: v.string(),
    phone: v.optional(v.string()),
    notes: v.optional(v.string()),
    active: v.boolean(),
  },
  returns: supplierDoc,
  handler: async (ctx, args) => {
    await requireUser(ctx);
    const existing = await ctx.db.get(args.supplierId);
    if (!existing) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Supplier not found." });
    }
    // Soft-delete flips are owner-only; normal edits stay open to staff.
    if (existing.active !== args.active) await requireOwner(ctx);
    const name = cleanName(args.name);
    await ctx.db.patch(args.supplierId, {
      name,
      nameLower: name.toLowerCase(),
      // undefined deletes the field (value cleared back to "not set").
      phone: cleanOptional(args.phone, 50),
      notes: cleanOptional(args.notes, 2000),
      active: args.active,
    });
    return (await ctx.db.get(args.supplierId))!;
  },
});

// One supplier by id — null (not an error) while the edit page loads.
export const get = query({
  args: { supplierId: v.id("suppliers") },
  returns: v.union(supplierDoc, v.null()),
  handler: async (ctx, args) => {
    await requireUser(ctx);
    return await ctx.db.get(args.supplierId);
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
    page: v.array(supplierDoc),
    continueCursor: v.string(),
    total: v.number(),
  }),
  handler: async (ctx, args) => {
    await requireUser(ctx);
    const term = args.search?.trim().toLowerCase() ?? "";
    // Query builders are single-use — a factory keeps page + total separate.
    const build = () =>
      ctx.db.query("suppliers").withIndex("by_nameLower", (q) =>
        term ? q.gte("nameLower", term).lt("nameLower", `${term}￿`) : q
      );
    const page = await build().order("asc").paginate(args.paginationOpts);
    const total = (await build().take(1000)).length;
    return { page: page.page, continueCursor: page.isDone ? "" : page.continueCursor, total };
  },
});

// Light combobox list for forms (purchase form): prefix search, active only.
// Deactivated suppliers disappear from pickers but stay editable in place.
export const listActive = query({
  args: { search: v.optional(v.string()) },
  returns: v.array(supplierDoc),
  handler: async (ctx, args) => {
    await requireUser(ctx);
    const term = args.search?.trim().toLowerCase() ?? "";
    const rows = await ctx.db
      .query("suppliers")
      .withIndex("by_nameLower", (q) =>
        term ? q.gte("nameLower", term).lt("nameLower", `${term}￿`) : q
      )
      .order("asc")
      .take(100);
    return rows.filter((s) => s.active);
  },
});
