import { paginationOptsValidator } from "convex/server";
import { ConvexError, v } from "convex/values";

import { mutation, query } from "./_generated/server";
import { assertCents, requireOwner, requireUser } from "./helpers";
import { deliveryCompanyDoc } from "./types";

// T9 — Delivery companies (AGENTS.md). Contact records ONLY: companies
// never log in or use the app — they just receive the dropped packages.
// defaultFee = what the shop pays per handled order; auto-filled per sale
// and overridable. Soft-delete only.

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

/** Phone is optional; digits trimmed to 30 chars. */
function cleanPhone(phone?: string): string | undefined {
  const trimmed = phone?.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > 30) {
    throw new ConvexError({
      code: "INVALID_INPUT",
      message: "Phone must be at most 30 characters.",
    });
  }
  return trimmed;
}

export const create = mutation({
  args: {
    name: v.string(),
    phone: v.optional(v.string()),
    defaultFee: v.number(),
    imageStorageId: v.optional(v.id("_storage")),
  },
  returns: deliveryCompanyDoc,
  handler: async (ctx, args) => {
    await requireUser(ctx);
    const name = cleanName(args.name);
    const defaultFee = assertCents(args.defaultFee, "defaultFee");
    const id = await ctx.db.insert("deliveryCompanies", {
      name,
      nameLower: name.toLowerCase(),
      phone: cleanPhone(args.phone),
      defaultFee,
      imageStorageId: args.imageStorageId,
      active: true,
    });
    return (await ctx.db.get(id))!;
  },
});

// Rename, change phone/fee, soft-delete. Nothing is ever hard-deleted.
export const update = mutation({
  args: {
    companyId: v.id("deliveryCompanies"),
    name: v.string(),
    phone: v.optional(v.string()),
    defaultFee: v.number(),
    imageStorageId: v.optional(v.id("_storage")),
    active: v.boolean(),
  },
  returns: deliveryCompanyDoc,
  handler: async (ctx, args) => {
    await requireUser(ctx);
    const existing = await ctx.db.get(args.companyId);
    if (!existing) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Company not found." });
    }
    // Soft-delete flips are owner-only; normal edits stay open to staff.
    if (existing.active !== args.active) await requireOwner(ctx);
    const name = cleanName(args.name);
    await ctx.db.patch(args.companyId, {
      name,
      nameLower: name.toLowerCase(),
      phone: cleanPhone(args.phone),
      defaultFee: assertCents(args.defaultFee, "defaultFee"),
      // undefined clears the logo (Convex patch semantics) — Remove in the form.
      imageStorageId: args.imageStorageId,
      active: args.active,
    });
    return (await ctx.db.get(args.companyId))!;
  },
});

// One company by id — null (not an error) while the edit page loads.
export const get = query({
  args: { companyId: v.id("deliveryCompanies") },
  returns: v.union(deliveryCompanyDoc, v.null()),
  handler: async (ctx, args) => {
    await requireUser(ctx);
    return await ctx.db.get(args.companyId);
  },
});

// Paginated list, alphabetical, optional case-insensitive PREFIX search on
// the nameLower index — index-driven, never a scan.
export const list = query({
  args: {
    paginationOpts: paginationOptsValidator,
    search: v.optional(v.string()),
  },
  returns: v.object({
    page: v.array(deliveryCompanyDoc),
    continueCursor: v.string(),
    total: v.number(),
  }),
  handler: async (ctx, args) => {
    await requireUser(ctx);
    const term = args.search?.trim().toLowerCase() ?? "";
    // Query builders are single-use — a factory keeps page + total separate.
    const build = () =>
      ctx.db.query("deliveryCompanies").withIndex("by_nameLower", (q) =>
        term ? q.gte("nameLower", term).lt("nameLower", `${term}￿`) : q
      );
    const page = await build().order("asc").paginate(args.paginationOpts);
    const total = (await build().take(1000)).length;
    return { page: page.page, continueCursor: page.isDone ? "" : page.continueCursor, total };
  },
});

// All active companies for the POS checkout picker — the shop has a handful,
// so a capped take is plenty. Deactivated companies disappear from new sales.
export const listActive = query({
  args: {},
  returns: v.array(deliveryCompanyDoc),
  handler: async (ctx) => {
    await requireUser(ctx);
    const rows = await ctx.db
      .query("deliveryCompanies")
      .withIndex("by_nameLower")
      .order("asc")
      .take(100);
    return rows.filter((c) => c.active);
  },
});
