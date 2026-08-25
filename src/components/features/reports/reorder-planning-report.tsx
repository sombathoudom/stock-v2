"use client";

import { ClipboardCheckIcon, Search01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useQuery } from "convex/react";
import Link from "next/link";
import { useDeferredValue, useMemo, useState } from "react";

import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import {
  DataTable,
  type DataTableColumn,
} from "@/components/features/data-table/data-table";
import { PageToolbar } from "@/components/features/shell/page-toolbar";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useCurrentUser } from "@/hooks/use-current-user";
import { usePersistentState } from "@/hooks/use-persistent-state";
import { useShop } from "@/hooks/use-shop";
import { formatMoney, getLang, t } from "@/lib/utils";

// Reorder planning — how much to buy so the shelf covers the next N days of
// sales, derived server-side from the immutable ledger: average daily units
// over the lookback window × cover days − current stock. Variants with no
// recent sales never appear here (that's Dead stock's job).

type Window = 30 | 60 | 90;
type ReorderRow = {
  productId: Id<"products">;
  variantId: Id<"productVariants">;
  productName: string;
  productCode?: string;
  size: string;
  color?: string;
  sku?: string;
  currentQty: number;
  unitsSoldInLookback: number;
  averageDailyUnits: number;
  estimatedDaysRemaining: number;
  suggestedReorderQty: number;
  weightedLandedUnitCost: number;
  estimatedReorderCost: number;
};

const WINDOWS: Window[] = [30, 60, 90];

export function ReorderPlanningReport() {
  const user = useCurrentUser();
  const shop = useShop();
  const [search, setSearch] = usePersistentState("reports:reorder:search", "");
  const deferredSearch = useDeferredValue(search);
  const [lookbackDays, setLookbackDays] = usePersistentState<Window>(
    "reports:reorder:lookback",
    30,
  );
  const [targetDays, setTargetDays] = usePersistentState<Window>(
    "reports:reorder:target",
    30,
  );
  const [pageSize, setPageSize] = usePersistentState("reports:reorder:pageSize", 20);
  const [pageIndex, setPageIndex] = useState(0);
  const [cursors, setCursors] = useState<string[]>([]);
  const currency = shop?.currency ?? "USD";
  const lang = getLang();

  function resetPages() {
    setPageIndex(0);
    setCursors([]);
  }

  function windowLabel(days: Window): string {
    return t().reports.daysUnit.replace("{days}", String(days));
  }

  const report = useQuery(
    api.reports.getReorderPlanningReport,
    user == null
      ? "skip"
      : {
          lookbackDays,
          targetDays,
          search: deferredSearch.trim() || undefined,
          paginationOpts: {
            numItems: pageSize,
            cursor: pageIndex === 0 ? null : (cursors[pageIndex - 1] ?? null),
          },
        },
  );

  const columns = useMemo<DataTableColumn<ReorderRow>[]>(
    () => [
      {
        accessorKey: "productName",
        header: t().purchases.product,
        enableSorting: false,
        cell: ({ row }) => (
          <Link
            href={`/stock/${row.original.productId}`}
            className="font-medium hover:underline"
          >
            {row.original.productName}
          </Link>
        ),
      },
      { accessorKey: "size", header: t().sales.size, enableSorting: false },
      {
        accessorKey: "color",
        header: t().sales.color,
        enableSorting: false,
        cell: ({ row }) => row.original.color ?? "—",
      },
      {
        accessorKey: "currentQty",
        header: t().reports.currentQty,
        enableSorting: false,
        cell: ({ row }) => (
          <span className="tabular-nums">{row.original.currentQty}</span>
        ),
      },
      {
        accessorKey: "unitsSoldInLookback",
        header: t().reports.unitsSoldInWindow,
        enableSorting: false,
        cell: ({ row }) => (
          <span className="tabular-nums">{row.original.unitsSoldInLookback}</span>
        ),
      },
      {
        accessorKey: "averageDailyUnits",
        header: t().reports.avgDailyUnits,
        enableSorting: false,
        cell: ({ row }) => (
          <span className="tabular-nums">
            {(Math.round(row.original.averageDailyUnits * 100) / 100).toFixed(2)}
          </span>
        ),
      },
      {
        accessorKey: "estimatedDaysRemaining",
        header: t().reports.daysRemainingCol,
        enableSorting: false,
        cell: ({ row }) => {
          // Urgency at a glance: out of stock now = red, inside the cover
          // window = amber, comfortable = plain.
          const days = row.original.estimatedDaysRemaining;
          const urgent = days <= 0 || row.original.currentQty <= 0;
          const soon = !urgent && days < targetDays;
          return (
            <span
              className={
                urgent
                  ? "font-medium tabular-nums text-destructive"
                  : soon
                    ? "font-medium tabular-nums text-warning"
                    : "tabular-nums"
              }
            >
              {urgent ? "0" : String(days)}
            </span>
          );
        },
      },
      {
        accessorKey: "suggestedReorderQty",
        header: t().reports.suggestedReorderQty,
        enableSorting: false,
        cell: ({ row }) => (
          <span className="font-semibold tabular-nums">
            {row.original.suggestedReorderQty}
          </span>
        ),
      },
      {
        accessorKey: "estimatedReorderCost",
        header: t().reports.estimatedReorderCost,
        enableSorting: false,
        cell: ({ row }) => (
          <span className="tabular-nums">
            {formatMoney(row.original.estimatedReorderCost, currency, lang)}
          </span>
        ),
      },
    ],
    [currency, lang, targetDays],
  );

  return (
    <div className="flex w-full flex-col">
      <PageToolbar icon={ClipboardCheckIcon} title={t().reports.reportReorder}>
        <InputGroup className="h-9 w-full sm:w-64">
          <InputGroupAddon>
            <HugeiconsIcon icon={Search01Icon} strokeWidth={2} className="size-4" />
          </InputGroupAddon>
          <InputGroupInput
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              resetPages();
            }}
            placeholder={t().reports.searchInventory}
          />
        </InputGroup>
        <Select
          value={String(lookbackDays)}
          items={Object.fromEntries(WINDOWS.map((d) => [String(d), windowLabel(d)]))}
          onValueChange={(value) => {
            setLookbackDays(Number(value ?? 30) as Window);
            resetPages();
          }}
        >
          <SelectTrigger className="w-full sm:w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {WINDOWS.map((days) => (
              <SelectItem key={days} value={String(days)}>
                {t().reports.lookbackWindow}: {windowLabel(days)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={String(targetDays)}
          items={Object.fromEntries(WINDOWS.map((d) => [String(d), windowLabel(d)]))}
          onValueChange={(value) => {
            setTargetDays(Number(value ?? 30) as Window);
            resetPages();
          }}
        >
          <SelectTrigger className="w-full sm:w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {WINDOWS.map((days) => (
              <SelectItem key={days} value={String(days)}>
                {t().reports.targetCover}: {windowLabel(days)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </PageToolbar>

      <div className="flex flex-col gap-4 p-4">
        <p className="text-sm text-muted-foreground">
          {report?.asOfDay
            ? `${t().reports.reorderAsOf.replace("{day}", report.asOfDay)} · `
            : ""}
          {t().reports.reorderHint}
        </p>
        <div className="grid gap-3 sm:grid-cols-3">
          <Summary
            label={t().reports.reorderTotalsVariants}
            value={String(report?.totals.variantCount ?? 0)}
          />
          <Summary
            label={t().reports.reorderTotalsUnits}
            value={String(report?.totals.suggestedUnits ?? 0)}
          />
          <Summary
            label={t().reports.estimatedReorderCost}
            value={formatMoney(
              report?.totals.estimatedReorderCost ?? 0,
              currency,
              lang,
            )}
          />
        </div>
        <DataTable
          columns={columns}
          data={(report?.page ?? []) as ReorderRow[]}
          persistKey="reports-reorder-planning"
          loading={report === undefined}
          totalCount={
            report !== undefined && report.total === 0 ? undefined : report?.total
          }
          pageIndex={pageIndex}
          pageSize={pageSize}
          onPageSizeChange={(size) => {
            setPageSize(size);
            resetPages();
          }}
          onPageChange={(direction) => {
            if (direction === "prev") setPageIndex((index) => Math.max(0, index - 1));
            else if (report?.continueCursor) {
              setCursors((current) =>
                current[pageIndex] === undefined
                  ? [...current, report.continueCursor]
                  : current,
              );
              setPageIndex((index) => index + 1);
            }
          }}
          cardRender={(row) => (
            <ReorderCard row={row} currency={currency} targetDays={targetDays} />
          )}
        />
      </div>
    </div>
  );
}

