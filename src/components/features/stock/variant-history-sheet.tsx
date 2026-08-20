"use client";

import { useQuery } from "convex/react";
import { useState } from "react";

import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useCurrentUser } from "@/hooks/use-current-user";
import { cn, formatDateTime, getLang, t } from "@/lib/utils";

// T6 — one variant's movement history (AGENTS.md), now a filterable drawer:
// right-side on desktop, full-screen on phone. Rows are real ledger data,
// newest first, with the movement (+10 green / −2 red / "Adjustment" neutral),
// the type, the order/PO reference and the stock balance AFTER the movement.
// Loads only when opened. Filters are transient dialog state (AGENTS.md), so
// they are deliberately NOT persisted in localStorage.

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

export type VariantSheetTarget = {
  variantId: Id<"productVariants">;
  /** "M / Black" style label. */
  label: string;
  sku?: string;
  stock: number;
};

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
  const [cursors, setCursors] = useState<string[]>([]);
  const [pageIndex, setPageIndex] = useState(0);

  // Fresh pagination each time the sheet opens on a DIFFERENT variant.
  // The variant stays set while the sheet is closed (the parent keeps the
  // last target) so the query below stays subscribed — a reopen renders
  // instantly from the warm cache instead of refetching (see below).
  const sheetKey = variant !== undefined ? variant.variantId : null;
  const [prevSheetKey, setPrevSheetKey] = useState<string | null>(null);
  if (sheetKey !== prevSheetKey) {
    setPrevSheetKey(sheetKey);
    if (sheetKey != null) {
      setCursors([]);
      setPageIndex(0);
    }
  }

  const history = useQuery(
    api.stock.variantHistory,
    // Deliberately NOT skipped when closed: closing the sheet would drop the
    // Convex subscription and every reopen would refetch (measured ~300–600ms
    // of skeletons per open on this dev backend). keepMounted keeps this hook
    // alive, so the last viewed variant stays warm and reopens instantly.
    user == null || variant === undefined
      ? "skip"
      : {
          variantId: variant.variantId,
          // Day strings only — the server converts them through the shop
          // timezone (same conversion as the reports).
          ...(fromDay !== "" ? { fromDay } : {}),
          ...(toDay !== "" ? { toDay } : {}),
          ...(reason !== "all" ? { reason } : {}),
          paginationOpts: {
            numItems: PAGE_SIZE,
            cursor: pageIndex === 0 ? null : (cursors[pageIndex - 1] ?? null),
          },
        }
  );

  const rows = history?.page ?? [];
  const total = history?.total ?? 0;
  const loading = history === undefined;
  const hasFilters = fromDay !== "" || toDay !== "" || reason !== "all";

  function resetPages() {
    setCursors([]);
    setPageIndex(0);
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      {/* Full screen on phone, right drawer from sm up. The primitives'
          base styles (data-[side=right]:w-3/4 / sm:max-w-sm) have attribute
          specificity over plain utilities, so both need Tailwind v4's
          important modifier to actually win. */}
      {/* keepMounted: the history query stays subscribed while closed (see the
          useQuery comment above); the popup itself is `hidden` when closed. */}
      <SheetContent side="right" keepMounted className="w-full! sm:max-w-lg!">
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

        {/* Filters: native date pickers + reason select + clear. */}
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
              className="h-9 w-40"
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
              className="h-9 w-40"
            />
          </label>
          <Select
            value={reason}
            // Base UI shows the RAW value in the trigger without this map.
            items={{
              all: t().reports.allReasons,
              ...Object.fromEntries(
                REASON_OPTIONS.map((r) => [r, labels.reasons[r]])
              ),
            }}
            onValueChange={(value) => {
              // Values come only from the SelectItems below, so the cast is safe.
              if (value != null) {
                setReason(value as ReasonFilter);
                resetPages();
              }
            }}
          >
            <SelectTrigger size="sm" className="w-full sm:w-40">
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
          <Button
            variant="ghost"
            size="sm"
            disabled={!hasFilters}
            onClick={() => {
              setFromDay("");
              setToDay("");
              setReason("all");
              resetPages();
            }}
          >
            {labels.clearFilters}
          </Button>
        </div>

        <ScrollArea className="flex-1">
          {loading ? (
            <div className="flex flex-col gap-2 py-2">
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          ) : rows.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              {labels.noMovements}
            </p>
          ) : (
            <>
              {/* Desktop: compact 5-column table (hidden on phones). */}
              <div className="hidden sm:block">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{labels.dateCol}</TableHead>
                      <TableHead>{labels.movementCol}</TableHead>
                      <TableHead>{labels.typeCol}</TableHead>
                      <TableHead>{labels.referenceCol}</TableHead>
                      <TableHead className="text-right">
                        {labels.movementBalanceCol}
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.map(({ row, balance, reference }) => (
                      <TableRow key={row._id}>
                        <TableCell>
                          {formatDateTime(row.ts, timezone, lang)}
                          {row.note ? (
                            <span className="block text-xs text-muted-foreground">
                              {row.note}
                            </span>
                          ) : null}
                        </TableCell>
                        <TableCell>
                          {row.reason === "adjustment" ||
                          row.reason === "stocktake" ? (
                            // Neutral: adjustments are corrections, not flows.
                            <span className="text-sm text-muted-foreground">
                              {labels.reasons[row.reason]}
                            </span>
                          ) : (
                            <span
                              className={cn(
                                "font-mono text-sm font-medium",
                                row.delta >= 0
                                  ? "text-success"
                                  : "text-destructive"
                              )}
                            >
                              {row.delta >= 0 ? `+${row.delta}` : row.delta}
                            </span>
                          )}
                        </TableCell>
                        <TableCell>{labels.reasons[row.reason]}</TableCell>
                        <TableCell className="text-muted-foreground">
                          {reference
                            ? reference.kind === "order"
                              ? labels.referenceOrder.replace(
                                  "{code}",
                                  reference.code
                                )
                              : labels.referencePo.replace(
                                  "{code}",
                                  reference.code
                                )
                            : "—"}
                        </TableCell>
                        <TableCell className="text-right font-mono tabular-nums">
                          {balance}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>

              {/* Phone: stacked rows (hidden from sm up). */}
              <div className="flex flex-col sm:hidden">
                {rows.map(({ row, balance, reference }) => (
                  <div key={row._id} className="border-b py-3 last:border-b-0">
                    <div className="flex items-start justify-between gap-2">
                      <span className="text-sm text-muted-foreground">
                        {formatDateTime(row.ts, timezone, lang)}
                      </span>
                      <span className="font-mono text-sm tabular-nums">
                        {balance}
                      </span>
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                      {row.reason === "adjustment" ||
                      row.reason === "stocktake" ? (
                        <span className="text-muted-foreground">
                          {labels.reasons[row.reason]}
                        </span>
                      ) : (
                        <span
                          className={cn(
                            "font-mono font-medium",
                            row.delta >= 0
                              ? "text-success"
                              : "text-destructive"
                          )}
                        >
                          {row.delta >= 0 ? `+${row.delta}` : row.delta}
                        </span>
                      )}
                      <span>{labels.reasons[row.reason]}</span>
                      {reference ? (
                        <span className="text-muted-foreground">
                          {reference.kind === "order"
                            ? labels.referenceOrder.replace(
                                "{code}",
                                reference.code
                              )
                            : labels.referencePo.replace(
                                "{code}",
                                reference.code
                              )}
                        </span>
                      ) : null}
                    </div>
                    {row.note ? (
                      <p className="mt-1 text-xs text-muted-foreground">
                        {row.note}
                      </p>
                    ) : null}
                  </div>
                ))}
              </div>
            </>
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
