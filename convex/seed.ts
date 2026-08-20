// DEV-ONLY deterministic test data — NOT for production use.
//
// Seeds a fixed catalog + received stock so the owner can test stock-tracking
// integrity ("stock is missing or not") against known, repeatable numbers:
//
//   - 1 supplier "Test Supplier", 1 category "Test Shirts"
//   - 100 products "Shirt 001".."Shirt 100" (codes SH-001..SH-100), hasColors
//     false, sizes M/L/XL/2XL/3XL, defaultPrice 600, defaultCost 214 cents,
//     ONE shared test image (fetched from picsum.photos once, stored once);
//     runSeedImages replaces it with 100 DISTINCT shirt photos (one per
//     product) so the POS grid doesn't show the same picture 100 times
//   - 5 variants per product (one per size), SKUs SH001-M .. SH100-3XL
//   - 10 received purchases (one per batch of 10 products), 50 lines each,
//     qty 10, unitCost 214 — stock lands EXCLUSIVELY via stockLedger rows
//     (reason "purchase", delta +10), never via a qty field.
//
// The public create/receive mutations (products.ts / purchases.ts) are
// auth-guarded by the better-auth component, which can't authenticate a call
// made from inside an action — so this file mirrors that logic minimally.
// The ledger invariant is preserved: every piece of stock enters through a
// stockLedger row owned by its purchaseItem, exactly like purchases.ts
// `receive` does. Never call this on a production deployment.
//
// Run: npx convex run seed:runSeed        (full catalog + stock seed)
//      npx convex run seed:runSeedImages  (distinct photo per seeded product)

import { ConvexError, v } from "convex/values";

import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";

const SIZES = ["M", "L", "XL", "2XL", "3XL"] as const;
const PRODUCT_COUNT = 100;
const BATCH_SIZE = 10;
const BATCH_COUNT = PRODUCT_COUNT / BATCH_SIZE;
const QTY_PER_VARIANT = 10;
const DEFAULT_PRICE = 600; // integer cents
const DEFAULT_COST = 214; // integer cents
const IMAGE_URL = "https://picsum.photos/seed/doly/600/800";

/** "SH-001".."SH-100" — display code only, never an access key. */
function productCode(number: number): string {
  return `SH-${String(number).padStart(3, "0")}`;
}

/** "SH001-M".."SH100-3XL". */
function variantSku(number: number, size: string): string {
  return `${productCode(number).replace("-", "")}-${size}`;
}

/** True when a product is one of the seeded ones ("Shirt NNN" + code
 * "SH-NNN", NNN = 001..100, matching exactly — a "Basic Tee" with a
 * coincidental code never matches). Returns the product's 1-based number,
 * or null when it isn't a seed product. */
function seededProductNumber(product: Doc<"products">): number | null {
  const m = /^SH-(\d{3})$/.exec(product.code ?? "");
  if (!m) return null;
  const n = Number(m[1]);
  if (n < 1 || n > PRODUCT_COUNT) return null;
  if (product.nameLower !== `shirt ${m[1]}`) return null;
  return n;
}

/** Purchase display code — PO-SEED-* never collides with the app's PO-YYYYMMDD- counter. */
function purchaseCode(batchIndex: number): string {
  return `PO-SEED-${String(batchIndex + 1).padStart(3, "0")}`;
}

// ---------------------------------------------------------------------------
// Guard — makes runSeed idempotent by refusing to re-seed
// ---------------------------------------------------------------------------

/** True when the seed has already run (its first product exists). */
export const hasSeedData = internalQuery({
  args: {},
  returns: v.boolean(),
  handler: async (ctx) => {
    return (
      (await ctx.db
        .query("products")
        .withIndex("by_nameLower", (q) => q.eq("nameLower", "shirt 001"))
        .first()) !== null
    );
  },
});

// ---------------------------------------------------------------------------
// Base rows: supplier, category, and a staff user for the ledger's userId
// ---------------------------------------------------------------------------