function Summary({ label, value }: { label: string; value: string }) {
  return (
    <Card>
      <CardHeader className="pb-1">
        <CardTitle className="text-sm font-medium text-muted-foreground">
          {label}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <p className="font-heading text-2xl font-semibold tabular-nums">{value}</p>
      </CardContent>
    </Card>
  );
}

function ReorderCard({
  row,
  currency,
  targetDays,
}: {
  row: ReorderRow;
  currency: string;
  targetDays: number;
}) {
  const lang = getLang();
  const urgent = row.estimatedDaysRemaining <= 0 || row.currentQty <= 0;
  const soon = !urgent && row.estimatedDaysRemaining < targetDays;
  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-2">
        <div>
          <CardTitle>
            <Link href={`/stock/${row.productId}`} className="hover:underline">
              {row.productName}
            </Link>
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            {[row.size, row.color, row.sku].filter(Boolean).join(" · ")}
          </p>
        </div>
        <BadgeTone urgent={urgent} soon={soon} />
      </CardHeader>
      <CardContent className="grid gap-3">
        <div className="grid grid-cols-3 gap-2 text-sm">
          <Metric label={t().reports.currentQty} value={String(row.currentQty)} />
          <Metric
            label={t().reports.avgDailyUnits}
            value={(Math.round(row.averageDailyUnits * 100) / 100).toFixed(2)}
          />
          <Metric
            label={t().reports.daysRemainingCol}
            value={urgent ? "0" : String(row.estimatedDaysRemaining)}
          />
        </div>
        <div className="flex items-center justify-between rounded-md border bg-muted/40 p-2">
          <span className="text-sm text-muted-foreground">
            {t().reports.suggestedReorderQty}
          </span>
          <span className="text-base font-bold tabular-nums">
            {row.suggestedReorderQty}
          </span>
        </div>
        <p className="text-sm text-muted-foreground">
          {t().reports.estimatedReorderCost}:{" "}
          {formatMoney(row.estimatedReorderCost, currency, lang)}
        </p>
      </CardContent>
    </Card>
  );
}

function BadgeTone({ urgent, soon }: { urgent: boolean; soon: boolean }) {
  if (urgent) {
    return (
      <span className="shrink-0 rounded-full bg-destructive/10 px-2 py-0.5 text-xs font-medium text-destructive">
        {t().stock.statusOutOfStock}
      </span>
    );
  }
  if (soon) {
    return (
      <span className="shrink-0 rounded-full bg-warning/10 px-2 py-0.5 text-xs font-medium text-warning">
        {t().stock.statusLowStock}
      </span>
    );
  }
  return null;
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-md border p-2">
      <p className="truncate text-xs text-muted-foreground">{label}</p>
      <p className="truncate font-medium">{value}</p>
    </div>
  );
}
