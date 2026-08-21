// Pure UI projection for the per-variant Stock Movement viewer. Running
// balances come from the server's UNFILTERED chronological walk (each row
// carries its after-balance), so before/after are correct regardless of
// filters, pagination or display order. Grouping keys on the business
// reference (order / purchase) — unrelated operations are never merged.

export type LedgerReason =
  | "purchase"
  | "sale"
  | "return"
  | "exchange_out"
  | "exchange_in"
  | "cancel"
  | "adjustment"
  | "stocktake";

export type MovementReference = {
  kind: "order" | "po";
  code: string;
  saleId?: string;
  purchaseId?: string;
  customerName?: string;
  channelName?: string;
  supplierName?: string;
  unitCost?: number;
};

export type MovementRow = {
  _id: string;
  ts: number;
  delta: number;
  reason: LedgerReason;
  note?: string;
  userName: string;
  /** Stock AFTER this movement (server, unfiltered chronological walk). */
  balance: number;
  reference?: MovementReference;
};

export type MovementGroup = {
  key: string;
  /** The operation timestamp — rows written in one transaction share it. */
  ts: number;
  reference?: MovementReference;
  /** The reasons present (a damaged return is `return` + `adjustment`). */
  reasons: LedgerReason[];
  rows: MovementRow[]; // chronological (ts, _id)
  opening: number; // balance before the first row
  in: number; // Σ positive deltas
  out: number; // |Σ negative deltas|
  net: number; // Σ deltas
  closing: number; // balance after the last row
};

/** Balance before a movement = after − delta (server walk, exact). */
export function beforeOf(row: MovementRow): number {
  return row.balance - row.delta;
}

/** Deterministic chronological order: timestamp, then stable id — rows
 * sharing a timestamp never produce unstable running balances. */
export function chronological(rows: MovementRow[]): MovementRow[] {
  return [...rows].sort(
    (a, b) => a.ts - b.ts || (a._id < b._id ? -1 : a._id > b._id ? 1 : 0)
  );
}

/** Newest-first for display; balances come from the server walk, so the
 * before/after stay true chronological values either way. */
export function newestFirst(rows: MovementRow[]): MovementRow[] {
  return [...rows].sort(
    (a, b) => b.ts - a.ts || (b._id < a._id ? -1 : b._id > a._id ? 1 : 0)
  );
}

/** Group key: the ATOMIC business operation — reference + operation
 * timestamp. Rows written in one transaction share one ts, and Convex
 * serializes transactions, so a (reference, ts) cluster is globally
 * contiguous by construction. Distinct operations on the SAME order (initial
 * sale, later edit, later cancellation, later return) therefore form
 * separate groups — they are never merged just because they share a saleId.
 * No explicit operationId exists on stockLedger rows, so the timestamp is
 * the operation identity (fallback per spec). Manual adjustments have no
 * reference: reason + note identifies the operation. */
export function groupKeyOf(row: MovementRow): string {
  const ref = row.reference;
  if (ref?.kind === "order" && ref.saleId) return `order:${ref.saleId}:${row.ts}`;
  if (ref?.kind === "po" && ref.purchaseId) return `po:${ref.purchaseId}:${row.ts}`;
  return `manual:${row.reason}:${row.note?.trim() ?? ""}`;
}

/** Order same-operation rows by the balance chain (balanceAfter of one row
 * equals balanceBefore of the next) — the true within-transaction sequence
 * for rows sharing a timestamp. Falls back to stable (ts, id) order for any
 * leftover rows the chain cannot reach. */
