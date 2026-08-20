import { paginationOptsValidator } from "convex/server";
import { ConvexError, v } from "convex/values";

import { mutation, query } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import { requireOwner, requireUser } from "./helpers";
import { customerDoc } from "./types";

// T7 — Customers (AGENTS.md). Phone is the dedupe key: stored normalized
// (digits only, no leading zeros) and uniqueness is ENFORCED SERVER-SIDE —
// the frontend banner is UX only. Duplicate phones throw DUPLICATE_CUSTOMER
// unless the caller explicitly force-creates.

/** "012 345 678" / "+855 (12) 345-678" → "12345678". */
export function normalizePhone(input: string): string {
  return input.replace(/[^0-9]/g, "").replace(/^0+/, "");
}

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

/** Normalized phone or undefined; throws when a phone has no digits at all. */
function cleanPhone(phone: string | undefined): string | undefined {
  const trimmed = phone?.trim();
  if (!trimmed) return undefined;
  const normalized = normalizePhone(trimmed);
  if (!normalized || normalized.length > 30) {
    throw new ConvexError({
      code: "INVALID_INPUT",
      message: "Phone must contain digits.",
    });
  }
  return normalized;
}

/** The one customer already using this normalized phone, if any. */
async function findDuplicate(
  ctx: { db: import("./_generated/server").MutationCtx["db"] },
  phone: string | undefined,
  excludeId?: import("./_generated/dataModel").Id<"customers">
) {
  if (!phone) return null;
  const found = await ctx.db
    .query("customers")
    .withIndex("by_phone", (q) => q.eq("phone", phone))
    .first();
  if (found && found._id !== excludeId) return found;
  return null;
}

export const create = mutation({
  args: {
    name: v.string(),
    phone: v.optional(v.string()),
    address: v.optional(v.string()),
    notes: v.optional(v.string()),
    // The UI asks before re-creating a known phone; only pass true when the
    // owner explicitly chose "Create anyway".
    forceCreate: v.optional(v.boolean()),
  },
  returns: customerDoc,
  handler: async (ctx, args) => {
    await requireUser(ctx);
    const name = cleanName(args.name);
    const phone = cleanPhone(args.phone);
    if (!args.forceCreate) {
      const duplicate = await findDuplicate(ctx, phone);
      if (duplicate) {
        throw new ConvexError({
          code: "DUPLICATE_CUSTOMER",
          message: "A customer with this phone already exists.",
          // Extra payload for the "Use existing / Create anyway" prompt.
          customerId: duplicate._id,
          customerName: duplicate.name,
          customerPhone: duplicate.phone,
        });
      }
    }
    const id = await ctx.db.insert("customers", {
      name,
      nameLower: name.toLowerCase(),
      phone: phone ?? "",
      address: cleanOptional(args.address, 300),
      notes: cleanOptional(args.notes, 2000),
      active: true,
    });
    return (await ctx.db.get(id))!;
  },
});

// Rename, change phone (same dedupe rule, ignoring this row), soft-delete.
export const update = mutation({
  args: {
    customerId: v.id("customers"),
    name: v.string(),
    phone: v.optional(v.string()),
    address: v.optional(v.string()),
    notes: v.optional(v.string()),
    active: v.boolean(),
    forceCreate: v.optional(v.boolean()),
  },
  returns: customerDoc,
  handler: async (ctx, args) => {
    await requireUser(ctx);
    const existing = await ctx.db.get(args.customerId);
    if (!existing) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Customer not found." });
    }
    // Soft-delete flips are owner-only; normal edits stay open to staff.
    if (existing.active !== args.active) await requireOwner(ctx);
    const name = cleanName(args.name);
    const phone = cleanPhone(args.phone);
    if (!args.forceCreate) {
      const duplicate = await findDuplicate(ctx, phone, args.customerId);
      if (duplicate) {
        throw new ConvexError({
          code: "DUPLICATE_CUSTOMER",
          message: "A customer with this phone already exists.",
          // Extra payload for the "Use existing / Create anyway" prompt.
          customerId: duplicate._id,
          customerName: duplicate.name,
          customerPhone: duplicate.phone,
        });
      }
    }
    await ctx.db.patch(args.customerId, {
      name,
      nameLower: name.toLowerCase(),
      // undefined deletes the field (value cleared back to "not set").
      phone: phone ?? "",
      address: cleanOptional(args.address, 300),
      notes: cleanOptional(args.notes, 2000),
      active: args.active,
    });
    return (await ctx.db.get(args.customerId))!;
  },
});

// One customer by id — null (not an error) while the edit page loads.
export const get = query({
  args: { customerId: v.id("customers") },
  returns: v.union(customerDoc, v.null()),
  handler: async (ctx, args) => {
    await requireUser(ctx);
    return await ctx.db.get(args.customerId);
  },
});