/** Creates (or reuses) the supplier + category, and picks an existing staff
 * user for the ledger's `userId` — creating one only if the app has none. */
export const ensureBase = internalMutation({
  args: {},
  returns: v.object({
    supplierId: v.id("suppliers"),
    categoryId: v.id("categories"),
    userId: v.id("users"),
  }),
  handler: async (ctx) => {
    const supplierName = "Test Supplier";
    const categoryName = "Test Shirts";

    let supplier = await ctx.db
      .query("suppliers")
      .withIndex("by_nameLower", (q) => q.eq("nameLower", supplierName.toLowerCase()))
      .first();
    if (!supplier) {
      const id = await ctx.db.insert("suppliers", {
        name: supplierName,
        nameLower: supplierName.toLowerCase(),
        phone: "000 000 000",
        active: true,
      });
      supplier = (await ctx.db.get(id))!;
    }

    let category = await ctx.db
      .query("categories")
      .withIndex("by_nameLower", (q) => q.eq("nameLower", categoryName.toLowerCase()))
      .first();
    if (!category) {
      const id = await ctx.db.insert("categories", {
        name: categoryName,
        nameLower: categoryName.toLowerCase(),
        active: true,
      });
      category = (await ctx.db.get(id))!;
    }

    // Every ledger row and purchase is signed with a staff id. Prefer an
    // existing user (any staff member — dev data only); fall back to a
    // clearly-marked seed user so this works on a fresh deployment too.
    let staff = await ctx.db.query("users").first();
    if (!staff) {
      const id = await ctx.db.insert("users", {
        authUserId: "seed-runner", // dev-only; never signs in
        name: "Seed Runner",
        email: "seed@dev.local",
        role: "owner",
        active: true,
      });
      staff = (await ctx.db.get(id))!;
    }

    return { supplierId: supplier._id, categoryId: category._id, userId: staff._id };
  },
});

// ---------------------------------------------------------------------------
// One batch: 10 products + 50 variants + 1 received purchase with 50 lines
// ---------------------------------------------------------------------------

type BatchArgs = {
  batchIndex: number;
  supplierId: Id<"suppliers">;
  categoryId: Id<"categories">;
  userId: Id<"users">;
  imageStorageId: Id<"_storage">;
};

/** Creates one batch of 10 products (5 variants each) and one received
 * purchase covering them — 50 ledger rows, delta +10 per variant. Mirrors
 * purchases.ts `receive` (one +qty stockLedger row per line, note referencing
 * the purchase code) and products.ts `insertVariants`. */
async function runBatch(ctx: MutationCtx, args: BatchArgs) {
  if (
    !Number.isInteger(args.batchIndex) ||
    args.batchIndex < 0 ||
    args.batchIndex >= BATCH_COUNT
  ) {
    throw new ConvexError({
      code: "INVALID_INPUT",
      message: `batchIndex must be an integer 0..${BATCH_COUNT - 1}.`,
    });
  }
  const start = args.batchIndex * BATCH_SIZE + 1; // 1-based product number
  const now = Date.now();
  const code = purchaseCode(args.batchIndex);

  // Products + variants (SKUs), same shape products.ts writes.
  const variantIds: Id<"productVariants">[] = [];
  for (let n = start; n < start + BATCH_SIZE; n++) {
    const name = `Shirt ${String(n).padStart(3, "0")}`;
    const productId = await ctx.db.insert("products", {
      name,
      nameLower: name.toLowerCase(),
      code: productCode(n),
      categoryId: args.categoryId,
      defaultPrice: DEFAULT_PRICE,
      defaultCost: DEFAULT_COST,
      hasColors: false,
      sizes: [...SIZES],
      colors: [],
      imageStorageId: args.imageStorageId,
      active: true,
    });
    for (const size of SIZES) {
      const variantId = await ctx.db.insert("productVariants", {
        productId,
        size,
        active: true,
        sku: variantSku(n, size),
      });
      variantIds.push(variantId);
    }
  }

  // Purchase, received immediately — stock enters ONLY through ledger rows.
  const purchaseId = await ctx.db.insert("purchases", {
    supplierId: args.supplierId,
    code,
    status: "received",
    purchasedAt: now,
    receivedAt: now,
    userId: args.userId,
    createdAt: now,
  });
  for (const variantId of variantIds) {
    const itemId = await ctx.db.insert("purchaseItems", {
      purchaseId,
      variantId,
      qty: QTY_PER_VARIANT,
      unitCost: DEFAULT_COST,
    });
    await ctx.db.insert("stockLedger", {
      variantId,
      delta: QTY_PER_VARIANT,
      reason: "purchase",
      purchaseItemId: itemId,
      userId: args.userId,
      ts: now,
      note: `Purchase ${code}`,
    });
  }

  return { products: BATCH_SIZE, variants: SIZES.length * BATCH_SIZE, lines: variantIds.length };
}

