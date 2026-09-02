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
  shopPhone?: string;
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

/** Paper width in characters (80mm, font A = 48 columns — full width). */
const WIDTH = 48;

/** Item-table columns: name left, qty, line subtotal flush right. */
const QTY_W = 5;
const SUBTOTAL_W = 14;
/** Right side of an item row: qty column + gap + subtotal column. */
const RIGHT_W = QTY_W + 1 + SUBTOTAL_W;
/** Name column — derived, so a row can NEVER exceed the paper width. */
const NAME_COL_W = WIDTH - RIGHT_W;

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

/** One item row as three columns — name left, qty, subtotal flush right.
 * Long names wrap onto their own lines under the name column. */
function itemRows(rawName: string, qty: string, lineTotal: string): string[] {
  const right = `${cutAt(sanitize(qty), QTY_W).padStart(QTY_W)} ${cutAt(
    sanitize(lineTotal),
    SUBTOTAL_W
  ).padStart(SUBTOTAL_W)}`;
  const lines = wrapLines(rawName, NAME_COL_W);
  const first = lines[0] ?? "";
  return [`${first.padEnd(NAME_COL_W)}${right}`, ...lines.slice(1)];
}

/** The item-table column header — same column math as itemRows, so Qty and
 * Total sit exactly above their values. */
