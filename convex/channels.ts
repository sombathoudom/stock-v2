import { paginationOptsValidator } from "convex/server";
import { ConvexError, v } from "convex/values";

import { mutation, query } from "./_generated/server";
import { requireOwner, requireUser } from "./helpers";
import { channelType, salesChannelDoc } from "./types";

// T8 — Sales channels (AGENTS.md): the shop's selling pages (Facebook page,
// IG, TikTok, walk-in…). Every sale records exactly one channel, so sales
// per page reports group on these rows. Soft-delete only.

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
  args: {
    name: v.string(),
    type: channelType,
  },
  returns: salesChannelDoc,
  handler: async (ctx, args) => {
    await requireUser(ctx);
    const name = cleanName(args.name);
    const id = await ctx.db.insert("salesChannels", {
      name,
      nameLower: name.toLowerCase(),
      type: args.type,
      active: true,
    });
    return (await ctx.db.get(id))!;
  },
});

// Rename, change type, soft-delete. Nothing is ever hard-deleted.
export const update = mutation({
  args: {
    channelId: v.id("salesChannels"),
    name: v.string(),
    type: channelType,
    active: v.boolean(),
  },
  returns: salesChannelDoc,
  handler: async (ctx, args) => {
    await requireUser(ctx);
    const existing = await ctx.db.get(args.channelId);
    if (!existing) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Channel not found." });
    }
    // Soft-delete flips are owner-only; normal edits stay open to staff.
    if (existing.active !== args.active) await requireOwner(ctx);
    const name = cleanName(args.name);
    await ctx.db.patch(args.channelId, {
      name,
      nameLower: name.toLowerCase(),
      type: args.type,
      active: args.active,
    });
    return (await ctx.db.get(args.channelId))!;
  },
});

// One channel by id — null (not an error) while the edit page loads.
export const get = query({
  args: { channelId: v.id("salesChannels") },
  returns: v.union(salesChannelDoc, v.null()),
  handler: async (ctx, args) => {
    await requireUser(ctx);
    return await ctx.db.get(args.channelId);
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
    page: v.array(salesChannelDoc),
    continueCursor: v.string(),
    total: v.number(),
  }),
  handler: async (ctx, args) => {
    await requireUser(ctx);
    const term = args.search?.trim().toLowerCase() ?? "";
    // Query builders are single-use — a factory keeps page + total separate.
    const build = () =>
      ctx.db.query("salesChannels").withIndex("by_nameLower", (q) =>
        term ? q.gte("nameLower", term).lt("nameLower", `${term}￿`) : q
      );
    const page = await build().order("asc").paginate(args.paginationOpts);
    const total = (await build().take(1000)).length;
    return { page: page.page, continueCursor: page.isDone ? "" : page.continueCursor, total };
  },
});

// All active channels for the POS checkout picker — the shop has 3–4 pages,
// so a capped take is plenty. Deactivated pages disappear from new sales.
export const listActive = query({
  args: {},
  returns: v.array(salesChannelDoc),
  handler: async (ctx) => {
    await requireUser(ctx);
    const rows = await ctx.db
      .query("salesChannels")
      .withIndex("by_nameLower")
      .order("asc")
      .take(100);
    return rows.filter((c) => c.active);
  },
});