/** Seed batch #batchIndex (0..9). Internal only — runSeed drives it. */
export const createSeedBatch = internalMutation({
  args: {
    batchIndex: v.number(),
    supplierId: v.id("suppliers"),
    categoryId: v.id("categories"),
    userId: v.id("users"),
    imageStorageId: v.id("_storage"),
  },
  returns: v.object({
    products: v.number(),
    variants: v.number(),
    lines: v.number(),
  }),
  handler: async (ctx, args) => {
    const result = await runBatch(ctx, args);
    return {
      products: result.products,
      variants: result.variants,
      lines: result.lines,
    };
  },
});

// ---------------------------------------------------------------------------
// runSeed — the entry point: image once, then 10 batches via internal calls
// ---------------------------------------------------------------------------

type SeedResult = {
  supplierId: Id<"suppliers">;
  categoryId: Id<"categories">;
  imageStorageId: Id<"_storage">;
  products: number;
  variants: number;
  purchases: number;
  purchaseItems: number;
  ledgerRows: number;
};

export const runSeed = internalAction({
  args: {},
  returns: v.object({
    supplierId: v.id("suppliers"),
    categoryId: v.id("categories"),
    imageStorageId: v.id("_storage"),
    products: v.number(),
    variants: v.number(),
    purchases: v.number(),
    purchaseItems: v.number(),
    ledgerRows: v.number(),
  }),
  // Explicit return type: runSeed calls internal.seed.* in this same module,
  // and without an annotation TS infers the action's type through the
  // generated `api` namespace — which includes runSeed itself (TS7022 cycle).
  handler: async (ctx): Promise<SeedResult> => {
    // Idempotency guard FIRST — a second run must never duplicate data.
    if (await ctx.runQuery(internal.seed.hasSeedData)) {
      throw new ConvexError({
        code: "SEED_ALREADY_RUN",
        message:
          "Seed data already exists (product 'Shirt 001' found). runSeed never re-seeds — " +
          "delete the seeded rows first if you want to start over.",
      });
    }

    // Fetch the shared test image once, store once, reuse the id everywhere.
    const res = await fetch(IMAGE_URL);
    if (!res.ok) {
      throw new ConvexError({
        code: "SEED_IMAGE_FETCH_FAILED",
        message: `Could not fetch test image (${res.status}). Try again — nothing was seeded.`,
      });
    }
    const imageStorageId = await ctx.storage.store(new Blob([await res.arrayBuffer()]));

    const { supplierId, categoryId, userId } = await ctx.runMutation(internal.seed.ensureBase);

    let products = 0;
    let variants = 0;
    let purchaseItems = 0;
    let ledgerRows = 0;
    for (let batchIndex = 0; batchIndex < BATCH_COUNT; batchIndex++) {
      const batch = await ctx.runMutation(internal.seed.createSeedBatch, {
        batchIndex,
        supplierId,
        categoryId,
        userId,
        imageStorageId,
      });
      products += batch.products;
      variants += batch.variants;
      purchaseItems += batch.lines;
      ledgerRows += batch.lines; // one ledger row per purchase line
    }

    return {
      supplierId,
      categoryId,
      imageStorageId,
      products,
      variants,
      purchases: BATCH_COUNT,
      purchaseItems,
      ledgerRows,
    };
  },
});