function itemHeader(itemLabel: string, qtyLabel: string, totalLabel: string): string {
  return (
    `${cutAt(sanitize(itemLabel), NAME_COL_W).padEnd(NAME_COL_W)}` +
    `${cutAt(sanitize(qtyLabel), QTY_W).padStart(QTY_W)} ` +
    `${cutAt(sanitize(totalLabel), SUBTOTAL_W).padStart(SUBTOTAL_W)}`
  );
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
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(epochMs);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}`;
}

/** Symbols printers can draw (cp437 has $ but few other currency signs). */
const CURRENCY_SYMBOLS: Record<string, string> = { USD: "$" };

/** Money for the paper only — "$6.00" when the currency has a cp437 symbol,
 * otherwise a plain decimal followed by the code. */
function money(cents: number, currency: string): string {
  const symbol = CURRENCY_SYMBOLS[currency];
  return symbol
    ? `${symbol}${centsToDecimal(cents)}`
    : `${centsToDecimal(cents)} ${currency}`;
}

function variantLabel(size: string, color?: string): string {
  return color ? `${size} / ${color}` : size;
}

/** Phones are stored with their digits exactly as entered (leading trunk
 * zero kept), so paper shows them verbatim — no zero is added or removed. */
function phoneDisplay(phone: string): string {
  return phone.trim();
}

/** text() only APPENDS bytes — it never breaks the line. Every row must
 * call newline() explicitly, otherwise the next row runs on and the
 * printer re-wraps the overlong line, drifting every column. */
function row(enc: EscPosEncoder, text: string): void {
  enc.text(text).newline();
}

function freshEncoder(): EscPosEncoder {
  return new EscPosEncoder({ language: "esc-pos", codepage: "cp437", width: WIDTH });
}

// ---------------------------------------------------------------------------
// Document builders
// ---------------------------------------------------------------------------

/** "Label: value" — bold label, long values wrap under the label's indent.
 * Values the printer's font can't draw (Khmer…) go out as raster images. */
function labeledRow(
  enc: EscPosEncoder,
  label: string,
  value: string,
  boldValue: boolean = false
): void {
  const prefix = `${sanitize(label)}: `;
  if (needsRaster(value)) {
    const measure = document.createElement("canvas");
    measure.width = CANVAS_W;
    measure.height = RASTER_LINE_H;
    const ctx = measure.getContext("2d");
    if (ctx) {
      ctx.font = `${boldValue ? "bold " : ""}${RASTER_FONT_PX}px ${RASTER_FONT}`;
      const prefixDots = ctx.measureText(prefix).width;
      const lines = rasterWrap(ctx, value, CANVAS_W - prefixDots);
      rasterRow(enc, `${prefix}${lines[0] ?? ""}`, boldValue, 0);
      for (const extra of lines.slice(1)) rasterRow(enc, extra, boldValue, 0);
      return;
    }
  }
  const lines = wrapLines(value, WIDTH - prefix.length);
  enc.bold(true).text(prefix).bold(false);
  if (boldValue) enc.bold(true);
  enc.text(lines[0] ?? "").newline();
  for (const extra of lines.slice(1)) {
    row(enc, extra);
  }
  enc.bold(false);
}

/** One standalone row — raster when the script needs it, else font text. */
function printRow(
  enc: EscPosEncoder,
  text: string,
  options: { align?: "left" | "center"; bold?: boolean } = {}
): void {
  const bold = options.bold ?? false;
  const center = options.align === "center";
  if (needsRaster(text)) {
    const measure = document.createElement("canvas");
    measure.width = CANVAS_W;
    measure.height = RASTER_LINE_H;
    const ctx = measure.getContext("2d");
    if (!ctx) return;
    ctx.font = `${bold ? "bold " : ""}${RASTER_FONT_PX}px ${RASTER_FONT}`;
    const textDots = Math.min(ctx.measureText(text).width, CANVAS_W);
    const x = center ? Math.max(0, Math.floor((CANVAS_W - textDots) / 2)) : 0;
    rasterRow(enc, text, bold, x);
    return;
  }
  if (bold) enc.bold(true);
  row(enc, center ? centerText(text) : cutAt(sanitize(text), WIDTH));
  if (bold) enc.bold(false);
}

/** Centered text (align() can't be reset mid-line — pad manually). */
function centerText(text: string): string {
  const line = cutAt(sanitize(text), WIDTH);
  const pad = Math.max(0, Math.floor((WIDTH - line.length) / 2));
  return `${" ".repeat(pad)}${line}`;
}

// ---------------------------------------------------------------------------
// Khmer (and any non-cp437 script) as raster images
//
// The printer's font ROM only carries the cp437 Latin tables, so Khmer text
// can never be drawn by the printer itself — it prints as "?". The browser,
// however, renders Khmer perfectly (Windows ships Khmer fonts). So rows that
// contain non-Latin characters are drawn on a canvas and sent as a monochrome
// ESC/POS raster image (GS v 0) instead of text.
// ---------------------------------------------------------------------------

/** 80mm print head: 48 columns x 12 dots. */
const CANVAS_W = 576;
/** Effective printed glyph height in dots (a touch over font A's cap height
 * so Khmer stays readable at the same tight 24-dot line spacing). */
const RASTER_FONT_PX = 24;
const RASTER_FONT =
  '"Khmer OS","Khmer OS System","Leelawadee UI","Khmer UI","Noto Sans Khmer",sans-serif';
/** Output line height in dots — MUST be a multiple of 8 (raster mode packs
 * pixels 8-per-byte per row). 24 = exactly one font-A line, same as English. */
const RASTER_LINE_H = 24;
/** Supersampling factor — draw at 2x, downsample for crisp 1-bit dots. */
const RASTER_SCALE = 2;

/** True when the text has characters the printer's cp437 font cannot draw. */
function needsRaster(text: string): boolean {
  for (const ch of text) {
    if (ch === " " || ch in REPLACEMENTS) continue;
    const code = ch.codePointAt(0) ?? 0;
    if (!((code >= 32 && code <= 126) || (code >= 160 && code <= 255))) return true;
  }
  return false;
}

/** Downsample the 2x render to head resolution: a dot prints black when at
 * least one of its four samples was dark — keeps thin Khmer strokes connected
 * instead of breaking them up. */
function downsampleRaster(source: ImageData): ImageData {
  const out = new ImageData(CANVAS_W, RASTER_LINE_H);
  for (let y = 0; y < RASTER_LINE_H; y++) {
    for (let x = 0; x < CANVAS_W; x++) {
      let dark = 0;
      for (let dy = 0; dy < RASTER_SCALE; dy++) {
        for (let dx = 0; dx < RASTER_SCALE; dx++) {
          const si = ((y * RASTER_SCALE + dy) * CANVAS_W * RASTER_SCALE + (x * RASTER_SCALE + dx)) * 4;
          if (source.data[si + 3] >= 100) dark++;
        }
      }
      const oi = (y * CANVAS_W + x) * 4;
      const value = dark > 0 ? 0 : 255;
      out.data[oi] = value;
      out.data[oi + 1] = value;
      out.data[oi + 2] = value;
      out.data[oi + 3] = 255;
    }
  }
  return out;
}

/** Draw one line at 2x and return it at head resolution. */
function drawRasterLine(text: string, bold: boolean, xDots: number): ImageData | null {
  const canvas = document.createElement("canvas");
  canvas.width = CANVAS_W * RASTER_SCALE;
  canvas.height = RASTER_LINE_H * RASTER_SCALE;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.font = `${bold ? "bold " : ""}${RASTER_FONT_PX * RASTER_SCALE}px ${RASTER_FONT}`;
  ctx.textBaseline = "top";
  ctx.fillStyle = "#000";
  ctx.fillText(text, xDots * RASTER_SCALE, 1);
  return downsampleRaster(ctx.getImageData(0, 0, canvas.width, canvas.height));
}

/** Emit one raster row as raw GS v 0 bytes. Bypasses the composer on
 * purpose: enc.image() makes the composer squeeze a whole blank text line
 * between the image and whatever follows, while the GS v 0 command itself
 * feeds the paper by exactly the image height — so raw keeps Khmer rows as
 * tight as the Latin ones. Alignment is baked into the pixels. */
function rasterRow(enc: EscPosEncoder, text: string, bold: boolean, xDots: number): void {
  const image = drawRasterLine(text, bold, xDots);
  if (!image) return;
  const bytesPerRow = CANVAS_W >> 3;
  const payload: number[] = new Array(bytesPerRow * RASTER_LINE_H).fill(0);
  for (let y = 0; y < RASTER_LINE_H; y++) {
    for (let x = 0; x < CANVAS_W; x++) {
      // drawRasterLine leaves red=0 only on printed (black) dots
      if (image.data[(y * CANVAS_W + x) * 4] === 0) {
        payload[y * bytesPerRow + (x >> 3)] |= 0x80 >> (x & 7);
      }
    }
  }
  enc.raw([
    0x1d,
    0x76,
    0x30,
    0x00,
    bytesPerRow & 0xff,
    (bytesPerRow >> 8) & 0xff,
    RASTER_LINE_H & 0xff,
    (RASTER_LINE_H >> 8) & 0xff,
    ...payload,
  ]);
}

/** Wrap text to a pixel width, preferring spaces (Khmer addresses use them);
 * a single unbroken run is hard-split as a last resort. */
function rasterWrap(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  let line = "";
  const push = (part: string) => {
    if (part) lines.push(part);
  };
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const attempt = line ? `${line} ${word}` : word;
    if (ctx.measureText(attempt).width <= maxWidth) {
      line = attempt;
      continue;
    }
    push(line);
    line = "";
    let piece = "";
    for (const ch of word) {
      if (piece && ctx.measureText(piece + ch).width > maxWidth) {
        push(piece);
        piece = ch;
      } else {
        piece += ch;
      }
    }
    line = piece;
  }
  push(line);
  return lines.length > 0 ? lines : [""];
}

/** 80mm customer receipt — follows the shop's existing invoice paper:
 * centered shop name + INVOICE title, bold customer block,
 * Product/Qty/Total table, Discount/Delivery fee/Total/Paid, bold Status
 * line, thanks. */
export function buildReceiptBytes(doc: PrintSale): Uint8Array {
  const E = labels.en;
  const enc = freshEncoder();

  enc.initialize();
  printRow(enc, doc.shopName, { align: "center", bold: true });
  if (doc.shopPhone) {
    printRow(enc, `${E.sales.sender}: ${phoneDisplay(doc.shopPhone)}`, {
      align: "center",
    });
  }
  enc.align("center").bold(true);
  row(enc, E.sales.invoice.toUpperCase());
  enc.align("left").bold(false);

  labeledRow(enc, E.sales.invoice, doc.code);
  labeledRow(enc, E.common.date, formatDocDate(doc.createdAt, doc.timezone));
  labeledRow(enc, E.sales.customer, doc.customerName || "Walk-in", true);
  if (doc.customerPhone) labeledRow(enc, E.common.phone, phoneDisplay(doc.customerPhone), true);
  if (doc.customerAddress) labeledRow(enc, E.sales.location, doc.customerAddress, true);
  if (doc.companyName) labeledRow(enc, E.sales.delivery, doc.companyName, true);
  labeledRow(enc, E.sales.channel, doc.channelName);
  row(enc, SEPARATOR);
  row(enc, itemHeader(E.sales.item, E.sales.qty, E.sales.total));
  row(enc, SEPARATOR);

  for (const item of doc.items) {
    const label = `${item.name} - ${variantLabel(item.size, item.color)}`;
    const lineTotal = item.qty * item.unitPrice - (item.discount ?? 0);
    for (const line of itemRows(label, String(item.qty), money(lineTotal, doc.currency))) {
      row(enc, line);
    }
    if (item.discount) {
      row(enc, twoCol(`  ${E.sales.itemDiscount}`, `-${money(item.discount, doc.currency)}`));
    }
  }

  row(enc, SEPARATOR);
  row(enc, twoCol(E.sales.discount, money(doc.discount, doc.currency)));
  row(enc, twoCol(E.sales.deliveryFee, money(doc.deliveryFee, doc.currency)));
  enc.bold(true);
  row(enc, twoCol(E.sales.total, money(doc.total, doc.currency)));
  enc.bold(false);
  row(enc, twoCol(E.sales.paid, money(doc.paid, doc.currency)));
  row(enc, SEPARATOR);
  // Payment status at a glance: fully paid / nothing paid / something paid.
  const status =
    doc.remaining <= 0 ? E.sales.paid : doc.paid <= 0 ? E.sales.unpaid : E.sales.partial;
  enc.bold(true);
  row(enc, centerText(`${E.sales.status}: ${status.toUpperCase()}`));
  enc.bold(false);
  row(enc, SEPARATOR);

  enc.align("center").text(E.sales.thankyou).newline();
  // The gap between the print head and the cutter is several lines — anything
  // printed too close to the cut goes away with the clipped strip. Feed
  // enough blank lines that the footer stays safely behind the cut point.
  enc.newline(5);
  enc.cut();
  return enc.encode();
}

/** 80mm package label: order code + barcode, customer name / phone /
 * address, the items inside, and the delivery company it goes to. */
export function buildLabelBytes(doc: PrintSale): Uint8Array {
  const E = labels.en;
  const enc = freshEncoder();

  enc.initialize();
  printRow(enc, doc.shopName, { align: "center", bold: true });
  enc.align("center").bold(true).size("large").text(doc.code).newline();
  enc.size("normal").bold(false);
  enc.barcode(doc.code, "code128", { hri: "bottom", height: 48 });
  enc.newline();
  row(enc, SEPARATOR);

  labeledRow(enc, "Name", doc.customerName, true);
  labeledRow(enc, "Tel", phoneDisplay(doc.customerPhone), true);
  if (doc.customerAddress) labeledRow(enc, "Location", doc.customerAddress, false);

  row(enc, SEPARATOR);
  for (const item of doc.items) {
    const label = `${item.qty}x ${item.name} - ${variantLabel(item.size, item.color)}`;
    if (needsRaster(label)) {
      printRow(enc, label);
    } else {
      row(enc, cutAt(sanitize(label), WIDTH));
    }
  }
  if (doc.companyName) {
    row(enc, SEPARATOR);
    labeledRow(enc, E.sales.company, doc.companyName, true);
  }
  enc.align("center").newline().text(E.sales.thankyou).newline();
  enc.newline(5);
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
    // The ONLY place the chooser can appear — its NotAllowedError really
    // means the owner dismissed the prompt, so it alone maps to DENIED.
    device = await navigator.usb.requestDevice({
      filters: [{ vendorId: cfg.vendorId, productId: cfg.productId }],
    });
  }
  try {
    await device.open();
  } catch {
    // Pairing succeeded but Windows refused to hand the device over — its
    // own printer driver keeps it claimed. Not a permission problem.
    throw new Error(t().errors.PRINT_USB_BUSY);
  }
  try {
    let sent = false;
    // Don't assume configuration 1 / interface 0: many thermal printers
    // expose the printer class on another config or interface. Walk every
    // combination and use the first one that claims and has an OUT endpoint.
    for (const configuration of device.configurations) {
      if (sent) break;
      try {
        await device.selectConfiguration(configuration.configurationValue);
      } catch {
        continue;
      }
      for (const iface of configuration.interfaces) {
        const endpoint = iface.alternate.endpoints.find((ep) => ep.direction === "out");
        if (!endpoint) continue;
        try {
          await device.claimInterface(iface.interfaceNumber);
        } catch {
          continue; // OS driver holds this interface — try the next one
        }
        try {
          // Chunked writes — cheap USB printers cap single transfer sizes.
          for (let i = 0; i < bytes.length; i += 512) {
            await device.transferOut(endpoint.endpointNumber, bytes.subarray(i, i + 512));
          }
          // Let the printer drain its buffer before the interface is
          // released — closing too early can truncate the tail of the job
          // (the footer / thank-you line).
          await new Promise((resolve) => setTimeout(resolve, 150));
          sent = true;
        } finally {
          try {
            await device.releaseInterface(iface.interfaceNumber);
          } catch {
            // best effort — close() follows anyway
          }
        }
        if (sent) break;
      }
    }
    if (!sent) throw new Error(t().errors.PRINT_USB_BUSY);
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
