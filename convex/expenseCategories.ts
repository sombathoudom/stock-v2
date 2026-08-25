import { ConvexError, v } from "convex/values";

import { mutation, query } from "./_generated/server";
import { requireUser } from "./helpers";
import { expenseCategoryDoc } from "./types";

function cleanName(value: string): string {
  const name = value.trim();
  if (!name || name.length > 100) {
    throw new ConvexError({
      code: "INVALID_INPUT",
      message: "Category must be 1–100 characters.",
    });
  }
  return name;
}

export const create = mutation({
  args: { name: v.string() },
  returns: expenseCategoryDoc,
  handler: async (ctx, args) => {
    await requireUser(ctx);
    const name = cleanName(args.name);
    const nameLower = name.toLowerCase();
    const duplicate = await ctx.db
      .query("expenseCategories")
      .withIndex("by_nameLower", (q) => q.eq("nameLower", nameLower))
      .first();
    if (duplicate) {
      throw new ConvexError({
        code: "INVALID_INPUT",
        message: "This expense category already exists.",
      });
    }
    const categoryId = await ctx.db.insert("expenseCategories", {
      name,
      nameLower,
      active: true,
    });
    return (await ctx.db.get(categoryId))!;
  },
});

export const listActive = query({
  args: {},
  returns: v.array(expenseCategoryDoc),
  handler: async (ctx) => {
    await requireUser(ctx);
    const rows = await ctx.db.query("expenseCategories").withIndex("by_nameLower").collect();
    return rows.filter((row) => row.active);
  },
});
