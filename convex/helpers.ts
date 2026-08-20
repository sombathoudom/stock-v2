import { ConvexError } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { authComponent } from "./auth";

// Shared service helpers: auth, shop, money/qty validation, day buckets.
// Every function authenticates first — the client is never trusted.

// ---------------------------------------------------------------------------
// Input guards (addresses the "unchecked v.number()" class of bugs)
// ---------------------------------------------------------------------------

/** Money must be a finite integer number of cents within a sane range. */
export function assertCents(value: number, label = "amount"): number {
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    throw new ConvexError({ code: "INVALID_MONEY", message: `${label} must be whole cents.` });
  }
  if (Math.abs(value) > 1_000_000_000_00) {
    throw new ConvexError({ code: "INVALID_MONEY", message: `${label} is out of range.` });
  }
  return value;
}

/** Quantity: finite integer, 0 ≤ qty ≤ 1,000,000. */
export function assertQty(value: number, min = 0, label = "qty"): number {
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    throw new ConvexError({ code: "INVALID_QTY", message: `${label} must be a whole number.` });
  }
  if (value < min || value > 1_000_000) {
    throw new ConvexError({ code: "INVALID_QTY", message: `${label} is out of range.` });
  }
  return value;
}

/** Ledger delta: non-zero finite integer within a sane bound. */
export function assertDelta(value: number, label = "delta"): number {
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    throw new ConvexError({ code: "INVALID_DELTA", message: `${label} must be a whole number.` });
  }
  if (value === 0 || Math.abs(value) > 1_000_000) {
    throw new ConvexError({ code: "INVALID_DELTA", message: `${label} is out of range.` });
  }
  return value;
}

/** Integer cents → a readable money string for event summaries, e.g.
 * 125 → "$1.25". Money is only ever formatted for display — arithmetic
 * stays in cents everywhere. */
export function moneyStr(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}$${(abs / 100).toFixed(2)}`;
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

/** Query-side auth: signed in AND has a staff record. */
export async function requireUser(ctx: QueryCtx) {
  const authUser = await authComponent.safeGetAuthUser(ctx);
  if (!authUser) {
    throw new ConvexError({ code: "UNAUTHORIZED", message: "Please sign in." });
  }
  const staff = await ctx.db
    .query("users")
    .withIndex("by_authUserId", (q) => q.eq("authUserId", authUser._id))
    .first();
  if (!staff || !staff.active) {
    throw new ConvexError({ code: "NO_STAFF_RECORD", message: "No staff record for this account." });
  }
  return { authUser, staff };
}

/**
 * Mutation-side auth: signed in, staff record exists.
 * Auto-provisions on first sign-in: the first user becomes the owner,
 * everyone after becomes staff (the owner can change roles later).
 */
export async function ensureStaff(ctx: MutationCtx) {
  const authUser = await authComponent.safeGetAuthUser(ctx);
  if (!authUser) {
    throw new ConvexError({ code: "UNAUTHORIZED", message: "Please sign in." });
  }
  const existing = await ctx.db
    .query("users")
    .withIndex("by_authUserId", (q) => q.eq("authUserId", authUser._id))
    .first();
  if (existing) {
    if (!existing.active) {
      throw new ConvexError({ code: "NO_STAFF_RECORD", message: "This account is deactivated." });
    }
    return { authUser, staff: existing };
  }
  const anyUser = await ctx.db.query("users").first();
  const staffId = await ctx.db.insert("users", {
    authUserId: authUser._id,
    name: authUser.name || authUser.email.split("@")[0],
    email: authUser.email,
    role: anyUser ? "staff" : "owner",
    phone: undefined,
    active: true,
  });
  const staff = (await ctx.db.get(staffId))!;
  return { authUser, staff };
}

/** Owner-only actions. */
export async function requireOwner(ctx: MutationCtx) {
  const { authUser, staff } = await ensureStaff(ctx);
  if (staff.role !== "owner") {
    throw new ConvexError({ code: "FORBIDDEN", message: "Only the owner can do this." });
  }
  return { authUser, staff };
}

/** Owner-only actions (query side — no provisioning). */
export async function requireOwnerQuery(ctx: QueryCtx) {
  const { authUser, staff } = await requireUser(ctx);
  if (staff.role !== "owner") {
    throw new ConvexError({ code: "FORBIDDEN", message: "Only the owner can do this." });
  }
  return { authUser, staff };
}

// ---------------------------------------------------------------------------
// Shop
// ---------------------------------------------------------------------------

// Accepts both QueryCtx and MutationCtx (only db is touched) so mutations
// can derive shop-day codes like PO-20260815-001.
export async function getShop(ctx: { db: QueryCtx["db"] }): Promise<Doc<"shop">> {
  const shop = await ctx.db.query("shop").first();
  if (!shop) {
    throw new ConvexError({ code: "NO_SHOP", message: "Shop settings are not set up yet." });
  }
  return shop;
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

/** YYYY-MM-DD in the shop timezone (e.g. "2026-08-15"). */
export function dayString(ts: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(ts));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** Start-of-day (00:00 local) in shop tz, as epoch ms. */
export function startOfDay(ts: number, timeZone: string): number {
  const [y, m, d] = dayString(ts, timeZone).split("-").map(Number);
  // Probe noon UTC of that calendar day and read its wall-clock in the shop
  // tz via formatToParts (no locale-string parsing), then derive the offset.
  const probeUtc = Date.UTC(y, m - 1, d, 12, 0, 0);
  const wall = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(new Date(probeUtc));
  const part = (type: string) => Number(wall.find((p) => p.type === type)?.value ?? 0);
  // ICU may report "24" for midnight; normalize it.
  const hour = part("hour") % 24;
  const wallAsUtc = Date.UTC(y, m - 1, d, hour, part("minute"), part("second")) + (part("hour") === 24 ? 24 * 3600_000 : 0);
  let offset = wallAsUtc - probeUtc; // local − utc (may be off by ±24h on day rollover)
  while (offset > 14 * 3600_000) offset -= 24 * 3600_000; // true offsets are within ±14h
  while (offset < -14 * 3600_000) offset += 24 * 3600_000;
  return Date.UTC(y, m - 1, d) - offset;
}
