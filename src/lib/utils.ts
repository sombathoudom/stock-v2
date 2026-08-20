import { clsx, type ClassValue } from "clsx";
import { ConvexError } from "convex/values";
import { toast } from "sonner";
import { twMerge } from "tailwind-merge";

import { labels, type Language } from "@/config/labels";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// ---------------------------------------------------------------------------
// Ids
// ---------------------------------------------------------------------------

// Convex document ids are 32 base32 chars in Crockford's alphabet
// (0-9 a-z minus i, l, o, u). A malformed id makes the server reject the
// request and useQuery throw during render — detail pages check this before
// querying so a bad URL shows the not-found card instead of crashing.
const CONVEX_ID = /^[0-9a-hjkmnp-tv-z]{32}$/i;

export function isConvexId(value: string): boolean {
  return CONVEX_ID.test(value);
}

// ---------------------------------------------------------------------------
// Money & dates — display only. All storage is integer cents / epoch ms.
// ---------------------------------------------------------------------------

/** 1250 → "$12.50". Display-only: never feed the result back into the DB. */
export function formatMoney(cents: number, currency = "USD", lang: Language = "en") {
  return new Intl.NumberFormat(lang === "km" ? "km-KH" : "en-US", {
    style: "currency",
    currency,
  }).format(cents / 100);
}

/**
 * Money INPUT round-trips (display only in inputs; storage stays integer
 * cents). Parsing is string-based (split on "."), never floats.
 */

/** 1250 → "12.50"; null/undefined → "" (empty input, never "0"). */
export function centsToInput(cents: number | null | undefined): string {
  if (cents == null) return "";
  const whole = Math.floor(cents / 100);
  const frac = Math.abs(cents % 100);
  return `${whole}.${String(frac).padStart(2, "0")}`;
}

/** "12.50" → 1250; anything unparseable → null (form shows the field error). */
export function inputToCents(input: string): number | null {
  const [whole, frac = ""] = input.trim().split(".");
  if (!/^\d{1,9}$/.test(whole) || !/^\d{0,2}$/.test(frac)) return null;
  return Number(whole) * 100 + Number(frac.padEnd(2, "0"));
}

/** Public URL for a stored image (Convex file storage). */
export function imageUrl(storageId: string): string {
  // httpActions are served on the SITE port of the anonymous local
  // deployment (NEXT_PUBLIC_CONVEX_SITE_URL); on Convex Cloud that variable
  // is absent and the deployment URL serves everything.
  const base = process.env.NEXT_PUBLIC_CONVEX_SITE_URL ?? process.env.NEXT_PUBLIC_CONVEX_URL;
  return `${base}/api/getImage?storageId=${encodeURIComponent(storageId)}`;
}

/** 1250 → "12.50" (no symbol). */
export function formatAmount(cents: number, lang: Language = "en") {
  return new Intl.NumberFormat(lang === "km" ? "km-KH" : "en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(cents / 100);
}

// Intl.DateTimeFormat construction is expensive (~1ms); every table cell and
// movement row used to build one per render. One cached formatter per
// (lang, timezone) pair — the two inputs that affect the output.
const dateTimeFormatters = new Map<string, Intl.DateTimeFormat>();

export function formatDateTime(ts: number, timeZone = "Asia/Phnom_Penh", lang: Language = "en") {
  const key = `${lang}|${timeZone}`;
  let formatter = dateTimeFormatters.get(key);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat(lang === "km" ? "km-KH" : "en-US", {
      timeZone,
      dateStyle: "medium",
      timeStyle: "short",
    });
    dateTimeFormatters.set(key, formatter);
  }
  return formatter.format(new Date(ts));
}

// ---------------------------------------------------------------------------
// Language
// ---------------------------------------------------------------------------

// The language the SERVER renders with. Set by the root layout from the
// pos_lang cookie before any component renders, so the server HTML and the
// client's first render always agree (no hydration mismatch after a user
// switches language). Module state shared across requests is fine here: a
// wrong value only mislabels one page until the client re-renders.
let serverLang: Language = "en";

/**
 * Called once per request by the root layout with the pos_lang cookie.
 * ConvexClientProvider also calls it with the same value: client components
 * SSR in their own module graph, so their instance of this module needs its
 * own copy of the language or a Khmer page hydrates with English labels.
 */
export function setServerLang(lang: Language) {
  serverLang = lang;
}

export function getLang(): Language {
  if (typeof window === "undefined") return serverLang;
  try {
    const stored = window.localStorage.getItem("pos:lang");
    if (stored === "km" || stored === "en") return stored;
  } catch {
    // ignore
  }
  // localStorage empty (fresh device): fall back to the cookie the server
  // rendered with, so hydration still matches the HTML above the fold.
  try {
    const match = document.cookie.match(/(?:^|;\s*)pos_lang=([^;]+)/);
    if (match && (match[1] === "km" || match[1] === "en")) return match[1];
  } catch {
    // ignore
  }
  return "en";
}

export function setLang(lang: Language) {
  try {
    window.localStorage.setItem("pos:lang", lang);
  } catch {
    // ignore
  }
  // Keep the cookie in sync: it is what the server reads on the next
  // request, so a reload renders the same language it hydrates with.
  try {
    document.cookie = `pos_lang=${lang}; path=/; max-age=31536000; SameSite=Lax`;
  } catch {
    // ignore
  }
}

export function t() {
  return labels[getLang()];
}

// ---------------------------------------------------------------------------
// Errors — never silent; pop an alert via sonner toast, never raw stack traces.
// ---------------------------------------------------------------------------

function errorCodeOf(err: unknown): string {
  if (err instanceof ConvexError) {
    const data = err.data as { code?: string } | undefined;
    if (data?.code) return data.code;
  }
  return "GENERIC";
}

/** Map a thrown error to a short friendly message in the user's language. */
export function errorMessage(err: unknown): string {
  const lang = getLang();
  const code = errorCodeOf(err);
  const dict = labels[lang].errors;
  return code in dict ? dict[code as keyof typeof dict] : dict.GENERIC;
}

/** Popup alert for every unexpected failure (shadcn sonner toast). */
export function toastError(err: unknown) {
  // Log the full error for debugging; show the user only the friendly message.
  console.error(err);
  toast.error(errorMessage(err));
}

// ---------------------------------------------------------------------------
// T24 — File downloads (CSV export + JSON backup). Built client-side from
// server-derived rows; money arrives as integer cents and is converted to
// plain decimal here, so the files open cleanly in Excel / any editor.
// ---------------------------------------------------------------------------

/** Escape one CSV cell: quote when it contains a comma, quote or newline. */
function csvCell(value: string | number): string {
  const s = String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Trigger a browser download of a CSV file (UTF-8 BOM so Excel reads
 * Khmer text correctly). */
export function downloadCsv(filename: string, rows: (string | number)[][]) {
  const csv = "﻿" + rows.map((r) => r.map(csvCell).join(",")).join("\r\n");
  triggerDownload(filename, new Blob([csv], { type: "text/csv;charset=utf-8" }));
}

/** Trigger a browser download of a pretty-printed JSON file. */
export function downloadJson(filename: string, data: unknown) {
  triggerDownload(
    filename,
    new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }),
  );
}

function triggerDownload(filename: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** Integer cents → plain decimal string for CSV (never floats in storage;
 * floats only ever appear at this final formatting step). */
export function centsToDecimal(cents: number): string {
  return (cents / 100).toFixed(2);
}