export function chainOrder(rows: MovementRow[]): MovementRow[] {
  if (rows.length <= 1) return [...rows];
  const byBefore = new Map(rows.map((r) => [beforeOf(r), r]));
  const afters = new Set(rows.map((r) => r.balance));
  // The chain's first row: its balanceBefore is nobody's balanceAfter.
  const start = rows.find((r) => !afters.has(beforeOf(r))) ?? rows[0];
  const out: MovementRow[] = [start];
  const seen = new Set([start._id]);
  let cur = start;
  while (out.length < rows.length) {
    const next = byBefore.get(cur.balance);
    if (!next || seen.has(next._id)) break;
    out.push(next);
    seen.add(next._id);
    cur = next;
  }
  for (const r of rows) {
    if (!seen.has(r._id)) out.push(r);
  }
  return out;
}

/** Group movements sharing the same business reference and operation. */
export function groupMovements(rows: MovementRow[]): MovementGroup[] {
  const byKey = new Map<string, MovementGroup>();
  for (const row of rows) {
    const key = groupKeyOf(row);
    let group = byKey.get(key);
    if (!group) {
      group = {
        key,
        ts: row.ts,
        reference: row.reference,
        reasons: [],
        rows: [],
        opening: 0,
        in: 0,
        out: 0,
        net: 0,
        closing: 0,
      };
      byKey.set(key, group);
    }
    group.rows.push(row);
    if (!group.reasons.includes(row.reason)) group.reasons.push(row.reason);
    if (row.delta > 0) group.in += row.delta;
    else group.out += -row.delta;
    group.net += row.delta;
  }
  const groups: MovementGroup[] = [];
  for (const group of byKey.values()) {
    // Within an atomic operation the true sequence is the balance chain
    // (same-ts rows), with stable (ts, id) as the deterministic fallback.
    group.rows = chainOrder(group.rows);
    group.opening = beforeOf(group.rows[0]);
    group.closing = group.rows[group.rows.length - 1].balance;
    groups.push(group);
  }
  // Newest-first groups (by the operation timestamp).
  return groups.sort(
    (a, b) => b.ts - a.ts || (b.key < a.key ? -1 : 1)
  );
}

/** A group needs an expand control only when it holds two or more
 * movements — a single-movement operation shows its detail directly. */
export function isExpandable(group: MovementGroup): boolean {
  return group.rows.length >= 2;
}

/** The route for the linked order/purchase detail — null when the reference
 * has no id (never exposes a bare code link). */
export function referenceHref(ref: MovementReference | undefined): string | null {
  if (!ref) return null;
  if (ref.kind === "order" && ref.saleId) return `/sales/${ref.saleId}`;
  if (ref.kind === "po" && ref.purchaseId) return `/purchases/${ref.purchaseId}`;
  return null;
}

/** Unit cost is owner-only — staff rows never carry it (server-side too). */
export function visibleUnitCost(
  ref: MovementReference | undefined,
  isOwner: boolean
): number | undefined {
  if (!isOwner) return undefined;
  return ref?.unitCost;
}

/** The newest row of a complete stream: the row the server walk ended at.
 * Within a same-ts operation the true sequence is the balance chain (one
 * row's before equals the next's after) — the (ts, _id) tiebreak is NOT the
 * server's walk order and can land on a mid-chain row (e.g. a 4-piece
 * return written as four +1 rows in one transaction shows 2→3→4→5→6, and
 * the max-_id row is any of those, not the 6). The chain end carries the
 * current stock by construction, so a mismatch against it is honest. */
function newestRowOf(rows: MovementRow[]): MovementRow {
  const maxTs = Math.max(...rows.map((r) => r.ts));
  const chain = chainOrder(rows.filter((r) => r.ts === maxTs));
  return chain[chain.length - 1];
}

/** Integrity: only meaningful when the sheet shows the COMPLETE unfiltered
 * global stream. A date filter, a reason filter, or a paginated subset makes
 * the newest loaded row's after-balance legitimately differ from the current
 * ledger-derived stock (e.g. "Stock out" hides the returns that landed after
 * the last sale), so the check is skipped there. A mismatch on the complete
 * stream is REPORTED, never silently corrected. */
