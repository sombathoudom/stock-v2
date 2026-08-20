"use client";

// T25 — Thermal printing (AGENTS.md): 80×80mm receipt + 80×80mm package
// label as ESC/POS bytes, sent to the printer three ways:
//   • webusb  — navigator.usb (Chrome/Edge, no extra software)
//   • qz_tray — the QZ Tray desktop app (USB / network / wireless printers)
//   • network — POST /api/print/raw; the server opens TCP to the printer's
//     LAN address read from the SHOP's saved settings (never from the
//     request — see route.ts).
// The A5 delivery invoice is NOT here: it prints through the browser print
// dialog (any OS printer) from the invoice dialog.
//
// Thermal paper rules: receipts and labels always print in ENGLISH with
// Latin digits — 80mm codepage fonts cannot render Khmer script, so every
// string is sanitized to the printer's cp437 character table first. All
// money is integer cents until the very last step (centsToDecimal).

import EscPosEncoder from "esc-pos-encoder";
import qz from "qz-tray";
import { toast } from "sonner";

import { labels } from "@/config/labels";

import { centsToDecimal, t } from "./utils";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Mirrors shop.printerConfig (convex/types.ts shopDoc). */
export interface ThermalConfig {
  type: "webusb" | "qz_tray" | "network";
  vendorId?: number;
  productId?: number;
  qzPrinterName?: string;
  qzCert?: string;
  networkHost?: string;
  networkPort?: number;
}

/** Flattened order data for a printed document — the caller maps a SaleDetail
 * to this shape (prices and totals are already server-derived, cents). */
export interface PrintSale {
  code: string;
  createdAt: number;
  timezone: string;
  currency: string;
  shopName: string;
  shopAddress?: string;
  customerName: string;
  customerPhone: string;
  customerAddress?: string;
  channelName: string;
  companyName?: string;
  subtotal: number;
  discount: number;
  deliveryFee: number;
  total: number;
  paid: number;
  remaining: number;
  items: {
    name: string;
    size: string;
    color?: string;
    qty: number;
    unitPrice: number;
    discount?: number;
  }[];
}

// ---------------------------------------------------------------------------
// Text preparation (cp437-safe, Latin only)
// ---------------------------------------------------------------------------

/** Paper width in characters (80mm, font A). */
const WIDTH = 42;

/** Map printable-but-missing glyphs to cp437-safe equivalents. */
const REPLACEMENTS: Record<string, string> = {
  "—": "-",
  "–": "-",
  "−": "-",
  "‑": "-",
  "…": "...",
  "×": "x",
  "•": "*",
  "“": '"',
  "”": '"',
  "‘": "'",
  "’": "'",
};

/** Keep only characters the printer's cp437 table can draw; everything else
 * becomes "?" — the printed page must never contain unreadable garbage. */
function sanitize(input: string): string {
  let out = "";
  for (const ch of input.replace(/\s+/g, " ").trim()) {
    if (ch in REPLACEMENTS) {
      out += REPLACEMENTS[ch];
      continue;
    }
    const code = ch.codePointAt(0) ?? 0;
    out += code >= 32 && code <= 126 ? ch : code >= 160 && code <= 255 ? ch : "?";
  }
  return out;
}

function cutAt(input: string, width: number): string {
  return input.length > width ? input.slice(0, width) : input;
}

/** One line split into two columns: left fixed, right pushed to the edge. */
function twoCol(left: string, right: string, width: number = WIDTH): string {
  const l = cutAt(left, width - 1 - Math.max(right.length, 1));
  const r = cutAt(right, width - 1 - l.length);
  return `${l}${" ".repeat(width - l.length - r.length)}${r}`;
}

/** Wrap long text (addresses) into chunks no wider than the paper. */
function wrapLines(input: string, width: number = WIDTH): string[] {
  const text = sanitize(input);
  if (text.length <= width) return text ? [text] : [];
  const lines: string[] = [];
  let rest = text;
  while (rest.length > width) {
    lines.push(rest.slice(0, width));
    rest = rest.slice(width);
  }
  if (rest) lines.push(rest);
  return lines;
}

const SEPARATOR = "-".repeat(WIDTH);

function formatDocDate(epochMs: number, timezone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(epochMs);
}

/** Money for the paper only — plain decimals, never locale digits. */
function money(cents: number, currency: string): string {
  return `${centsToDecimal(cents)} ${currency}`;
}

function variantLabel(size: string, color?: string): string {
  return color ? `${size} / ${color}` : size;
}

function freshEncoder(): EscPosEncoder {
  return new EscPosEncoder({ language: "esc-pos", codepage: "cp437", width: WIDTH });
}

// ---------------------------------------------------------------------------
// Document builders
// ---------------------------------------------------------------------------

/** 80mm customer receipt: shop header, order + customer, item lines,
 * totals, paid/remaining, thanks. Cut at the end. */
