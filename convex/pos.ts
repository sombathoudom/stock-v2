import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";

import { query, type QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { requireUser } from "./helpers";
import { addableVariant, categoryDoc, posProduct, productDoc } from "./types";

// T10 — POS catalog reads (AGENTS.md). The product grid lists ACTIVE
// products (prefix search on the name index + size filter via the
// by_size_active variant index, always paginated); variant details with
// computed stock + effective price are fetched for a whole grid page in ONE
// batch query, so the ledger is never scanned at the list level.

// Cap for the size-filtered variant scan. The filter is approximate past this
// many active variants sharing one size — pathological for any real catalog.
// (Forcing a re-push after debug-log removal.)
const SIZE_SCAN_CAP = 1000;
// Cap for the size-chip list scan (products table, default order).
const LIST_CAP = 1000;

/** One product with its active variants, each with computed ledger stock and
 *  its effective sell price (variant override or product default). Shared by
 *  the single-product and whole-page queries. */
async function productWithVariants(ctx: QueryCtx, product: Doc<"products">) {
  const variants = await ctx.db
    .query("productVariants")
    .withIndex("by_product", (q) => q.eq("productId", product._id))
    .collect();
  const withInfo = await Promise.all(
    variants
      .filter((variant) => variant.active)
      .map(async (variant) => {
        const rows = await ctx.db
          .query("stockLedger")
          .withIndex("by_variant_ts", (q) => q.eq("variantId", variant._id))
          .collect();
        let stock = 0;
        for (const row of rows) stock += row.delta;
        return {
          variant,
          stock,
          price: variant.price ?? product.defaultPrice,
        };
      })
  );
  return { product, variants: withInfo };
}

// Paginated active products, alphabetical, optional case-insensitive prefix
// search and size filter — index-driven, never a scan.
export const searchProducts = query({
  args: {
    paginationOpts: paginationOptsValidator,
    search: v.optional(v.string()),
    size: v.optional(v.string()),
    categoryId: v.optional(v.id("categories")),
  },
  returns: v.object({
    page: v.array(productDoc),
    continueCursor: v.string(),
    total: v.number(),
  }),
  handler: async (ctx, args) => {
    await requireUser(ctx);
    const term = args.search?.trim().toLowerCase() ?? "";
    const categoryId = args.categoryId;
    if (!args.size) {
      // Query builders are single-use — a factory keeps page + total separate.
      // With a category, walk (categoryId, nameLower); without, nameLower only.
      const build = () =>
        categoryId
          ? ctx.db.query("products").withIndex("by_category_nameLower", (q) =>
              term
                ? q
                    .eq("categoryId", categoryId)
                    .gte("nameLower", term)
                    .lt("nameLower", `${term}￿`)
                : q.eq("categoryId", categoryId)
            )
          : ctx.db.query("products").withIndex("by_nameLower", (q) =>
              term ? q.gte("nameLower", term).lt("nameLower", `${term}￿`) : q
            );
      const page = await build().order("asc").paginate(args.paginationOpts);
      const total = (await build().take(1000)).length;
      return {
        page: page.page.filter((p) => p.active),
        continueCursor: page.isDone ? "" : page.continueCursor,
        total,
      };
    }
    // Size-filtered path: find products with at least one ACTIVE variant of
    // this size via the by_size_active index (bounded take — never a full
    // collect), then apply the name + category filters and paginate by offset
    // (carried in the paginationOpts cursor string). Sorted by (nameLower, _id)
    // server-side so pages never interleave across executions; offset drift
    // on concurrent inserts self-corrects on the next filter/search change.
    const size = args.size;
    const rows = await ctx.db
      .query("productVariants")
      .withIndex("by_size_active", (q) => q.eq("size", size).eq("active", true))
      .take(SIZE_SCAN_CAP);
    const ids = [...new Set(rows.map((r) => r.productId))];
    const docs = await Promise.all(ids.map((id) => ctx.db.get(id)));
    const filtered = docs
      .filter(
        (p): p is Doc<"products"> =>
          p !== null &&
          p.active &&
          (!term || p.nameLower.startsWith(term)) &&
          (!categoryId || p.categoryId === categoryId)
      )
      .sort(
        (a, b) =>
          a.nameLower.localeCompare(b.nameLower) || (a._id < b._id ? -1 : 1)
      );
    const offset = Number(args.paginationOpts.cursor) || 0;
    const page = filtered.slice(offset, offset + args.paginationOpts.numItems);
    const continueCursor =
      offset + page.length < filtered.length ? String(offset + page.length) : "";
    return { page, continueCursor, total: filtered.length };
  },
});

// Cap for the add-item picker: how many name-matched products and SKU-matched
// variants to walk, and how many rows the picker ever returns. Bounded takes —
// the picker is a search box, not a report.
const PICKER_PRODUCT_CAP = 12;
const PICKER_SKU_CAP = 20;
const PICKER_RESULT_CAP = 40;

// Flat variant search for the sale-edit add-item picker: one list of pieces,
// each ready to become a sale line. Matches a product-NAME prefix or a SKU
// prefix, so staff can type either. Both paths are index-driven and capped.
export const searchVariants = query({
  args: { search: v.optional(v.string()) },
  returns: v.array(addableVariant),
  handler: async (ctx, args) => {
    await requireUser(ctx);
    const raw = args.search?.trim() ?? "";
    const term = raw.toLowerCase();

    // Name path: active products whose name starts with the term.
    const products = await ctx.db
      .query("products")
      .withIndex("by_nameLower", (q) =>
        term ? q.gte("nameLower", term).lt("nameLower", `${term}￿`) : q
      )
      .take(PICKER_PRODUCT_CAP);

    const byProduct = new Map<Id<"products">, Doc<"products">>();
    for (const product of products) {
      if (product.active) byProduct.set(product._id, product);
    }

    // SKU path: a variant whose SKU starts with what was typed, even when its
    // product name doesn't match at all. Skipped on an empty search — the
    // by_sku index would otherwise walk every variant that has no SKU.
    const skuMatches: Doc<"productVariants">[] = [];
    if (raw) {
      const rows = await ctx.db
        .query("productVariants")
        .withIndex("by_sku", (q) => q.gte("sku", raw).lt("sku", `${raw}￿`))
        .take(PICKER_SKU_CAP);
      for (const row of rows) {
        if (!row.active) continue;
        skuMatches.push(row);
        if (!byProduct.has(row.productId)) {
          const product = await ctx.db.get(row.productId);
          if (product?.active) byProduct.set(product._id, product);
        }
      }
    }

    // Every active variant of every matched product, plus the SKU hits whose
    // product came in through the SKU path only.
    const seen = new Set<Id<"productVariants">>();
    const rows: { variant: Doc<"productVariants">; product: Doc<"products"> }[] = [];
    for (const product of byProduct.values()) {
      const variants = await ctx.db
        .query("productVariants")
        .withIndex("by_product", (q) => q.eq("productId", product._id))
        .collect();
      for (const variant of variants) {
        if (!variant.active || seen.has(variant._id)) continue;
        seen.add(variant._id);
        rows.push({ variant, product });
      }
    }
    for (const variant of skuMatches) {
      if (seen.has(variant._id)) continue;
      const product = byProduct.get(variant.productId);
      if (!product) continue;
      seen.add(variant._id);
      rows.push({ variant, product });
    }

    const capped = rows
      .sort(
        (a, b) =>
          a.product.nameLower.localeCompare(b.product.nameLower) ||
          a.variant.size.localeCompare(b.variant.size)
      )
      .slice(0, PICKER_RESULT_CAP);

    return await Promise.all(
      capped.map(async ({ variant, product }) => {
        const ledger = await ctx.db
          .query("stockLedger")
          .withIndex("by_variant_ts", (q) => q.eq("variantId", variant._id))
          .collect();
        let stock = 0;
        for (const row of ledger) stock += row.delta;
        return {
          variantId: variant._id,
          productId: product._id,
          productName: product.name,
          label: variant.color ? `${variant.size} · ${variant.color}` : variant.size,
          sku: variant.sku,
          stock,
          price: variant.price ?? product.defaultPrice,
          // Spread, not assignment: `imageStorageId: undefined` is an invalid
          // Convex value, but an absent key is fine for an optional field.
          ...(product.imageStorageId
            ? { imageStorageId: product.imageStorageId }
            : {}),
        };
      })
    );
  },
});

// One product with its active variants, each with computed ledger stock and
// its effective sell price (variant override or product default).
export const getVariants = query({
  args: { productId: v.id("products") },
  returns: v.union(posProduct, v.null()),
  handler: async (ctx, args) => {
    await requireUser(ctx);
    const product = await ctx.db.get(args.productId);
    if (!product) return null;
    return productWithVariants(ctx, product);
  },
});

// Variants for a whole grid page in ONE query — the grid renders every
// product's size/color chips + stock, so per-card queries would be N+1.
export const getVariantsForProducts = query({
  args: { productIds: v.array(v.id("products")) },
  returns: v.array(posProduct),
  handler: async (ctx, args) => {
    await requireUser(ctx);
    const ids = [...new Set(args.productIds)];
    const products = await Promise.all(ids.map((id) => ctx.db.get(id)));
    const out = [];
    for (const product of products) {
      if (!product) continue;
      out.push(await productWithVariants(ctx, product));
    }
    return out;
  },
});

// Every size in use by an active product — powers the grid's size-filter
// chips. Bounded scan; shop catalogs are small.

/**
 * Clothing-logical order for size tags: XS < S < M < L < XL < 2XL < 3XL…
 * (a plain alphabetical sort puts 2XL/3XL before L — wrong on a clothing
 * rack). Parse: leading digit count n, trailing X count, base letter
 * S/M/L (case-insensitive). For S/M bases the key is rank − X count
 * (XS sorts before S); for L it's rank + X count (XL after L, 2XL after
 * XL — a leading digit reads as that many X's, so "2XL" == "XXL"). Pure
 * letter sizes use their trailing X count. Numeric-only sizes ("40", "42")
 * come after the letter sizes, ascending numerically; unrecognized tags
 * sort last, alphabetically. Returns a sortable tuple [category, key, text].
 */
function sizeSortKey(size: string): [number, number, string] {
  const m = /^(\d*)\s*(X*)([SsMmLl])$/.exec(size.trim());
  if (m) {
    const base = m[3].toLowerCase();
    const rank = base === "s" ? 0 : base === "m" ? 1 : 2;
    const xCount = m[1] !== "" ? Number(m[1]) : m[2].length;
    const key = base === "l" ? rank + xCount : rank - xCount;
    return [0, key, size.trim().toLowerCase()];
  }
  if (/^\d+$/.test(size.trim())) return [1, Number(size.trim()), ""];
  return [2, 0, size.trim().toLowerCase()];
}

function byClothingOrder(a: string, b: string): number {
  const ka = sizeSortKey(a);
  const kb = sizeSortKey(b);
  return ka[0] - kb[0] || ka[1] - kb[1] || ka[2].localeCompare(kb[2]);
}

export const listSizes = query({
  args: {},
  returns: v.array(v.string()),
  handler: async (ctx) => {
    await requireUser(ctx);
    const products = await ctx.db.query("products").take(LIST_CAP);
    const sizes = new Set<string>();
    for (const product of products) {
      if (!product.active) continue;
      for (const size of product.sizes) sizes.add(size);
    }
    return [...sizes].sort(byClothingOrder);
  },
});

// Active categories for the grid's category filter. Bounded scan, sorted.
export const listCategories = query({
  args: {},
  returns: v.array(categoryDoc),
  handler: async (ctx) => {
    await requireUser(ctx);
    const rows = await ctx.db
      .query("categories")
      .withIndex("by_nameLower", (q) => q.gte("nameLower", ""))
      .order("asc")
      .take(LIST_CAP);
    return rows.filter((c) => c.active);
  },
});
