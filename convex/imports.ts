import { ConvexError, v } from "convex/values";

import { mutation } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { assertCents, ensureStaff, getShop } from "./helpers";

// Import mutations: bulk-create products and set opening stock from uploaded
// files. Both validate every row server-side — the frontend is never trusted.

// ---------------------------------------------------------------------------
// Import Products
// ---------------------------------------------------------------------------

export const importProducts = mutation({
  args: {
    rows: v.array(
      v.object({
        name: v.string(),
        category: v.optional(v.string()),
        defaultPrice: v.number(),
        defaultCost: v.number(),
        hasColors: v.boolean(),
        sizes: v.array(v.string()),
        colors: v.array(v.string()),
        description: v.optional(v.string()),
        code: v.optional(v.string()),
      }),
    ),
  },
  returns: v.object({
    created: v.number(),
    skipped: v.number(),
    errors: v.array(v.string()),
  }),
  handler: async (ctx, args) => {
    await ensureStaff(ctx);

    // Pre-load all categories for name lookup.
    const allCategories = await ctx.db.query("categories").collect();
    const categoryByName = new Map<string, Id<"categories">>();
    for (const cat of allCategories) {
      categoryByName.set(cat.nameLower, cat._id);
    }

    // Pre-load existing product names for dedupe.
    const existingProducts = await ctx.db
      .query("products")
      .withIndex("by_nameLower", (q) => q)
      .take(1000);
    const existingNames = new Set(
      existingProducts.map((p) => p.nameLower),
    );

    let created = 0;
    let skipped = 0;
    const errors: string[] = [];

    for (let i = 0; i < args.rows.length; i++) {
      const row = args.rows[i];
      const rowNum = i + 2;

      try {
        // Server-side validation.
        const name = row.name.trim();
        if (!name || name.length > 100) {
          skipped++;
          errors.push(`Row ${rowNum}: invalid product name`);
          continue;
        }
        if (row.sizes.length === 0 || row.sizes.length > 30) {
          skipped++;
          errors.push(`Row ${rowNum}: invalid sizes`);
          continue;
        }
        if (!Number.isFinite(row.defaultPrice) || !Number.isInteger(row.defaultPrice)) {
          skipped++;
          errors.push(`Row ${rowNum}: invalid price`);
          continue;
        }
        if (!Number.isFinite(row.defaultCost) || !Number.isInteger(row.defaultCost)) {
          skipped++;
          errors.push(`Row ${rowNum}: invalid cost`);
          continue;
        }

        const nameLower = name.toLowerCase();
        if (existingNames.has(nameLower)) {
          skipped++;
          errors.push(`Row ${rowNum}: "${name}" — duplicate, skipped`);
          continue;
        }

        const categoryId = row.category
          ? categoryByName.get(row.category.toLowerCase())
          : undefined;

        const productId = await ctx.db.insert("products", {
          name,
          nameLower,
          description: row.description?.trim() || undefined,
          code: row.code?.trim() || undefined,
          categoryId,
          defaultPrice: assertCents(row.defaultPrice, "price"),
          defaultCost: assertCents(row.defaultCost, "cost"),
          hasColors: row.hasColors,
          sizes: row.sizes.map((s) => s.trim()).filter(Boolean),
          colors: row.hasColors ? row.colors.map((s) => s.trim()).filter(Boolean) : [],
          active: true,
        });

        // Insert variants: one per size × color combo.
        const colorList = row.hasColors ? row.colors : [undefined];
        for (const size of row.sizes) {
          for (const color of colorList) {
            await ctx.db.insert("productVariants", {
              productId,
              size: size.trim(),
              color: color?.trim(),
              active: true,
            });
          }
        }

        existingNames.add(nameLower);
        created++;
      } catch {
        skipped++;
        errors.push(`Row ${rowNum}: "${row.name}" — import failed`);
      }
    }

    return { created, skipped, errors };
  },
});

// ---------------------------------------------------------------------------
// Opening Stock
// ---------------------------------------------------------------------------

/**
 * Set opening stock for existing variants. Looks up variants by product
 * name (case-insensitive) + size + color. Writes stockLedger rows with
 * reason "adjustment" and note "Opening stock".
 *
 * This is a net SET operation: it computes the delta needed to reach the
 * target quantity from the current stock. If a variant currently has 5
 * and the opening stock says 10, a +5 ledger row is written.
 */
export const importOpeningStock = mutation({
  args: {
    rows: v.array(
      v.object({
        productName: v.string(),
        size: v.string(),
        color: v.string(),
        qty: v.number(),
        note: v.optional(v.string()),
      }),
    ),
  },
  returns: v.object({
    count: v.number(),
    errors: v.array(v.string()),
  }),
  handler: async (ctx, args) => {
    const { staff } = await ensureStaff(ctx);
    const now = Date.now();

    // Pre-load all products for name lookup.
    const allProducts = await ctx.db
      .query("products")
      .withIndex("by_nameLower", (q) => q)
      .take(1000);
    const productByName = new Map(
      allProducts.map((p) => [p.nameLower, p._id] as const),
    );

    let count = 0;
    const errors: string[] = [];

    for (let i = 0; i < args.rows.length; i++) {
      const row = args.rows[i];
      const rowNum = i + 2;

      // Server-side validation.
      if (!row.productName.trim()) {
        errors.push(`Row ${rowNum}: missing product name`);
        continue;
      }
      if (!row.size.trim()) {
        errors.push(`Row ${rowNum}: missing size`);
        continue;
      }
      if (!Number.isFinite(row.qty) || row.qty < 0 || !Number.isInteger(row.qty)) {
        errors.push(`Row ${rowNum}: quantity must be a non-negative whole number`);
        continue;
      }

      const productId = productByName.get(row.productName.trim().toLowerCase());
      if (!productId) {
        errors.push(`Row ${rowNum}: "${row.productName}" — product not found`);
        continue;
      }

      // Find the matching variant.
      const variants = await ctx.db
        .query("productVariants")
        .withIndex("by_product", (q) => q.eq("productId", productId))
        .collect();

      const colorNorm = row.color.trim().toLowerCase();
      const sizeNorm = row.size.trim().toLowerCase();
      const variant = variants.find(
        (v) =>
          v.active &&
          v.size.trim().toLowerCase() === sizeNorm &&
          (v.color ?? "").trim().toLowerCase() === colorNorm,
      );

      if (!variant) {
        errors.push(
          `Row ${rowNum}: "${row.productName}" size "${row.size}"${row.color ? ` color "${row.color}"` : ""} — variant not found`,
        );
        continue;
      }

      // Compute current stock from the ledger.
      const ledgerRows = await ctx.db
        .query("stockLedger")
        .withIndex("by_variant_ts", (q) => q.eq("variantId", variant._id))
        .collect();
      const currentQty = ledgerRows.reduce((sum, r) => sum + r.delta, 0);

      // Write the delta to reach the target quantity.
      const delta = row.qty - currentQty;
      if (delta !== 0) {
        await ctx.db.insert("stockLedger", {
          variantId: variant._id,
          delta,
          reason: "adjustment",
          userId: staff._id,
          ts: now,
          note: row.note?.trim() || "Opening stock",
        });
      }
      count++;
    }

    return { count, errors };
  },
});