export function integrityMismatch(
  rows: MovementRow[],
  currentStock: number,
  hasDateFilter: boolean,
  hasReasonFilter: boolean,
  isComplete: boolean
): { expected: number; actual: number } | null {
  if (hasDateFilter || hasReasonFilter || !isComplete || rows.length === 0) {
    return null;
  }
  const newest = newestRowOf(rows);
  if (newest.balance === currentStock) return null;
  return { expected: currentStock, actual: newest.balance };
}

/** Range-summary consistency (the server derives it; this guards display). */
export function summaryIsConsistent(s: {
  opening: number;
  in: number;
  out: number;
  closing: number;
}): boolean {
  return s.opening + s.in - s.out === s.closing;
}

/** Canonical reason order for breakdown display and combined labels —
 * grouping order never depends on query/insertion order. */
export const REASON_CANONICAL: LedgerReason[] = [
  "purchase",
  "sale",
  "return",
  "exchange_out",
  "exchange_in",
  "cancel",
  "adjustment",
  "stocktake",
];

/** Deduped reasons in canonical order. */
export function canonicalReasons(reasons: LedgerReason[]): LedgerReason[] {
  return REASON_CANONICAL.filter((r) => reasons.includes(r));
}

/** Combined-label key for a group's reasons ("sale,cancel"), canonical order —
 * the sheet maps it to a plain-language label ("Sold and cancelled"). */
export function combinedReasonKey(reasons: LedgerReason[]): string {
  return canonicalReasons(reasons).join(",");
}

export type NetDisplay = {
  /** "+5", "−5" or "0" — the zero case is neutral, never green/red. */
  signed: string;
  tone: "success" | "destructive" | "neutral";
};

/** Net presentation rules: > 0 success, < 0 destructive, 0 neutral. */
export function netDisplay(net: number): NetDisplay {
  if (net > 0) return { signed: `+${net}`, tone: "success" };
  if (net < 0) return { signed: `−${Math.abs(net)}`, tone: "destructive" };
  return { signed: "0", tone: "neutral" };
}

/** Adjacent-flow continuity INSIDE one atomic operation's rows (same
 * reference + timestamp — globally contiguous by construction): every row's
 * balanceAfter must equal the next row's balanceBefore. NEVER run this across
 * operation groups — unrelated global movements between two operations on
 * the same order legitimately break the chain there. Returns the broken
 * transitions (a dev diagnostic; the only user-facing integrity check is
 * integrityMismatch, which validates the complete global stream). */
export function flowContinuity(
  rows: MovementRow[]
): { index: number; expected: number; actual: number }[] {
  const ordered = chainOrder(rows);
  const breaks: { index: number; expected: number; actual: number }[] = [];
  for (let i = 0; i < ordered.length - 1; i++) {
    const expected = ordered[i].balance;
    const actual = beforeOf(ordered[i + 1]);
    if (expected !== actual) breaks.push({ index: i, expected, actual });
  }
  return breaks;
}

export type SummaryCardModel = {
  key: "opening" | "in" | "out" | "closing";
  /** Signed display value: + for in, − for out, unsigned for opening/closing. */
  value: number;
  tone?: "success" | "destructive";
};

/** Range-summary cards: stock out displays as a NEGATIVE outgoing movement,
 * opening/closing carry no sign. `opening + in − out = closing` holds on the
 * magnitudes (in/out are stored as magnitudes; the display signs them). */
export function summaryCards(
  summary: { opening: number; in: number; out: number; closing: number },
  hasDateFilter: boolean,
  currentStock: number
): { cards: SummaryCardModel[]; currentStockToday: number | null } {
  const cards: SummaryCardModel[] = [
    { key: "opening", value: summary.opening },
    { key: "in", value: summary.in, tone: "success" },
    { key: "out", value: -summary.out, tone: "destructive" },
    { key: "closing", value: summary.closing },
  ];
  const currentStockToday =
    hasDateFilter && summary.closing !== currentStock ? currentStock : null;
  return { cards, currentStockToday };
}