export function buildReceiptBytes(doc: PrintSale): Uint8Array {
  const E = labels.en;
  const enc = freshEncoder();

  enc.initialize();
  enc.align("center").bold(true).text(cutAt(sanitize(doc.shopName), WIDTH)).newline();
  if (doc.shopAddress) {
    enc.text(cutAt(sanitize(doc.shopAddress), WIDTH)).newline();
  }
  enc.bold(false).newline();

  enc.text(twoCol(doc.code, formatDocDate(doc.createdAt, doc.timezone)));
  enc.text(twoCol(`${E.sales.customer}: ${doc.customerName}`, doc.customerPhone));
  enc.text(twoCol(`${E.sales.channel}: ${doc.channelName}`, ""));
  enc.text(SEPARATOR);

  for (const item of doc.items) {
    const label = `${item.name} - ${variantLabel(item.size, item.color)}`;
    enc.text(cutAt(sanitize(label), WIDTH));
    const lineTotal = item.qty * item.unitPrice - (item.discount ?? 0);
    enc.text(
      twoCol(`  ${item.qty} x ${money(item.unitPrice, doc.currency)}`, money(lineTotal, doc.currency))
    );
    if (item.discount) {
      enc.text(twoCol(`    ${E.sales.itemDiscount}`, `-${money(item.discount, doc.currency)}`));
    }
  }

  enc.text(SEPARATOR);
  enc.text(twoCol(E.sales.subtotal, money(doc.subtotal, doc.currency)));
  if (doc.discount > 0) {
    enc.text(twoCol(E.sales.discount, `-${money(doc.discount, doc.currency)}`));
  }
  if (doc.deliveryFee > 0) {
    enc.text(twoCol(E.sales.deliveryFee, money(doc.deliveryFee, doc.currency)));
  }
  enc.bold(true).text(twoCol(E.sales.total, money(doc.total, doc.currency))).bold(false);
  enc.text(twoCol(E.sales.paid, money(doc.paid, doc.currency)));
  if (doc.remaining > 0) {
    enc.text(twoCol(E.sales.remaining, money(doc.remaining, doc.currency)));
  }

  enc.newline();
  enc.align("center").text(E.sales.thankyou).newline();
  enc.cut();
  return enc.encode();
}

/** 80mm package label: order code + barcode, customer name / phone /
 * address, the items inside, and the delivery company it goes to. */
export function buildLabelBytes(doc: PrintSale): Uint8Array {
  const E = labels.en;
  const enc = freshEncoder();

  enc.initialize();
  enc.align("center").bold(true).text(cutAt(sanitize(doc.shopName), WIDTH)).newline();
  enc.size("large").text(doc.code).newline();
  enc.size("normal").bold(false);
  enc.barcode(doc.code, "code128", { hri: "bottom", height: 48 });
  enc.text(SEPARATOR);

  enc.text(`Name: ${cutAt(sanitize(doc.customerName), WIDTH - 6)}`);
  enc.bold(true).text(`Tel:  ${cutAt(sanitize(doc.customerPhone), WIDTH - 6)}`).bold(false);
  for (const line of wrapLines(doc.customerAddress ?? "", WIDTH - 2)) {
    enc.text(`  ${line}`);
  }

  enc.text(SEPARATOR);
  for (const item of doc.items) {
    const label = `${item.qty}x ${item.name} - ${variantLabel(item.size, item.color)}`;
    enc.text(cutAt(sanitize(label), WIDTH));
  }
  if (doc.companyName) {
    enc.text(SEPARATOR);
    enc.text(twoCol(`${E.sales.company}:`, ""));
    enc.bold(true).text(cutAt(sanitize(doc.companyName), WIDTH)).bold(false);
  }
  enc.align("center").newline().text(E.sales.thankyou).newline();
  enc.cut();
  return enc.encode();
}

