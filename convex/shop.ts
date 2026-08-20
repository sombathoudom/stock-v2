import { ConvexError, v } from "convex/values";

import { authComponent } from "./auth";
import { mutation, query } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { ensureWalkInCustomer } from "./customers";
import { requireOwner } from "./helpers";
import { shopDoc } from "./types";

// Single-row shop settings (AGENTS.md T1). The first owner seeds the default
// row (plus the universal "Walk-in" sales channel) via ensureDefaults; every
// report later reads currency/timezone from get().

const saveArgs = v.object({
  name: v.string(),
  currency: v.string(),
  timezone: v.string(),
  language: v.union(v.literal("en"), v.literal("km")),
  deliveryEnabled: v.boolean(),
  address: v.optional(v.string()),
  exchangeRate: v.number(),
  lowStockThreshold: v.optional(v.number()),
  // T25 — thermal printer setup (absent = no thermal printer configured).
  printerConfig: v.optional(
    v.object({
      type: v.union(v.literal("webusb"), v.literal("qz_tray"), v.literal("network")),
      vendorId: v.optional(v.number()),
      productId: v.optional(v.number()),
      qzPrinterName: v.optional(v.string()),
      qzCert: v.optional(v.string()),
      networkHost: v.optional(v.string()),
      networkPort: v.optional(v.number()),
    })
  ),
  // Preselected on the POS sale screen; unset falls back to the walk-in
  // customer. null clears it — absent leaves the current value untouched.
  defaultCustomerId: v.optional(v.union(v.id("customers"), v.null())),
});

/** Server-side validation — the client's Zod schema is UX only. */
function validate(input: {
  name: string;
  currency: string;
  timezone: string;
  language: "en" | "km";
  deliveryEnabled: boolean;
  address?: string;
  exchangeRate: number;
  lowStockThreshold?: number;
  printerConfig?: {
    type: "webusb" | "qz_tray" | "network";
    vendorId?: number;
    productId?: number;
    qzPrinterName?: string;
    qzCert?: string;
    networkHost?: string;
    networkPort?: number;
  };
}) {
  const invalid = (): never => {
    throw new ConvexError({ code: "INVALID_INPUT", message: "Check the form values." });
  };

  const name = input.name.trim();
  if (!name || name.length > 100) invalid();

  const currency = input.currency.trim().toUpperCase();
  if (!/^[A-Z]{1,8}$/.test(currency)) invalid();

  const timezone = input.timezone.trim();
  if (!timezone || timezone.length > 64) invalid();
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone });
  } catch {
    invalid(); // not a real IANA zone
  }

  if (
    !Number.isFinite(input.exchangeRate) ||
    input.exchangeRate <= 0 ||
    input.exchangeRate > 1_000_000
  ) {
    invalid();
  }

  let lowStockThreshold: number | undefined;
  if (input.lowStockThreshold !== undefined) {
    if (
      !Number.isInteger(input.lowStockThreshold) ||
      input.lowStockThreshold < 0 ||
      input.lowStockThreshold > 1_000_000
    ) {
      invalid();
    }
    lowStockThreshold = input.lowStockThreshold;
  }

  const address = input.address?.trim() ? input.address.trim().slice(0, 500) : undefined;

  // Printer config: only the fields the type needs; ids must be uint16,
  // port a sane TCP port, strings bounded so the row stays small.
  let printerConfig: typeof input.printerConfig;
  if (input.printerConfig) {
    const cfg = input.printerConfig;
    const vendorId = cfg.vendorId;
    const productId = cfg.productId;
    const networkPort = cfg.networkPort;
    if (
      (vendorId !== undefined &&
        (!Number.isInteger(vendorId) || vendorId < 0 || vendorId > 0xffff)) ||
      (productId !== undefined &&
        (!Number.isInteger(productId) || productId < 0 || productId > 0xffff)) ||
      (networkPort !== undefined &&
        (!Number.isInteger(networkPort) || networkPort < 1 || networkPort > 65535))
    ) {
      invalid();
    }
    printerConfig = {
      type: cfg.type,
      vendorId,
      productId,
      qzPrinterName: cfg.qzPrinterName?.trim().slice(0, 200) || undefined,
      qzCert: cfg.qzCert?.trim().slice(0, 20_000) || undefined,
      networkHost: cfg.networkHost?.trim().slice(0, 253) || undefined,
      networkPort,
    };
  }

  return {
    name,
    currency,
    timezone,
    language: input.language,
    deliveryEnabled: input.deliveryEnabled,
    address,
    exchangeRate: input.exchangeRate,
    lowStockThreshold,
    // Always present: Convex patch removes a field when its value is
    // undefined, so omitting it here would silently KEEP an old printer
    // config when the owner clears the printer.
    printerConfig,
  };
}

