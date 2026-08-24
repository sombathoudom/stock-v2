import {
  ConvexError,
  convexToJson,
  type JSONValue,
  type Value,
} from "convex/values";

import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";

export type IdempotencyOperation =
  | "sales.checkout"
  | "sales.saveEdit"
  | "purchases.create"
  | "payments.receive"
  | "payments.refund"
  | "adjustments.adjustStock";

export type IdempotencyResult = Doc<"idempotencyRecords">["result"];

function invalidKey(): never {
  throw new ConvexError({
    code: "INVALID_IDEMPOTENCY_KEY",
    message: "Idempotency key must be trimmed and contain 1 to 128 characters.",
  });
}

function conflict(): never {
  throw new ConvexError({
    code: "IDEMPOTENCY_CONFLICT",
    message: "This idempotency key was already used with different details.",
  });
}

function canonicalJson(value: JSONValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(",")}}`;
}

async function requestHash(payload: Value): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(convexToJson(payload)));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

export async function checkIdempotency(
  ctx: MutationCtx,
  userId: Id<"users">,
  operation: IdempotencyOperation,
  key: string,
  payload: Value
): Promise<{ hash: string; replay: IdempotencyResult | null }> {
  if (key.length === 0 || key.length > 128 || key !== key.trim()) invalidKey();
  const hash = await requestHash(payload);
  const existing = await ctx.db
    .query("idempotencyRecords")
    .withIndex("by_scope", (q) =>
      q.eq("userId", userId).eq("operation", operation).eq("key", key)
    )
    .unique();
  if (existing === null) return { hash, replay: null };
  if (existing.requestHash !== hash) conflict();
  return { hash, replay: existing.result };
}

export async function recordIdempotency(
  ctx: MutationCtx,
  userId: Id<"users">,
  operation: IdempotencyOperation,
  key: string,
  hash: string,
  result: IdempotencyResult
): Promise<void> {
  // Re-read the exact scope before insert; Convex OCC serializes competing keys.
  const existing = await ctx.db
    .query("idempotencyRecords")
    .withIndex("by_scope", (q) =>
      q.eq("userId", userId).eq("operation", operation).eq("key", key)
    )
    .unique();
  if (existing !== null) conflict();
  await ctx.db.insert("idempotencyRecords", {
    userId,
    operation,
    key,
    requestHash: hash,
    result,
    createdAt: Date.now(),
  });
}

export function replaySaleId(result: IdempotencyResult): Id<"sales"> {
  if (result.kind !== "sale") conflict();
  return result.id;
}

export function replayPurchaseId(result: IdempotencyResult): Id<"purchases"> {
  if (result.kind !== "purchase") conflict();
  return result.id;
}

export function replayPaymentId(result: IdempotencyResult): Id<"payments"> {
  if (result.kind !== "payment") conflict();
  return result.id;
}

export function replayStockLedgerId(result: IdempotencyResult): Id<"stockLedger"> {
  if (result.kind !== "stockLedger") conflict();
  return result.id;
}
