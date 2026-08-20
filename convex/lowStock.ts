import type { Infer } from "convex/values";
import { v } from "convex/values";

import type { Doc } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { query } from "./_generated/server";
import { getShop, requireUser } from "./helpers";
import { variantLabel } from "./sales";
import { variantQty } from "./stock";
import { lowStockItem } from "./types";

// T23 — Low-stock alerts (AGENTS.md). ONE shared walk computes every variant
// whose ledger sum is at or below the shop's reorder level. The dashboard
// card, the stock page's reorder list and the nav badge all read from it —
// a single source of truth for "what needs reordering". Stock is a ledger
// sum, never a stored number (rule #1).

/** The shop's low-stock walk: active products and their ACTIVE variants
 * (soft-deleted sizes never nag the owner) with computed stock at or below
 * the threshold, worst offenders first. Bounded product walk; ledger sums
 * are one indexed eq-collect per variant — the ledger table is never
 * scanned. */
export async function collectLowStock(
  ctx: { db: QueryCtx["db"] },
  shop: Doc<"shop">
): Promise<{ threshold: number; items: Infer<typeof lowStockItem>[] }> {
  const threshold = shop.lowStockThreshold ?? 5;
  const products = await ctx.db
    .query("products")
    .withIndex("by_nameLower", (q) => q)
    .take(1000);
  const items: Infer<typeof lowStockItem>[] = [];
  for (const product of products) {
    if (!product.active) continue;
    const variants = await ctx.db
      .query("productVariants")
      .withIndex("by_product", (q) => q.eq("productId", product._id))
      .collect();
    for (const variant of variants) {
      if (!variant.active) continue;
      const qty = await variantQty(ctx, variant._id);
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
// stock, worst first — powers the stock page's alert card.
export const lowStock = query({
  args: {},
  returns: v.object({
    threshold: v.number(),
    items: v.array(lowStockItem),
  }),
  handler: async (ctx) => {
    await requireUser(ctx);
    const shop = await getShop(ctx);
    return collectLowStock(ctx, shop);
  },
});

// Just the count for the nav badge — same walk, same source of truth, so
// the badge can never disagree with the lists.
export const lowStockCount = query({
  args: {},
  returns: v.object({
    count: v.number(),
    threshold: v.number(),
  }),
  handler: async (ctx) => {
    await requireUser(ctx);
    const shop = await getShop(ctx);
    const { threshold, items } = await collectLowStock(ctx, shop);
    return { count: items.length, threshold };
  },
});
