import net from "node:net";
import type { NextRequest } from "next/server";

import { api } from "@convex/_generated/api";
import { fetchAuthQuery, isAuthenticated } from "@/lib/auth-server";

// T25 — Network thermal printing (AGENTS.md): browsers cannot open raw TCP
// sockets, so the server prints. POST /api/print/raw takes ONLY the bytes
// (base64); the destination is read server-side from the SHOP's saved
// printerConfig — the request body can never point the connection anywhere
// the owner did not configure. Defense in depth:
//   1. better-auth session required (staff + owner may print),
//   2. printer type must be "network" in the saved settings,
//   3. the saved host must be a local-network address (SSRF guard),
//   4. size-capped body, connect timeout, no response data beyond ok/error.
//
// Network printing needs the app server and the printer on the same network
// (the shop PC / LAN server case); WebUSB and QZ Tray print from the browser
// instead when the app is hosted elsewhere.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_PRINT_BYTES = 512 * 1024; // receipts are ~2–5 KB — generous cap
const CONNECT_TIMEOUT_MS = 6_000;

/** Local-only destinations: loopback, RFC1918, CGNAT (Tailscale etc.), IPv6
 * link-local + ULA, and mDNS-ish hostnames. Anything else is rejected —
 * the endpoint must never be usable as a TCP proxy to the internet. */
function isLanHost(host: string): boolean {
  const h = host.trim().replace(/^\[|\]$/g, "").toLowerCase();
  if (h === "localhost" || h === "::1") return true;
  if (/^([a-z0-9-]+\.)*(local|lan|internal|home\.arpa)$/.test(h)) return true;

  const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    const octets = v4.slice(1).map(Number);
    if (octets.some((o) => o > 255)) return false;
    return (
      a === 10 ||
      a === 127 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }

  const v6 = h.match(/^[0-9a-f:]+$/);
  if (v6) {
    return h.startsWith("fe80:") || h.startsWith("fc") || h.startsWith("fd");
  }
  return false;
}

export async function POST(request: NextRequest) {
  if (!(await isAuthenticated())) {
    return Response.json({ error: "Sign in first." }, { status: 401 });
  }

  let data = "";
  try {
    const body = (await request.json()) as { data?: unknown };
    if (typeof body.data === "string") data = body.data;
  } catch {
    return Response.json({ error: "Bad request." }, { status: 400 });
  }
  if (!data || data.length > Math.ceil((MAX_PRINT_BYTES * 4) / 3) + 8) {
    return Response.json({ error: "Print data is too large." }, { status: 400 });
  }

  // The destination comes from the DB, not the wire.
  const shop = await fetchAuthQuery(api.shop.get, {});
  const cfg = shop?.printerConfig;
  if (!shop || !cfg || cfg.type !== "network" || !cfg.networkHost || !cfg.networkPort) {
    return Response.json(
      { error: "Network printer is not set up yet. Open Settings and set it up." },
      { status: 400 }
    );
  }
  if (!isLanHost(cfg.networkHost)) {
    return Response.json(
      { error: "The printer address must be a local network address." },
      { status: 400 }
    );
  }

  let bytes: Buffer;
  try {
    bytes = Buffer.from(data, "base64");
  } catch {
    return Response.json({ error: "Bad request." }, { status: 400 });
  }
  if (bytes.length === 0 || bytes.length > MAX_PRINT_BYTES) {
    return Response.json({ error: "Print data is too large." }, { status: 400 });
  }

  // Hoist before the closure: property narrowing does not survive into
  // callbacks, but const locals do.
  const host = cfg.networkHost;
  const port = cfg.networkPort;

  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const done = (fn: () => void) => {
        if (!settled) {
          settled = true;
          fn();
        }
      };
      const socket = net.connect({
        host,
        port,
        timeout: CONNECT_TIMEOUT_MS,
      });
      socket.on("connect", () => {
        socket.end(bytes);
      });
      socket.on("close", () => done(resolve));
      socket.on("error", (err) =>
        done(() => reject(err instanceof Error ? err : new Error(String(err))))
      );
      socket.on("timeout", () => {
        socket.destroy();
        done(() => reject(new Error("The printer did not answer. Check the address and power.")));
      });
    });
    return Response.json({ ok: true });
  } catch (err) {
    // Log the real cause server-side; the client gets one short message.
    console.error("print/raw failed:", err);
    return Response.json(
      { error: "The printer did not answer. Check the address and power." },
      { status: 502 }
    );
  }
}
