"use client";

import {
  ArrowLeftRightIcon,
  ArrowUp01Icon,
  ArrowDown01Icon,
  Cancel01Icon,
  ClipboardCheckIcon,
  PackageReceive01Icon,
  ShoppingBag01Icon,
  SlidersHorizontalIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useQuery } from "convex/react";
import Link from "next/link";
import { useMemo, useState } from "react";

import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { useCurrentUser } from "@/hooks/use-current-user";
import { cn, formatDateTime, formatMoney, getLang, t } from "@/lib/utils";
import {
  beforeOf,
  canonicalReasons,
  combinedReasonKey,
  flowContinuity,
  groupMovements,
  integrityMismatch,
  isExpandable,
  netDisplay,
  referenceHref,
  summaryCards,
  type LedgerReason,
  type MovementGroup,
  type MovementRow,
} from "@/lib/stock-movements";

// T6 — one variant's movement history, redesigned for a shop owner: range
// summary cards (opening / in / out / closing, derived from the immutable
// ledger server-side), movements GROUPED by their business reference (order
// / purchase / manual operation) with plain-language rows, before → after
// balances from the server's unfiltered chronological walk, clickable order
// / PO links, and owner-only unit costs. Filters: From / To / reason /
// sign / user, with removable chips and clear. The original immutable
// ledger rows stay inspectable inside each group's expandable section.
// Loads only when opened; filters are transient dialog state (AGENTS.md).

const PAGE_SIZE = 50;

const REASON_OPTIONS = [
  "purchase",
  "sale",
  "return",
  "exchange_out",
  "exchange_in",
  "cancel",
  "adjustment",
  "stocktake",
] as const;
type ReasonFilter = "all" | (typeof REASON_OPTIONS)[number];
type SignFilter = "all" | "in" | "out";

export type VariantSheetTarget = {
  variantId: Id<"productVariants">;
  /** "M / Black" style label. */
  label: string;
  sku?: string;
  stock: number;
};

/** Semantic presentation per movement type — icon + action + sign always
 * travel together (never color alone). */
const REASON_VISUAL: Record<
  LedgerReason,
  { icon: typeof ShoppingBag01Icon; tone: "success" | "destructive" | "primary" | "warning" }
> = {
  purchase: { icon: PackageReceive01Icon, tone: "success" },
  return: { icon: PackageReceive01Icon, tone: "success" },
  sale: { icon: ShoppingBag01Icon, tone: "destructive" },
  exchange_in: { icon: ArrowLeftRightIcon, tone: "destructive" },
  exchange_out: { icon: ArrowLeftRightIcon, tone: "primary" },
  cancel: { icon: Cancel01Icon, tone: "primary" },
  adjustment: { icon: SlidersHorizontalIcon, tone: "warning" },
  stocktake: { icon: ClipboardCheckIcon, tone: "warning" },
};

const TONE_CLS: Record<string, string> = {
  success: "text-success",
  destructive: "text-destructive",
  primary: "text-primary",
  warning: "text-warning",
};

/** Plain-language combined labels for multi-reason groups. */
const COMBINED_REASON_LABELS: Record<string, string> = {
  "sale,cancel": t().stock.combined.saleCancel,
  "return,adjustment": t().stock.combined.returnAdjustment,
};

/** Chronological (oldest → newest) rows for the expanded flow view. */
// A balance-chain break inside an atomic operation is a projection
// diagnostic (dev console only) — never a user-facing corruption warning.
// The ledger itself is validated by the server's single global walk and the
// integrityMismatch check (complete stream), not per-group subsets.
function warnFlowBreaks(group: MovementGroup, rows: MovementRow[]) {
  const breaks = flowContinuity(rows);
  if (breaks.length > 0 && process.env.NODE_ENV !== "production") {
    console.warn(
      `[stock-viewer] balance chain broke inside operation ${group.key}:`,
      breaks
    );
  }
}
function chronologicalRowsOf(rows: MovementRow[]): MovementRow[] {
  return [...rows].sort(
    (a, b) => a.ts - b.ts || (a._id < b._id ? -1 : a._id > b._id ? 1 : 0)
  );
}