// ---------------------------------------------------------------------------
// runSeedImages — dev-only: one DISTINCT shirt photo per seeded product
// ---------------------------------------------------------------------------
//
// runSeed stores ONE shared image on all 100 products; this replaces it with
// 100 different photos (picsum.photos/seed/doly-shirt-NNN — each seed value
// returns a fixed, distinct picture). Idempotent in effect: re-running just
// re-fetches and re-stores fresh photos over the seeded products. Only
// products matching the exact seed pattern (name "Shirt NNN" + code
// "SH-NNN") are ever touched — anything else in the catalog is left alone.

const IMAGES_PER_MUTATION = 20;

type SeedImagesResult = {
  products: number;
  distinctImages: number;
};

/** The seeded products, as (productId, 1-based number) pairs — matching only
 * name "Shirt NNN" AND code "SH-NNN", so non-seed products are never seen. */
export const listSeedProducts = internalQuery({
  args: {},
  returns: v.array(
    v.object({ productId: v.id("products"), number: v.number() })
  ),
  handler: async (ctx) => {
    const products = await ctx.db.query("products").take(1000);
    const seeded: { productId: Id<"products">; number: number }[] = [];
    for (const product of products) {
      const n = seededProductNumber(product);
      if (n !== null) seeded.push({ productId: product._id, number: n });
    }
    return seeded;
  },
});

/** Patches imageStorageId on the given products — one small batched write. */
export const setProductImages = internalMutation({
  args: {
    updates: v.array(
      v.object({
        productId: v.id("products"),
        imageStorageId: v.id("_storage"),
      })
    ),
  },
  returns: v.object({ updated: v.number() }),
  handler: async (ctx, args) => {
    for (const update of args.updates) {
      await ctx.db.patch(update.productId, { imageStorageId: update.imageStorageId });
    }
    return { updated: args.updates.length };
  },
});

export const runSeedImages = internalAction({
  args: {},
  returns: v.object({
    products: v.number(),
    distinctImages: v.number(),
  }),
  // Explicit return type (same TS7022 cycle guard as runSeed above).
  handler: async (ctx): Promise<SeedImagesResult> => {
    const seeded = await ctx.runQuery(internal.seed.listSeedProducts);
    const imageIds: Id<"_storage">[] = [];
    const updates: { productId: Id<"products">; imageStorageId: Id<"_storage"> }[] = [];
    let updated = 0;

    for (const { productId, number } of seeded) {
      const label = String(number).padStart(3, "0");
      const res = await fetch(`https://picsum.photos/seed/doly-shirt-${label}/600/800`);
      if (!res.ok) {
        throw new ConvexError({
          code: "SEED_IMAGE_FETCH_FAILED",
          message: `Could not fetch image for Shirt ${label} (${res.status}).`,
        });
      }
      const imageStorageId = await ctx.storage.store(new Blob([await res.arrayBuffer()]));
      imageIds.push(imageStorageId);
      updates.push({ productId, imageStorageId });

      if (updates.length === IMAGES_PER_MUTATION) {
        const result = await ctx.runMutation(internal.seed.setProductImages, { updates });
        updated += result.updated;
        updates.length = 0;
      }
    }
    if (updates.length > 0) {
      updated += (await ctx.runMutation(internal.seed.setProductImages, { updates })).updated;
    }

    return { products: updated, distinctImages: new Set(imageIds).size };
  },
});
