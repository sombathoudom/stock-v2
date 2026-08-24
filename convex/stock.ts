import { paginationOptsValidator } from "convex/server";
import type { Infer } from "convex/values";
import { ConvexError, v } from "convex/values";

import type { Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { query } from "./_generated/server";
import { getShop, requireUser } from "./helpers";
import { dayRange } from "./sales";
import { ledgerHistoryItem, ledgerRangeSummary, ledgerReason, stockCsvRow, stockListItem } from "./types";

// T6 — Stock (AGENTS.md). Stock is NEVER a stored number: every read here
// sums the immutable stockLedger rows (rule #1). The list walks the product
// name index (always indexed, always paginated); variant sums are one
// indexed eq-collect per variant, so the ledger table is never scanned.

/** {qty, lastMovementTs} for one variant from ONE ledger collect — stock is
 * the sum of deltas, lastMovementTs the newest business timestamp (undefined
 * when the variant never moved). The UI's "Last updated" / "Last movement"
 * is this stock-movement time: products and variants have no updatedAt
 * field, so a catalog edit without a movement doesn't show here. */
export async function variantStockInfo(
  ctx: { db: QueryCtx["db"] },
  variantId: Id<"productVariants">
): Promise<{ qty: number; lastMovementTs: number | undefined }> {
  const rows = await ctx.db
    .query("stockLedger")
    .withIndex("by_variant_ts", (q) => q.eq("variantId", variantId))
    .collect();
  let qty = 0;
  let lastMovementTs: number | undefined;
  for (const row of rows) {
    qty += row.delta;
    if (lastMovementTs === undefined || row.ts > lastMovementTs) {
      lastMovementTs = row.ts;
    }
  }
  return { qty, lastMovementTs };
}

/** Sum of a variant's ledger deltas — the only stock computation anywhere.
 * Shared with mutations (adjustments, lowStock) so the oversell re-check and
 * the stocktake comparison use the exact same math as every read. */
export async function variantQty(
  ctx: { db: QueryCtx["db"] },
  variantId: Id<"productVariants">
): Promise<number> {
  return (await variantStockInfo(ctx, variantId)).qty;
}

// Paginated stock list: rows are products (alphabetical, optional prefix
// search on the name index); each row carries every variant with its
// computed stock and newest movement time. Batched, indexed reads only.
export const list = query({
  args: {
    paginationOpts: paginationOptsValidator,
    search: v.optional(v.string()),
  },
  returns: v.object({
    page: v.array(stockListItem),
    continueCursor: v.string(),
    total: v.number(),
  }),
  handler: async (ctx, args) => {
    const { staff } = await requireUser(ctx);
    const showUnitCost = staff.role === "owner";
    const term = args.search?.trim().toLowerCase() ?? "";
    // Single-use query builders — a factory keeps page + total separate.
    const build = () =>
      ctx.db.query("products").withIndex("by_nameLower", (q) =>
        term ? q.gte("nameLower", term).lt("nameLower", `${term}￿`) : q
      );
    const page = await build().order("asc").paginate(args.paginationOpts);
    const total = (await build().take(1000)).length;

    const rows = await Promise.all(
      page.page.map(async (product) => {
        const variants = await ctx.db
          .query("productVariants")
          .withIndex("by_product", (q) => q.eq("productId", product._id))
          .collect();
        const withQty = await Promise.all(
          variants.map(async (variant) => {
            const { qty, lastMovementTs } = await variantStockInfo(
              ctx,
              variant._id
            );
            return {
              variant,
              qty,
              // Spread, not assignment: `undefined` fails Convex validators,
              // but an absent key is fine for an optional field.
              ...(lastMovementTs !== undefined ? { lastMovementTs } : {}),
            };
          })
        );
        return { product, variants: withQty };
      })
    );
    return { page: rows, continueCursor: page.isDone ? "" : page.continueCursor, total };
  },
});

// T24 — Stock CSV export: every active variant with its computed stock and
// effective sell price (variant override or product default). Bounded
// product walk, same as the list — the ledger table is never scanned.
export const stockCsv = query({
  args: {},
  returns: v.array(stockCsvRow),
  handler: async (ctx) => {
    await requireUser(ctx);
    const products = await ctx.db
      .query("products")
      .withIndex("by_nameLower", (q) => q)
      .take(1000);
    const out: Infer<typeof stockCsvRow>[] = [];
    for (const product of products) {
      if (!product.active) continue;
      const variants = await ctx.db
        .query("productVariants")
        .withIndex("by_product", (q) => q.eq("productId", product._id))
        .collect();
      for (const variant of variants) {
        if (!variant.active) continue;
        out.push({
          productName: product.name,
          size: variant.size,
          color: variant.color,
          sku: variant.sku,
          qty: await variantQty(ctx, variant._id),
          price: variant.price ?? product.defaultPrice,
        });
      }
    }
    return out;
  },
});

// One product with every variant and its computed stock — the detail page.
// null while loading / for an unknown id (the page shows "not found").
export const getProduct = query({
  args: { productId: v.id("products") },
  returns: v.union(stockListItem, v.null()),
  handler: async (ctx, args) => {
    const { staff } = await requireUser(ctx);
    const showUnitCost = staff.role === "owner";
    const product = await ctx.db.get(args.productId);
    if (!product) return null;
    const variants = await ctx.db
      .query("productVariants")
      .withIndex("by_product", (q) => q.eq("productId", args.productId))
      .collect();
    const withQty = await Promise.all(
      variants.map(async (variant) => {
        const { qty, lastMovementTs } = await variantStockInfo(ctx, variant._id);
        return {
          variant,
          qty,
          ...(lastMovementTs !== undefined ? { lastMovementTs } : {}),
        };
      })
    );
    return { product, variants: withQty };
  },
});

// One variant's full movement history, newest first, with the staff name who
// moved each row, the stock balance AFTER the movement, and the order/PO the
// row belongs to. "Where did this stock go?" is always answerable here.
// Filters: optional day strings (inclusive, shop-timezone day boundaries) and
// an optional movement reason. The collect is bounded at HISTORY_CAP rows
// (newest first) — past that, balances still stay exact (see below).
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const HISTORY_CAP = 1000;

/** The order or purchase a ledger row belongs to — structured so the client
 * localizes "Order #1042" / "PO #208" through the labels module and links
 * straight to the order/purchase detail (ids are the app's public route
 * keys — Convex UUIDs, never enumerable numbers). Also carries the customer
 * / channel / supplier names and, for purchases, the unit cost — the latter
 * only for owners (staff never see costs). Absent for adjustments,
 * stocktakes and rows without a linked document. */
async function variantReference(
  ctx: { db: QueryCtx["db"] },
  row: { saleItemId?: Id<"saleItems">; purchaseItemId?: Id<"purchaseItems"> },
  showUnitCost: boolean
): Promise<
  | {
      kind: "order" | "po";
      code: string;
      saleId?: Id<"sales">;
      purchaseId?: Id<"purchases">;
      customerName?: string;
      channelName?: string;
      supplierName?: string;
      unitCost?: number;
    }
  | undefined
> {
  if (row.saleItemId !== undefined) {
    const item = await ctx.db.get(row.saleItemId);
    if (item) {
      const sale = await ctx.db.get(item.saleId);
      if (sale) {
        const customer = sale.customerId
          ? await ctx.db.get(sale.customerId)
          : null;
        const channel = sale.salesChannelId
          ? await ctx.db.get(sale.salesChannelId)
          : null;
        return {
          kind: "order",
          code: sale.code,
          saleId: sale._id,
          ...(customer ? { customerName: customer.name } : {}),
          ...(channel ? { channelName: channel.name } : {}),
        };
      }
    }
  }
  if (row.purchaseItemId !== undefined) {
    const item = await ctx.db.get(row.purchaseItemId);
    if (item) {
      const purchase = await ctx.db.get(item.purchaseId);
      if (purchase) {
        const supplier = purchase.supplierId
          ? await ctx.db.get(purchase.supplierId)
          : null;
        return {
          kind: "po",
          code: purchase.code,
          purchaseId: purchase._id,
          ...(supplier ? { supplierName: supplier.name } : {}),
          ...(showUnitCost ? { unitCost: item.unitCost } : {}),
        };
      }
    }
  }
  return undefined;
}

export const variantHistory = query({
  args: {
    variantId: v.id("productVariants"),
    fromDay: v.optional(v.string()), // YYYY-MM-DD, inclusive (shop tz)
    toDay: v.optional(v.string()), // YYYY-MM-DD, inclusive
    reason: v.optional(ledgerReason),
    paginationOpts: paginationOptsValidator, // opaque "offset:N" cursor
  },
  returns: v.object({
    page: v.array(ledgerHistoryItem),
    continueCursor: v.string(),
    total: v.number(),
    // Range summary for the selected From/To window — derived from the
    // immutable ledger on every read, never stored.
    summary: ledgerRangeSummary,
  }),
  handler: async (ctx, args) => {
    const { staff } = await requireUser(ctx);
    const showUnitCost = staff.role === "owner";
    if (args.fromDay !== undefined && !DAY_RE.test(args.fromDay)) {
      throw new ConvexError({ code: "INVALID_INPUT", message: "Invalid day." });
    }
    if (args.toDay !== undefined && !DAY_RE.test(args.toDay)) {
      throw new ConvexError({ code: "INVALID_INPUT", message: "Invalid day." });
    }
    // Day strings → epoch ms through the shop-timezone day boundaries —
    // the same conversion the reports use, never client-side tz math.
    const shop = await getShop(ctx);
    const fromMs =
      args.fromDay !== undefined
        ? dayRange(args.fromDay, shop.timezone).from
        : undefined;
    const toMs =
      args.toDay !== undefined ? dayRange(args.toDay, shop.timezone).to : undefined;

    // Bounded newest-first collect. A variant with more than HISTORY_CAP
    // movements is pathological, but the math below stays honest either way.
    const all = await ctx.db
      .query("stockLedger")
      .withIndex("by_variant_ts", (q) => q.eq("variantId", args.variantId))
      .order("desc")
      .take(HISTORY_CAP);

    // Exact current stock: sum the collected rows; when the cap was hit,
    // fall back to the unbounded variantQty so balances never drift.
    const totalQty =
      all.length < HISTORY_CAP
        ? all.reduce((sum, row) => sum + row.delta, 0)
        : await variantQty(ctx, args.variantId);

    // Balance AFTER each movement, walking newest → oldest: the newest row's
    // balance is the current stock; each older row's is the current stock
    // minus every delta newer than it. Computed on the UNFILTERED walk, so
    // balances stay correct even when the date/reason filters hide rows.
    const balanceById = new Map<string, number>();
    let running = totalQty;
    for (const row of all) {
      balanceById.set(row._id, running);
      running -= row.delta;
    }

    const filtered = all.filter(
      (row) =>
        (fromMs === undefined || row.ts >= fromMs) &&
        (toMs === undefined || row.ts < toMs) &&
        (args.reason === undefined || row.reason === args.reason)
    );
    const total = filtered.length;

    // Range summary (spec formulas): opening = Σ deltas BEFORE the range
    // start (0 when no From filter — an explicit imported opening movement
    // would be the first `purchase` row); in/out = positive/negative sums
    // INSIDE the time window; closing = opening + in − out. With no filters
    // this reduces to closing = current ledger stock (in − out = Σ all).
    let opening = 0;
    if (fromMs !== undefined) {
      for (const row of all) {
        if (row.ts < fromMs) opening += row.delta;
      }
    }
    let stockIn = 0;
    let stockOut = 0;
    for (const row of all) {
      if (fromMs !== undefined && row.ts < fromMs) continue;
      if (toMs !== undefined && row.ts >= toMs) continue;
      if (row.delta > 0) stockIn += row.delta;
      else stockOut += -row.delta;
    }
    const summary = {
      opening,
      in: stockIn,
      out: stockOut,
      closing: opening + stockIn - stockOut,
    };

    // Filter first, then page by offset. Drift on concurrent inserts
    // self-corrects on the next filter change / reload (same trade-off the
    // POS size-filter path documents).
    const offset = args.paginationOpts.cursor
      ? Number(args.paginationOpts.cursor.replace(/^offset:/, "")) || 0
      : 0;
    const pageRows = filtered.slice(offset, offset + args.paginationOpts.numItems);
    const continueCursor =
      offset + pageRows.length < total ? `offset:${offset + pageRows.length}` : "";

    // Batched joins: staff names (dedup reads) + order/PO references.
    const userIds = [...new Set(pageRows.map((row) => row.userId))];
    const users = await Promise.all(userIds.map((id) => ctx.db.get(id)));
    const nameById = new Map(
      users.filter((u) => u !== null).map((u) => [u._id, u.name] as const)
    );

    const page = await Promise.all(
      pageRows.map(async (row) => {
        const reference = await variantReference(ctx, row, showUnitCost);
        return {
          row,
          userName: nameById.get(row.userId) ?? "—",
          balance: balanceById.get(row._id) ?? totalQty,
          ...(reference !== undefined ? { reference } : {}),
        };
      })
    );
    return { page, continueCursor, total, summary };
  },
});