export function VariantHistorySheet({
  open,
  onOpenChange,
  productName,
  variant,
  timezone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  productName: string;
  /** Undefined only while the sheet is closed (open=false). */
  variant?: VariantSheetTarget;
  timezone: string;
}) {
  const user = useCurrentUser();
  const lang = getLang();
  const labels = t().stock;
  const [fromDay, setFromDay] = useState("");
  const [toDay, setToDay] = useState("");
  const [reason, setReason] = useState<ReasonFilter>("all");
  const [sign, setSign] = useState<SignFilter>("all");
  const [userFilter, setUserFilter] = useState("all");
  const [cursors, setCursors] = useState<string[]>([]);
  const [pageIndex, setPageIndex] = useState(0);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [groupOrder, setGroupOrder] = useState<"newest" | "oldest">("newest");

  // Fresh pagination each time the sheet opens on a DIFFERENT variant (the
  // parent keeps the last target so the query stays subscribed — warm cache).
  const sheetKey = variant !== undefined ? variant.variantId : null;
  const [prevSheetKey, setPrevSheetKey] = useState<string | null>(null);
  if (sheetKey !== prevSheetKey) {
    setPrevSheetKey(sheetKey);
    if (sheetKey != null) {
      setCursors([]);
      setPageIndex(0);
      setExpanded(new Set());
    }
  }

  const history = useQuery(
    api.stock.variantHistory,
    user == null || variant === undefined
      ? "skip"
      : {
          variantId: variant.variantId,
          ...(fromDay !== "" ? { fromDay } : {}),
          ...(toDay !== "" ? { toDay } : {}),
          ...(reason !== "all" ? { reason } : {}),
          paginationOpts: {
            numItems: PAGE_SIZE,
            cursor: pageIndex === 0 ? null : (cursors[pageIndex - 1] ?? null),
          },
        }
  );

  // The server returns {row, userName, balance, reference?} — flatten to the
  // projection shape the pure module works with.
  const rows: MovementRow[] = (history?.page ?? []).map(
    ({ row, userName, balance, reference }) => ({
      _id: row._id,
      ts: row.ts,
      delta: row.delta,
      reason: row.reason,
      note: row.note,
      userName,
      balance,
      reference,
    })
  );
  const summary = history?.summary;
  const total = history?.total ?? 0;
  const loading = history === undefined;
  const isOwner = user?.role === "owner";

  // Client-side sign/user filters over the loaded page (the server filters
  // by date + reason; sign/user ride along "if existing data supports them").
  const visibleRows = useMemo(() => {
    let out: MovementRow[] = rows;
    if (sign !== "all") {
      out = out.filter((r) => (sign === "in" ? r.delta > 0 : r.delta < 0));
    }
    if (userFilter !== "all") {
      out = out.filter((r) => r.userName === userFilter);
    }
    return out;
  }, [rows, sign, userFilter]);

  const userNameOptions = useMemo(
    () => [...new Set(rows.map((r) => r.userName))].sort(),
    [rows]
  );
  const groups = useMemo(() => groupMovements(visibleRows), [visibleRows]);
  const orderedGroups = useMemo(
    () => (groupOrder === "newest" ? groups : [...groups].reverse()),
    [groups, groupOrder]
  );
  const hasDateFilter = fromDay !== "" || toDay !== "";
  const mismatch = integrityMismatch(rows, variant?.stock ?? 0, hasDateFilter);
  const hasFilters =
    fromDay !== "" ||
    toDay !== "" ||
    reason !== "all" ||
    sign !== "all" ||
    userFilter !== "all";

  const activeChips: { key: string; label: string; clear: () => void }[] = [];
  if (fromDay !== "")
    activeChips.push({
      key: "from",
      label: `${t().reports.stockFrom} ${fromDay}`,
      clear: () => setFromDay(""),
    });
  if (toDay !== "")
    activeChips.push({
      key: "to",
      label: `${t().reports.stockTo} ${toDay}`,
      clear: () => setToDay(""),
    });
  if (reason !== "all")
    activeChips.push({
      key: "reason",
      label: labels.reasons[reason],
      clear: () => setReason("all"),
    });
  if (sign !== "all")
    activeChips.push({
      key: "sign",
      label: sign === "in" ? labels.stockIn : labels.stockOut,
      clear: () => setSign("all"),
    });
  if (userFilter !== "all")
    activeChips.push({
      key: "user",
      label: userFilter,
      clear: () => setUserFilter("all"),
    });

  function resetPages() {
    setCursors([]);
    setPageIndex(0);
  }

  function toggleGroup(key: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" keepMounted className="w-full! overflow-hidden sm:max-w-2xl!">
        <SheetHeader>
          <SheetTitle className="truncate">{productName}</SheetTitle>
          <SheetDescription className="flex flex-col gap-1">
            {variant ? (
              <>
                <span className="truncate">
                  {variant.label} · {variant.sku ?? "—"}
                </span>
                <span className="font-medium text-foreground tabular-nums">
                  {labels.currentStock.replace("{n}", String(variant.stock))}
                </span>
              </>
            ) : null}
          </SheetDescription>
        </SheetHeader>

        {/* Range summary — derived from the immutable ledger on every read.
            Stock out displays as a NEGATIVE outgoing movement; opening and
            closing carry no sign. Filtered ranges label the bounds, and the
            true current stock is shown separately when it differs. */}
        {summary !== undefined ? (() => {
          const cards = summaryCards(summary, hasDateFilter, variant?.stock ?? 0);
          const cardOf = (key: "opening" | "in" | "out" | "closing") =>
            cards.cards.find((c) => c.key === key)!;
          return (
            <>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <SummaryCard
                  label={
                    hasDateFilter
                      ? labels.openingAtRange.replace(
                          "{day}",
                          fromDay !== "" ? fromDay : "…"
                        )
                      : labels.openingStock
                  }
                  value={cardOf("opening").value}
                />
                <SummaryCard
                  label={hasDateFilter ? labels.stockInDuring : labels.stockIn}
                  value={cardOf("in").value}
                  tone="success"
                />
                <SummaryCard
                  label={hasDateFilter ? labels.stockOutDuring : labels.stockOut}
                  value={cardOf("out").value}
                  tone="destructive"
                />
                <SummaryCard
                  label={
                    hasDateFilter
                      ? labels.closingAtRange.replace(
                          "{day}",
                          toDay !== "" ? toDay : "…"
                        )
                      : labels.currentStockBare
                  }
                  value={cardOf("closing").value}
                  strong
                />
              </div>
              {cards.currentStockToday !== null ? (
                <p className="text-xs text-muted-foreground">
                  {labels.currentStockToday.replace(
                    "{n}",
                    String(variant?.stock ?? 0)
                  )}
                </p>
              ) : null}
            </>
          );
        })() : null}

        {/* Integrity: a mismatch is reported, never silently corrected. */}
        {mismatch ? (
          <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {labels.integrityWarning
              .replace("{expected}", String(mismatch.expected))
              .replace("{actual}", String(mismatch.actual))}
          </p>
        ) : null}

        {/* Filters: From / To / reason / sign / user. */}
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            {t().reports.stockFrom}
            <Input
              type="date"
              value={fromDay}
              onChange={(e) => {
                setFromDay(e.target.value);
                resetPages();
              }}
              className="h-11 w-36 sm:h-9 sm:w-36"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            {t().reports.stockTo}
            <Input
              type="date"
              value={toDay}
              onChange={(e) => {
                setToDay(e.target.value);
                resetPages();
              }}
              className="h-11 w-36 sm:h-9 sm:w-36"
            />
          </label>
          <Select
            value={reason}
            items={{
              all: t().reports.allReasons,
              ...Object.fromEntries(
                REASON_OPTIONS.map((r) => [r, labels.reasons[r]])
              ),
            }}
            onValueChange={(value) => {
              if (value != null) {
                setReason(value as ReasonFilter);
                resetPages();
              }
            }}
          >
            <SelectTrigger size="sm" className="h-11 w-full sm:h-9 sm:w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t().reports.allReasons}</SelectItem>
              {REASON_OPTIONS.map((r) => (
                <SelectItem key={r} value={r}>
                  {labels.reasons[r]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={sign}
            items={{
              all: labels.allSigns,
              in: labels.stockIn,
              out: labels.stockOut,
            }}
            onValueChange={(value) => {
              if (value != null) setSign(value as SignFilter);
            }}
          >
            <SelectTrigger size="sm" className="h-11 w-full sm:h-9 sm:w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{labels.allSigns}</SelectItem>
              <SelectItem value="in">{labels.stockIn}</SelectItem>
              <SelectItem value="out">{labels.stockOut}</SelectItem>
            </SelectContent>
          </Select>
          {userNameOptions.length > 1 ? (
            <Select
              value={userFilter}
              items={{
                all: labels.allUsers,
                ...Object.fromEntries(userNameOptions.map((n) => [n, n])),
              }}
              onValueChange={(value) => {
                if (value != null) setUserFilter(value);
              }}
            >
              <SelectTrigger size="sm" className="h-11 w-full sm:h-9 sm:w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{labels.allUsers}</SelectItem>
                {userNameOptions.map((n) => (
                  <SelectItem key={n} value={n}>
                    {n}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : null}
        </div>

        {/* Active filters as removable chips + clear. */}
        {activeChips.length > 0 ? (
          <div className="flex flex-wrap items-center gap-1.5">
            {activeChips.map((chip) => (
              <Badge key={chip.key} variant="secondary" className="gap-1.5 pr-1">
                {chip.label}
                <button
                  type="button"
                  onClick={chip.clear}
                  aria-label={t().common.delete}
                  className="flex size-5 items-center justify-center rounded-full hover:bg-muted"
                >
                  ×
                </button>
              </Badge>
            ))}
            <Button
              variant="ghost"
              size="sm"
              disabled={!hasFilters}
              onClick={() => {
                setFromDay("");
                setToDay("");
                setReason("all");
                setSign("all");
                setUserFilter("all");
                resetPages();
              }}
            >
              {labels.clearFilters}
            </Button>
          </div>
        ) : null}

        <ScrollArea className="min-h-0 flex-1">
          {loading ? (
            <div className="flex flex-col gap-2 py-2">
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={i} className="h-24 w-full" />
              ))}
            </div>
          ) : groups.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              {labels.noMovements}
            </p>
          ) : (
            <div className="flex flex-col gap-2 py-1">
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground">
                  {groupOrder === "newest"
                    ? labels.sortNewestFirst
                    : labels.sortOldestFirst}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-9 px-2 text-xs"
                  aria-label={`${
                    groupOrder === "newest"
                      ? labels.sortOldestFirst
                      : labels.sortNewestFirst
                  }`}
                  onClick={() =>
                    setGroupOrder((o) => (o === "newest" ? "oldest" : "newest"))
                  }
                >
                  <HugeiconsIcon
                    icon={groupOrder === "newest" ? ArrowDown01Icon : ArrowUp01Icon}
                    strokeWidth={2}
                    className="size-3.5"
                  />
                </Button>
              </div>
              {orderedGroups.map((group) => {
                const open = expanded.has(group.key);
                const ref = group.reference;
                const href = referenceHref(ref);
                const unitCost = visibleUnitCostOf(ref, isOwner);
                // A single-movement operation shows its detail directly —
                // no expand control, no breakdown section.
                if (!isExpandable(group)) {
                  return (
                    <div key={group.key} className="rounded-md border p-3">
                      <p className="text-sm font-medium">
                        {href ? (
                          <Link href={href} className="hover:underline">
                            {ref?.kind === "order"
                              ? labels.referenceOrder.replace(
                                  "{code}",
                                  ref?.code ?? ""
                                )
                              : labels.referencePo.replace(
                                  "{code}",
                                  ref?.code ?? ""
                                )}
                          </Link>
                        ) : (
                          labels.operations[group.reasons[0]]
                        )}
                        <span className="ml-1 text-xs font-normal text-muted-foreground">
                          — {labels.operations[group.reasons[0]]}
                        </span>
                      </p>
                      <MovementRowView row={group.rows[0]} timezone={timezone} />
                    </div>
                  );
                }
                return (
                  <div key={group.key} className="rounded-md border">
                    {/* Group header: reference + net. */}
                    <div className="flex items-center gap-2 p-3 pb-2">
                      <div className="min-w-0 flex-1">
                        {href ? (
                          <Link
                            href={href}
                            className="text-sm font-medium hover:underline"
                          >
                            {ref?.kind === "order"
                              ? labels.referenceOrder.replace(
                                  "{code}",
                                  ref?.code ?? ""
                                )
                              : labels.referencePo.replace(
                                  "{code}",
                                  ref?.code ?? ""
                                )}
                          </Link>
                        ) : (
                          <span className="text-sm font-medium">
                            {labels.reasons[group.reasons[0]]}
                          </span>
                        )}
                        <span className="ml-1 text-xs text-muted-foreground">
                          —{" "}
                          {group.reasons.length > 1
                            ? (COMBINED_REASON_LABELS[combinedReasonKey(group.reasons)] ??
                              canonicalReasons(group.reasons)
                                .map((r) => labels.reasons[r])
                                .join(" + "))
                            : labels.operations[group.reasons[0]]}
                        </span>
                        <span className="block text-xs text-muted-foreground">
                          {ref?.customerName
                            ? `${ref.customerName}${
                                ref.channelName ? ` · ${ref.channelName}` : ""
                              }`
                            : ref?.supplierName
                              ? ref.supplierName
                              : canonicalReasons(group.reasons)
                                  .map((r) => labels.reasons[r])
                                  .join(", ")}
                          {ref?.kind === "po" && unitCost !== undefined
                            ? ` · ${labels.unitCost}: ${formatMoney(
                                unitCost,
                                "USD",
                                lang
                              )}`
                            : ""}
                        </span>
                      </div>
                      <div className="shrink-0 text-right">
                        <span
                          className={cn(
                            "text-sm font-semibold tabular-nums",
                            netDisplay(group.net).tone === "success" &&
                              "text-success",
                            netDisplay(group.net).tone === "destructive" &&
                              "text-destructive",
                            netDisplay(group.net).tone === "neutral" &&
                              "text-muted-foreground"
                          )}
                        >
                          {netDisplay(group.net).tone === "neutral"
                            ? `${netDisplay(group.net).signed} · ${labels.noStockChange}`
                            : netDisplay(group.net).signed}
                        </span>
                        <span className="block text-xs text-muted-foreground">
                          {labels.stockCol}: {group.opening} → {group.closing}
                        </span>
                      </div>
                    </div>

                    {/* Per-reason breakdown + expandable raw rows. */}
                    <div className="px-3 pb-2">
                      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
                        {canonicalReasons(group.reasons).map((r) => {
                          const sum = group.rows
                            .filter((x) => x.reason === r)
                            .reduce((s, x) => s + x.delta, 0);
                          const d = netDisplay(sum);
                          return (
                            <span key={r} className="text-muted-foreground">
                              {labels.reasons[r]}:{" "}
                              <span
                                className={cn(
                                  "font-medium tabular-nums",
                                  d.tone === "success" && "text-success",
                                  d.tone === "destructive" && "text-destructive",
                                  d.tone === "neutral" && "text-muted-foreground"
                                )}
                              >
                                {d.signed}
                              </span>
                            </span>
                          );
                        })}
                        <span className="text-muted-foreground">
                          {labels.netCol}:{" "}
                          <span
                            className={cn(
                              "font-medium tabular-nums",
                              netDisplay(group.net).tone === "success" &&
                                "text-success",
                              netDisplay(group.net).tone === "destructive" &&
                                "text-destructive",
                              netDisplay(group.net).tone === "neutral" &&
                                "text-muted-foreground"
                            )}
                          >
                            {netDisplay(group.net).tone === "neutral"
                              ? `${netDisplay(group.net).signed} · ${labels.noStockChange}`
                              : netDisplay(group.net).signed}
                          </span>
                        </span>
                      </div>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="mt-1 h-11 px-1 text-xs sm:h-8"
                        aria-expanded={open}
                        aria-label={`${
                          open ? labels.hideMovements : labels.showMovements
                        } — ${ref?.code ?? group.key}`}
                        onClick={() => toggleGroup(group.key)}
                      >
                        {open
                          ? labels.hideMovements
                          : group.rows.length === 1
                            ? labels.showMovementsOne.replace(
                                "{n}",
                                String(group.rows.length)
                              )
                            : labels.showMovements.replace(
                                "{n}",
                                String(group.rows.length)
                              )}
                        <HugeiconsIcon
                          icon={open ? ArrowUp01Icon : ArrowDown01Icon}
                          strokeWidth={2}
                          className="size-3.5"
                        />
                      </Button>
                    </div>

                    {/* Original immutable ledger rows, inspectable —
                        TRUE chronological flow (oldest → newest), with a
                        continuity check: every balanceAfter must equal the
                        next balanceBefore. */}
                    {open ? (
                      <div className="flex flex-col divide-y border-t">
                        <p className="px-3 pt-2 text-xs text-muted-foreground">
                          {labels.movementFlow} · {labels.movementFlowOrder}
                        </p>
                        {flowContinuity(group.rows).length > 0 ? (
                          <p className="px-3 pt-1 text-xs text-muted-foreground">
                            {labels.flowDiagnostic}
                          </p>
                        ) : null}
                        {warnFlowBreaks(group, group.rows) ?? null}
                        {chronologicalRowsOf(group.rows).map((r) => (
                          <MovementRowView
                            key={r._id}
                            row={r}
                            timezone={timezone}
                          />
                        ))}
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          )}
          {rows.length < total && (
            <div className="flex justify-center py-3">
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  if (history?.continueCursor) {
                    setCursors((c) =>
                      c[pageIndex] === undefined
                        ? [...c, history.continueCursor]
                        : c
                    );
                    setPageIndex((i) => i + 1);
                  }
                }}
              >
                {t().common.showAll}
              </Button>
            </div>
          )}
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}

function visibleUnitCostOf(
  ref: MovementRow["reference"],
  isOwner: boolean
): number | undefined {
  return isOwner ? ref?.unitCost : undefined;
}

function SummaryCard({
  label,
  value,
  tone,
  strong,
}: {
  label: string;
  value: number;
  tone?: "success" | "destructive";
  strong?: boolean;
}) {
  return (
    <div className="rounded-md border p-2.5">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p
        className={cn(
          "mt-0.5 text-lg font-semibold tabular-nums",
          strong && "text-foreground",
          tone === "success" && "text-success",
          tone === "destructive" && "text-destructive"
        )}
      >
        {value >= 0 && tone ? `+${value}` : value}
      </p>
    </div>
  );
}

/** One immutable ledger row: icon + action + signed qty + before → after +
 * date + user + note. */
function MovementRowView({
  row,
  timezone,
}: {
  row: MovementRow;
  timezone: string;
}) {
  const labels = t().stock;
  const lang = getLang();
  const visual = REASON_VISUAL[row.reason];
  const before = beforeOf(row);
  return (
    <div className="flex flex-col gap-1 px-3 py-2.5 text-sm">
      <div className="flex items-center gap-2">
        <HugeiconsIcon
          icon={visual.icon}
          strokeWidth={2}
          className={cn("size-4 shrink-0", TONE_CLS[visual.tone])}
        />
        <span className="font-medium">{labels.actions[row.reason]}</span>
        <span
          className={cn(
            "ml-auto font-semibold tabular-nums",
            row.delta >= 0 ? "text-success" : "text-destructive"
          )}
        >
          {row.delta >= 0 ? `+${row.delta}` : row.delta}
        </span>
      </div>
      <p className="text-xs text-muted-foreground">
        {labels.balanceCol}: {before} → {row.balance}
      </p>
      <div className="flex flex-wrap gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
        <span>{formatDateTime(row.ts, timezone, lang)}</span>
        <span>
          {t().sales.by} {row.userName}
        </span>
      </div>
      {row.note ? (
        <p className="text-xs text-muted-foreground">{row.note}</p>
      ) : null}
    </div>
  );
}