/** Small test page — proves the whole path works before a real sale. */
export function buildTestBytes(shopName: string): Uint8Array {
  const E = labels.en;
  const enc = freshEncoder();
  enc.initialize();
  enc.align("center").bold(true).text(cutAt(sanitize(shopName), WIDTH)).newline();
  enc.bold(false).text(E.settings.printTestOk).newline();
  enc.text(new Date().toLocaleString("en-GB", { hour12: false })).newline();
  enc.cut();
  return enc.encode();
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

/** Browser-side base64 (chunked — never overflows the string stack). */
function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

export function usbSupported(): boolean {
  return typeof navigator !== "undefined" && "usb" in navigator;
}

/** One-time USB pairing: lets the owner pick the printer, returns its ids
 * to save in the shop settings. Later prints reuse the granted permission. */
export async function scanUsbPrinter(): Promise<{ vendorId: number; productId: number }> {
  if (!usbSupported()) throw new Error(t().errors.PRINT_USB_UNSUPPORTED);
  const device = await navigator.usb.requestDevice({ filters: [] });
  return { vendorId: device.vendorId, productId: device.productId };
}

async function sendWebUsb(bytes: Uint8Array, cfg: ThermalConfig): Promise<void> {
  if (!usbSupported()) throw new Error(t().errors.PRINT_USB_UNSUPPORTED);
  if (cfg.vendorId == null || cfg.productId == null) {
    throw new Error(t().errors.PRINT_NO_USB_DEVICE);
  }
  const devices = await navigator.usb.getDevices();
  let device =
    devices.find((d) => d.vendorId === cfg.vendorId && d.productId === cfg.productId) ?? null;
  if (!device) {
    device = await navigator.usb.requestDevice({
      filters: [{ vendorId: cfg.vendorId, productId: cfg.productId }],
    });
  }
  await device.open();
  try {
    await device.selectConfiguration(1);
    await device.claimInterface(0);
    const endpoint = device.configuration?.interfaces[0]?.alternate.endpoints.find(
      (ep) => ep.direction === "out"
    );
    if (!endpoint) throw new Error(t().errors.PRINT_FAILED);
    // Chunked writes — cheap USB printers cap single transfer sizes.
    for (let i = 0; i < bytes.length; i += 512) {
      await device.transferOut(endpoint.endpointNumber, bytes.subarray(i, i + 512));
    }
  } finally {
    try {
      await device.close();
    } catch {
      // already closed — nothing to do
    }
  }
}

let qzSetup = false;
let qzCertUsed: string | null = null;

async function sendQzTray(bytes: Uint8Array, cfg: ThermalConfig): Promise<void> {
  if (!cfg.qzPrinterName || !cfg.qzCert) {
    throw new Error(t().errors.PRINT_QZ_CONFIG);
  }
  // Re-arm when the saved certificate changes mid-session (the owner pasted
  // a new one and tested again without reloading).
  if (!qzSetup || qzCertUsed !== cfg.qzCert) {
    qz.api.setPromiseType((resolve) => new Promise(resolve));
    qz.api.setWebSocketType(WebSocket);
    qz.security.setCertificatePromise((resolve) => resolve(cfg.qzCert!));
    qzSetup = true;
    qzCertUsed = cfg.qzCert;
  }
  if (!qz.websocket.isActive()) {
    await qz.websocket.connect({ retries: 1, delay: 0.5 });
  }
  const config = qz.configs.create(cfg.qzPrinterName, { raw: true });
  await qz.print(config, [
    { type: "raw", format: "base64", flavor: "base64", data: bytesToBase64(bytes) },
  ]);
}

async function sendNetwork(bytes: Uint8Array): Promise<void> {
  // The destination (host/port) is read server-side from the SHOP settings —
  // the client sends only bytes, so the endpoint can never be pointed
  // anywhere the owner did not configure.
  const res = await fetch("/api/print/raw", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ data: bytesToBase64(bytes) }),
  });
  if (!res.ok) {
    let message: string = t().errors.PRINT_FAILED;
    try {
      const body = (await res.json()) as { error?: unknown };
      if (typeof body.error === "string" && body.error) message = body.error;
    } catch {
      // keep the default message
    }
    throw new Error(message);
  }
}

/** Send ESC/POS bytes through the shop's configured printer. Throws Error
 * whose message is already friendly (see printErrorMessage). */
export async function sendThermal(bytes: Uint8Array, cfg: ThermalConfig): Promise<void> {
  try {
    if (cfg.type === "webusb") await sendWebUsb(bytes, cfg);
    else if (cfg.type === "qz_tray") await sendQzTray(bytes, cfg);
    else await sendNetwork(bytes);
  } catch (err) {
    throw new Error(printErrorMessage(err));
  }
}

/** Map browser / QZ / transport failures to plain-language messages.
 * Messages we (or the server) already wrote are passed through. */
export function printErrorMessage(err: unknown): string {
  const e = err as { message?: string; name?: string };
  const name = e?.name ?? "";
  const message = e?.message ?? "";
  const errs = t().errors;
  if (name === "NotFoundError") return errs.PRINT_NO_USB_DEVICE;
  if (name === "NotAllowedError" || name === "SecurityError") return errs.PRINT_USB_DENIED;
  if (/connect|websocket|ws:|net::/i.test(message)) return errs.PRINT_QZ_OFFLINE;
  if (/certificate|sign/i.test(message)) return errs.PRINT_QZ_CONFIG;
  if (message) return message;
  return errs.PRINT_FAILED;
}

// ---------------------------------------------------------------------------
// One-call helpers (build + send + toast on failure)
// ---------------------------------------------------------------------------

export function toastPrintError(err: unknown): void {
  toast.error(printErrorMessage(err));
}

export async function printReceiptDoc(
  doc: PrintSale,
  cfg: ThermalConfig | null | undefined
): Promise<void> {
  if (!cfg) throw new Error(t().errors.PRINT_NO_PRINTER);
  await sendThermal(buildReceiptBytes(doc), cfg);
}

export async function printLabelDoc(
  doc: PrintSale,
  cfg: ThermalConfig | null | undefined
): Promise<void> {
  if (!cfg) throw new Error(t().errors.PRINT_NO_PRINTER);
  await sendThermal(buildLabelBytes(doc), cfg);
}

export async function printTestDoc(
  shopName: string,
  cfg: ThermalConfig | null | undefined
): Promise<void> {
  if (!cfg) throw new Error(t().errors.PRINT_NO_PRINTER);
  await sendThermal(buildTestBytes(shopName), cfg);
}