// Any signed-in staff member may read shop settings (reports need currency
// and timezone). Null — never a throw — when unauthenticated (auth-token
// race on fresh loads) or when no row exists yet.
export const get = query({
  args: {},
  returns: v.union(shopDoc, v.null()),
  handler: async (ctx) => {
    const authUser = await authComponent.safeGetAuthUser(ctx);
    if (!authUser) return null;
    return ctx.db.query("shop").first();
  },
});

// Idempotent first-run seed, called by the settings page when get() is null.
// The channel + customer seeds run even when the shop row already exists, so
// shops created before those seeds shipped still get them on the next visit.
export const ensureDefaults = mutation({
  args: {},
  returns: shopDoc,
  handler: async (ctx) => {
    await requireOwner(ctx);
    let shop = await ctx.db.query("shop").first();
    if (!shop) {
      const shopId = await ctx.db.insert("shop", {
        name: "My Shop",
        currency: "USD",
        exchangeRate: 1,
        timezone: "Asia/Phnom_Penh",
        deliveryEnabled: false,
        language: "en",
      });
      shop = (await ctx.db.get(shopId))!;
    }

    // Every sale needs a channel; walk-in is universal. The owner adds their
    // selling pages in T8 (channels CRUD).
    const walkIn = await ctx.db
      .query("salesChannels")
      .withIndex("by_nameLower", (q) => q.eq("nameLower", "walk-in"))
      .first();
    if (!walkIn) {
      await ctx.db.insert("salesChannels", {
        name: "Walk-in",
        nameLower: "walk-in",
        type: "walk_in",
        active: true,
      });
    }

    // The POS's default customer — see customers.ensureWalkInCustomer.
    await ensureWalkInCustomer(ctx);

    return shop;
  },
});

export const save = mutation({
  args: saveArgs,
  returns: shopDoc,
  handler: async (ctx, args) => {
    await requireOwner(ctx);
    const values = validate(args);

    // defaultCustomerId: absent = keep the current value, null = clear back
    // to the walk-in fallback, id = set (must be a real customer).
    let defaultCustomerId: Id<"customers"> | undefined | null;
    if (args.defaultCustomerId !== undefined) {
      const cid = args.defaultCustomerId;
      if (cid !== null && !(await ctx.db.get(cid))) {
        throw new ConvexError({ code: "NOT_FOUND", message: "Customer not found." });
      }
      defaultCustomerId = cid;
    }

    const existing = await ctx.db.query("shop").first();
    if (existing) {
      await ctx.db.patch(existing._id, {
        ...values,
        // undefined deletes the field (Convex patch semantics) — clearing the
        // default customer means "back to Walk-in Customer".
        ...(defaultCustomerId !== undefined ? { defaultCustomerId: defaultCustomerId ?? undefined } : {}),
      });
      return (await ctx.db.get(existing._id))!;
    }
    const id = await ctx.db.insert("shop", {
      ...values,
      ...(defaultCustomerId ? { defaultCustomerId } : {}),
    });
    return (await ctx.db.get(id))!;
  },
});
