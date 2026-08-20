import { v } from "convex/values";

import { query } from "./_generated/server";
import { requireOwnerQuery } from "./helpers";

// T24 — One-click full JSON backup (AGENTS.md "business data safety").
// Owner-only: a complete dump of every table is sensitive. Each table is
// read with take(MAX_ROWS + 1) — if the extra row exists, the table is
// marked `truncated` so the backup can NEVER be silently incomplete (the
// owner sees the flag instead of believing they have everything). Row
// schemas differ per table, so rows is the ONE documented v.any() cast in
// the codebase — a generic dump needs it.

const MAX_ROWS_PER_TABLE = 5000;

// Dependency order — parents before children, so a future restore can
// re-insert row by row without dangling references.
const TABLES = [
  "shop",
  "users",
  "categories",
  "salesChannels",
  "products",
  "productVariants",
  "suppliers",
  "deliveryCompanies",
  "purchases",
  "purchaseItems",
  "stockLedger",
  "customers",
  "sales",
  "saleItems",
  "payments",
  "expenses",
  "saleEvents",
] as const;

export const backupData = query({
  args: {},
  returns: v.object({
    exportedAt: v.number(),
    tables: v.array(
      v.object({
        name: v.string(),
        count: v.number(), // rows included in this backup
        truncated: v.boolean(), // true when the table has MORE rows than included
        rows: v.array(v.any()),
      })
    ),
  }),
  handler: async (ctx) => {
    await requireOwnerQuery(ctx);
    const tables = [];
    for (const name of TABLES) {
      // One query per table, bounded at MAX_ROWS + 1 so truncation is
      // detected exactly (not guessed).
      const fetched = await ctx.db.query(name).take(MAX_ROWS_PER_TABLE + 1);
      tables.push({
        name,
        count: Math.min(fetched.length, MAX_ROWS_PER_TABLE),
        truncated: fetched.length > MAX_ROWS_PER_TABLE,
        rows: fetched.slice(0, MAX_ROWS_PER_TABLE),
      });
    }
    return { exportedAt: Date.now(), tables };
  },
});
