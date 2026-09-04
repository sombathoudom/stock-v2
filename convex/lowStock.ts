import type { Infer } from "convex/values";
import { v } from "convex/values";

import type { Doc } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { query } from "./_generated/server";
import { requireUser } from "./helpers";
import { variantLabel } from "./sales";
import { stockInfoByVariant } from "./stock";
import { lowStockItem } from "./types";

// T23 — Low-stock alerts (AGENTS.md). ONE shared walk computes every variant
// whose ledger sum is at or below the shop's reorder level. The dashboard
// card, the stock page's reorder list and the nav badge all read from it —
// a single source of truth for "what needs reordering". Stock is a ledger
// sum, never a stored number (rule #1).

/** The shop's low-stock walk: active products and their ACTIVE variants
 * (soft-deleted sizes never nag the owner) with computed stock at or below
 * the threshold, worst offenders first. Reads the ledger ONCE (batched by
 * variant) instead of one collect per variant — this walk runs on every page
 * via the nav badge, so the old N+1 got slow as the catalog grew. */
export async function collectLowStock(
  ctx: { db: QueryCtx["db"] },
  shop: Doc<"shop">
): Promise<{ threshold: number; items: Infer<typeof lowStockItem>[] }> {
  const threshold = shop.lowStockThreshold ?? 5;
  const [products, stockByVariant] = await Promise.all([
    ctx.db.query("products").withIndex("by_nameLower", (q) => q).take(1000),
    stockInfoByVariant(ctx),
  ]);
  const items: Infer<typeof lowStockItem>[] = [];
  for (const product of products) {
    if (!product.active) continue;
    const variants = await ctx.db
      .query("productVariants")
      .withIndex("by_product", (q) => q.eq("productId", product._id))
      .collect();
    for (const variant of variants) {
      if (!variant.active) continue;
      // No ledger rows = never moved = 0 on hand.
      const qty = stockByVariant.get(variant._id)?.qty ?? 0;
      if (qty <= threshold) {
        items.push({
          productId: product._id,
          productName: product.name,
          variantId: variant._id,
          label: variantLabel(product, variant),
          qty,
        });
      }
    }
  }
  items.sort((a, b) => a.qty - b.qty);
  return { threshold, items };
}

// Full reorder list: every low-stock variant with its label and computed
// stock, worst first — powers the stock page's alert card. Returns an empty
// list (never a NO_SHOP throw) before the owner finishes Settings — same
// fresh-signup handling as dashboard.overview.
export const lowStock = query({
  args: {},
  returns: v.object({
    threshold: v.number(),
    items: v.array(lowStockItem),
  }),
  handler: async (ctx) => {
    await requireUser(ctx);
    const shop = await ctx.db.query("shop").first();
    if (!shop) return { threshold: 0, items: [] };
    return collectLowStock(ctx, shop);
  },
});

// Just the count for the nav badge — same walk, same source of truth, so
// the badge can never disagree with the lists. The nav badge renders on
// EVERY page, including right after sign-up before the shop row exists, so
// it must never throw NO_SHOP — a count of 0 until Settings is done.
export const lowStockCount = query({
  args: {},
  returns: v.object({
    count: v.number(),
    threshold: v.number(),
  }),
  handler: async (ctx) => {
    await requireUser(ctx);
    const shop = await ctx.db.query("shop").first();
    if (!shop) return { count: 0, threshold: 0 };
    const { threshold, items } = await collectLowStock(ctx, shop);
    return { count: items.length, threshold };
  },
});
