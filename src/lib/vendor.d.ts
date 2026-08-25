// T25 — Ambient type declarations for the two printing vendors (neither
// package ships TypeScript types). Both are declared with only the narrow
// API surface this app uses, so every call site is type-checked without
// hand-maintaining the full vendor surface.
//
// NOTE: this file must stay a plain global SCRIPT file (no top-level
// import/export and no `declare global` wrapper) — ambient `declare module`
// blocks only apply in scripts, and top-level interfaces merge into the
// global DOM types directly.

// WebUSB (W3C) — not in TS's lib.dom yet. Top-level declarations in a
// script file merge into the global scope.
interface Navigator {
  readonly usb: USB;
}

interface USB {
  requestDevice(options?: {
    filters?: { vendorId?: number; productId?: number }[];
  }): Promise<USBDevice>;
  getDevices(): Promise<USBDevice[]>;
}

interface USBDevice {
  readonly vendorId: number;
  readonly productId: number;
  /** The configuration currently selected by the OS (undefined before open). */
  readonly configuration: USBConfiguration | undefined;
  /** Every configuration the device exposes — printers may not use #1. */
  readonly configurations: USBConfiguration[];
  open(): Promise<void>;
  close(): Promise<void>;
  selectConfiguration(configurationValue: number): Promise<void>;
  claimInterface(interfaceNumber: number): Promise<void>;
  releaseInterface(interfaceNumber: number): Promise<void>;
  transferOut(
    endpointNumber: number,
    // Looser than the spec's BufferSource: TS 5.9's generic typed arrays
    // reject Uint8Array<ArrayBufferLike>, which is what encode() returns.
    data: Uint8Array<ArrayBufferLike>
  ): Promise<{ status: string }>;
}

interface USBConfiguration {
  /** The bConfigurationValue passed back to selectConfiguration(). */
  readonly configurationValue: number;
  interfaces: USBInterface[];
}

interface USBInterface {
  /** The bInterfaceNumber passed to claim/releaseInterface(). */
  readonly interfaceNumber: number;
  alternate: USBAlternateInterface;
}

interface USBAlternateInterface {
  endpoints: USBEndpoint[];
}

interface USBEndpoint {
  endpointNumber: number;
  direction: "in" | "out";
  type: "bulk" | "interrupt" | "isochronous";
}

// esc-pos-encoder v3 (wraps @point-of-sale/receipt-printer-encoder).
// Generates ESC/POS byte commands for 80mm thermal printers.
declare module "esc-pos-encoder" {
  type Align = "left" | "center" | "right";
  type Size = "small" | "normal" | "large" | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
  type BarcodeType =
    | "code128"
    | "code39"
    | "ean13"
    | "ean8"
    | "upca"
    | "upce"
    | "itf"
    | "codabar";

  interface EncoderOptions {
    /** Command language — always "esc-pos" for these thermal printers. */
    language?: "esc-pos" | "star-prnt" | "star-line";
    /** Character table used to map text to printer bytes. */
    codepage?: string;
    /** Line width in characters, used for text wrapping. */
    width?: number;
  }

  interface BarcodeSettings {
    hri?: boolean | "top" | "bottom";
    height?: number;
    width?: number;
    text?: string;
  }

  class EscPosEncoder {
    constructor(options?: EncoderOptions);
    initialize(): this;
    codepage(codepage: string): this;
    text(text: string): this;
    line(text?: string): this;
    newline(count?: number): this;
    align(value: Align): this;
    size(width: Size, height?: Size): this;
    bold(value: boolean): this;
    underline(value: boolean | 2): this;
    invert(value: boolean): this;
    qrcode(
      data: string,
      model?: 1 | 2,
      size?: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8,
      errorLevel?: "l" | "m" | "q" | "h"
    ): this;
    barcode(data: string, type: BarcodeType, settings?: BarcodeSettings): this;
    /**
     * Print a bitmap. `image` is canvas ImageData (RGBA); a pixel prints
     * black when its red channel is 0. mode "raster" emits GS v 0.
     */
    image(
      image: ImageData,
      width: number,
      height: number,
      mode?: "column" | "raster"
    ): this;
    /** Full or partial paper cut. */
    cut(partial?: boolean): this;
    raw(data: number[]): this;
    /** Returns the finished command bytes (verified: plain Uint8Array in v3). */
    encode(): Uint8Array;
  }
  export default EscPosEncoder;
}

// qz-tray v2 client — connects to the QZ Tray desktop app (wss on localhost)
// which prints raw ESC/POS bytes to USB / network / wireless printers.
declare module "qz-tray" {
  interface QzApi {
    /** Install a Promise implementation — the QZ client needs A+ promises. */
    setPromiseType(
      factory: (resolve: (value: unknown) => void) => Promise<unknown>
    ): void;
    /** Install the WebSocket constructor the browser provides. */
    setWebSocketType(ws: unknown): void;
  }

  interface QzSecurity {
    /** Supplies the shop's public signing certificate (from QZ Site Manager). */
    setCertificatePromise(
      handler: (resolve: (cert: string) => void) => void | Promise<void>
    ): void;
  }

  interface QzWebSocket {
    connect(options?: { retries?: number; delay?: number }): Promise<unknown>;
    disconnect(): Promise<unknown>;
    isActive(): boolean;
  }

  interface QzPrinters {
    /** Lists printers (all, or matching a name) — resolves when found. */
    find(name?: string, options?: unknown): Promise<unknown>;
  }

  interface QzConfigs {
    /** Create a print job config; { raw: true } enables raw ESC/POS bytes. */
    create(printer: string, options?: { raw?: boolean }): unknown;
  }

  interface Qz {
    api: QzApi;
    security: QzSecurity;
    websocket: QzWebSocket;
    printers: QzPrinters;
    configs: QzConfigs;
    print(config: unknown, data: unknown[]): Promise<unknown>;
  }

  const qz: Qz;
  export default qz;
}