// Paginated list, alphabetical. The search is a PREFIX match on the
// nameLower index; an all-digits term searches the normalized phone index
// instead ("Search by name or phone", AGENTS.md). Index-driven, never a scan.
export const list = query({
  args: {
    paginationOpts: paginationOptsValidator,
    search: v.optional(v.string()),
  },
  returns: v.object({
    page: v.array(customerDoc),
    continueCursor: v.string(),
    total: v.number(),
  }),
  handler: async (ctx, args) => {
    await requireUser(ctx);
    const term = args.search?.trim().toLowerCase() ?? "";
    // Query builders are single-use — a factory keeps page + total separate.
    const isPhoneSearch = /^[0-9]/.test(term);
    const build = () =>
      isPhoneSearch
        ? ctx.db.query("customers").withIndex("by_phone", (q) =>
            q.gte("phone", term).lt("phone", `${term}￿`)
          )
        : ctx.db.query("customers").withIndex("by_nameLower", (q) =>
            q.gte("nameLower", term).lt("nameLower", `${term}￿`)
          );
    const page = await build().order("asc").paginate(args.paginationOpts);
    const total = (await build().take(1000)).length;
    return { page: page.page, continueCursor: page.isDone ? "" : page.continueCursor, total };
  },
});

// Light combobox list for the POS screen: active only, prefix search on
// name or normalized phone, capped at 100.
export const listActive = query({
  args: { search: v.optional(v.string()) },
  returns: v.array(customerDoc),
  handler: async (ctx, args) => {
    await requireUser(ctx);
    const term = args.search?.trim().toLowerCase() ?? "";
    const isPhoneSearch = /^[0-9]/.test(term);
    const build = () =>
      isPhoneSearch
        ? ctx.db.query("customers").withIndex("by_phone", (q) =>
            q.gte("phone", term).lt("phone", `${term}￿`)
          )
        : ctx.db.query("customers").withIndex("by_nameLower", (q) =>
            q.gte("nameLower", term).lt("nameLower", `${term}￿`)
          );
    const rows = await build().order("asc").take(100);
    return rows.filter((c) => c.active);
  },
});

// Dedupe lookup for the create form: an exact normalized-phone match or an
// exact name match means "this customer probably already exists". The UI
// shows these with "Use existing" / "Create anyway" options; the server
// enforces the phone rule regardless.
export const lookup = query({
  args: {
    phone: v.optional(v.string()),
    name: v.optional(v.string()),
  },
  returns: v.array(customerDoc),
  handler: async (ctx, args) => {
    await requireUser(ctx);
    const normalized = args.phone ? normalizePhone(args.phone.trim()) : "";
    const nameLower = args.name?.trim().toLowerCase() ?? "";
    if (!normalized && !nameLower) return [];

    const matches = new Map<
      string,
      import("./_generated/dataModel").Doc<"customers">
    >();
    if (normalized) {
      const byPhone = await ctx.db
        .query("customers")
        .withIndex("by_phone", (q) => q.eq("phone", normalized))
        .take(5);
      for (const c of byPhone) matches.set(c._id, c);
    }
    if (nameLower) {
      const byName = await ctx.db
        .query("customers")
        .withIndex("by_nameLower", (q) => q.eq("nameLower", nameLower))
        .take(5);
      for (const c of byName) matches.set(c._id, c);
    }
    return [...matches.values()].slice(0, 5);
  },
});

// The POS default customer: one seeded "Walk-in Customer" record per shop.
// Idempotent — found by flag first, then by the canonical name (survives a
// rename), created only when neither exists. Shared by shop.ensureDefaults
// (fresh shops) and the ensureWalkIn mutation (shops predating the flag).
export async function ensureWalkInCustomer(ctx: MutationCtx) {
  const flagged = await ctx.db
    .query("customers")
    .withIndex("by_isWalkIn", (q) => q.eq("isWalkIn", true))
    .first();
  if (flagged) return flagged;
  const named = await ctx.db
    .query("customers")
    .withIndex("by_nameLower", (q) => q.eq("nameLower", "walk-in customer"))
    .first();
  if (named) return named;
  const id = await ctx.db.insert("customers", {
    name: "Walk-in Customer",
    nameLower: "walk-in customer",
    phone: "",
    active: true,
    isWalkIn: true,
  });
  return (await ctx.db.get(id))!;
}

// The active walk-in record — null when missing or deactivated (the sale
// screen then calls ensureWalkIn once and falls back to no preselect).
export const getWalkIn = query({
  args: {},
  returns: v.union(customerDoc, v.null()),
  handler: async (ctx) => {
    await requireUser(ctx);
    const found = await ctx.db
      .query("customers")
      .withIndex("by_isWalkIn", (q) => q.eq("isWalkIn", true))
      .first();
    return found && found.active ? found : null;
  },
});

// One-time idempotent seed for shops created before the walk-in flag existed.
export const ensureWalkIn = mutation({
  args: {},
  returns: customerDoc,
  handler: async (ctx) => {
    await requireUser(ctx);
    return await ensureWalkInCustomer(ctx);
  },
});
