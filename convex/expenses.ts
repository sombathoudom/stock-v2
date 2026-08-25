import { paginationOptsValidator } from "convex/server";
import { ConvexError, v } from "convex/values";

import { mutation, query } from "./_generated/server";
import { assertCents, dayString, getShop, requireUser } from "./helpers";
import { expenseDoc } from "./types";

// T18 — expenses (AGENTS.md rule #7: expenses are first-class). Every spend
// is a row; daily P/L subtracts the rows whose spentDay matches the report
// day (cash basis, indexed — reports never scan). There is no delete: an
// expense is a financial record and the day's numbers must never silently
// change — mistakes are fixed by editing the row. Category text is snapshotted
// on the expense so reports and old records survive category changes.

const MIN_SPENT_AT = Date.parse("2000-01-01T00:00:00Z");
const MAX_SPENT_AT = Date.parse("2100-01-01T00:00:00Z");

function cleanCategory(category: string): string {
  const trimmed = category.trim();
  if (!trimmed || trimmed.length > 100) {
    throw new ConvexError({
      code: "INVALID_INPUT",
      message: "Category must be 1–100 characters.",
    });
  }
  return trimmed;
}

/** Spent day must be a real, sane date — it lands in the daily report. */
function cleanSpentAt(spentAt: number): number {
  if (!Number.isFinite(spentAt) || spentAt < MIN_SPENT_AT || spentAt > MAX_SPENT_AT) {
    throw new ConvexError({ code: "INVALID_INPUT", message: "Please pick a valid date." });
  }
  return spentAt;
}

function cleanNote(note: string | undefined): string | undefined {
  const trimmed = note?.trim();
  return trimmed ? trimmed.slice(0, 500) : undefined;
}

export const create = mutation({
  args: {
    amount: v.number(),
    category: v.string(),
    spentAt: v.number(),
    note: v.optional(v.string()),
  },
  returns: expenseDoc,
  handler: async (ctx, args) => {
    const { staff } = await requireUser(ctx);
    const shop = await getShop(ctx);
    const amount = assertCents(args.amount, "amount");
    if (amount <= 0) {
      throw new ConvexError({ code: "INVALID_MONEY", message: "Amount must be more than zero." });
    }
    const category = cleanCategory(args.category);
    const spentAt = cleanSpentAt(args.spentAt);
    const id = await ctx.db.insert("expenses", {
      amount,
      category,
      categoryLower: category.toLowerCase(),
      spentAt,
      spentDay: dayString(spentAt, shop.timezone),
      note: cleanNote(args.note),
      userId: staff._id,
    });
    return (await ctx.db.get(id))!;
  },
});

// Edit any field; spentDay recomputes from the new date so the row lands in
// the right daily report. No delete — fix by editing.
export const update = mutation({
  args: {
    expenseId: v.id("expenses"),
    amount: v.number(),
    category: v.string(),
    spentAt: v.number(),
    note: v.optional(v.string()),
  },
  returns: expenseDoc,
  handler: async (ctx, args) => {
    const { staff } = await requireUser(ctx);
    const shop = await getShop(ctx);
    const existing = await ctx.db.get(args.expenseId);
    if (!existing) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Expense not found." });
    }
    const amount = assertCents(args.amount, "amount");
    if (amount <= 0) {
      throw new ConvexError({ code: "INVALID_MONEY", message: "Amount must be more than zero." });
    }
    const category = cleanCategory(args.category);
    const spentAt = cleanSpentAt(args.spentAt);
    await ctx.db.patch(args.expenseId, {
      amount,
      category,
      categoryLower: category.toLowerCase(),
      spentAt,
      spentDay: dayString(spentAt, shop.timezone),
      note: cleanNote(args.note),
      userId: staff._id,
    });
    return (await ctx.db.get(args.expenseId))!;
  },
});

// One expense by id — null (not an error) while the edit page loads.
export const get = query({
  args: { expenseId: v.id("expenses") },
  returns: v.union(expenseDoc, v.null()),
  handler: async (ctx, args) => {
    await requireUser(ctx);
    return await ctx.db.get(args.expenseId);
  },
});

// Paginated list, newest day first. The optional search is a case-insensitive
// PREFIX match on the indexed categoryLower column — index-driven, never a
// scan. todayTotal feeds the page header: what left the shop today.
export const list = query({
  args: {
    paginationOpts: paginationOptsValidator,
    search: v.optional(v.string()),
  },
  returns: v.object({
    page: v.array(expenseDoc),
    continueCursor: v.string(),
    total: v.number(),
    todayTotal: v.number(),
  }),
  handler: async (ctx, args) => {
    await requireUser(ctx);
    const shop = await getShop(ctx);
    const term = args.search?.trim().toLowerCase() ?? "";
    // Query builders are single-use — a factory keeps page + total separate.
    const build = () =>
      term
        ? ctx.db.query("expenses").withIndex("by_categoryLower", (q) =>
            q.gte("categoryLower", term).lt("categoryLower", `${term}￿`)
          )
        : ctx.db.query("expenses").withIndex("by_spentDay").order("desc");
    const page = await build().paginate(args.paginationOpts);
    const total = (await build().take(1000)).length;
    const today = dayString(Date.now(), shop.timezone);
    const todayRows = await ctx.db
      .query("expenses")
      .withIndex("by_spentDay", (q) => q.eq("spentDay", today))
      .collect();
    const todayTotal = todayRows.reduce((sum, row) => sum + row.amount, 0);
    return {
      page: page.page,
      continueCursor: page.isDone ? "" : page.continueCursor,
      total,
      todayTotal,
    };
  },
});

// Category suggestions for the form: every category the owner has used,
// most recent first. Bounded to recent rows — the list grows itself.
export const listCategories = query({
  args: {},
  returns: v.array(v.string()),
  handler: async (ctx) => {
    await requireUser(ctx);
    const rows = await ctx.db
      .query("expenses")
      .withIndex("by_spentDay")
      .order("desc")
      .take(500);
    const seen = new Set<string>();
    const categories: string[] = [];
    for (const row of rows) {
      const key = row.category.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        categories.push(row.category);
      }
    }
    return categories;
  },
});
