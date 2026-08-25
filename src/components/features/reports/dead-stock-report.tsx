"use client";

import { PackageReceive01Icon, Search01Icon } from "@hugeicons/core-free-icons";
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
import { Badge } from "@/components/ui/badge";
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
import { formatDateTime, formatMoney, getLang, t } from "@/lib/utils";

type Threshold = 30 | 60 | 90 | 180;
type DeadStockRow = {
  productId: Id<"products">;
  variantId: Id<"productVariants">;
  productName: string;
  size: string;
  color?: string;
  sku?: string;
  active: boolean;
  currentQty: number;
  lastSoldAt?: number;
  ageDays: number;
  weightedLandedUnitCost: number;
  tiedUpValue: number;
};

const THRESHOLDS: Threshold[] = [30, 60, 90, 180];

export function DeadStockReport() {
  const user = useCurrentUser();
  const shop = useShop();
  const [search, setSearch] = usePersistentState("reports:deadStock:search", "");
  const deferredSearch = useDeferredValue(search);
  const [threshold, setThreshold] = usePersistentState<Threshold>(
    "reports:deadStock:threshold",
    90
  );
  const [pageSize, setPageSize] = usePersistentState("reports:deadStock:pageSize", 20);
  const [pageIndex, setPageIndex] = useState(0);
  const [cursors, setCursors] = useState<string[]>([]);
  const currency = shop?.currency ?? "USD";
  const timezone = shop?.timezone ?? "Asia/Phnom_Penh";
  const lang = getLang();

  function resetPages() {
    setPageIndex(0);
    setCursors([]);
  }

  const report = useQuery(
    api.reports.getDeadStockReport,
    user == null
      ? "skip"
      : {
          thresholdDays: threshold,
          search: deferredSearch.trim() || undefined,
          paginationOpts: {
            numItems: pageSize,
            cursor: pageIndex === 0 ? null : (cursors[pageIndex - 1] ?? null),
          },
        }
  );

  const columns = useMemo<DataTableColumn<DeadStockRow>[]>(
    () => [
      {
        accessorKey: "productName",
        header: t().purchases.product,
        enableSorting: false,
        cell: ({ row }) => (
          <Link href={`/stock/${row.original.productId}`} className="font-medium hover:underline">
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
      },
      {
        accessorKey: "ageDays",
        header: t().reports.daysWithoutSale,
        enableSorting: false,
      },
      {
        accessorKey: "lastSoldAt",
        header: t().reports.lastSale,
        enableSorting: false,
        cell: ({ row }) =>
          row.original.lastSoldAt === undefined
            ? t().reports.neverSold
            : formatDateTime(row.original.lastSoldAt, timezone, lang),
      },
      {
        accessorKey: "weightedLandedUnitCost",
        header: t().reports.weightedLandedCost,
        enableSorting: false,
        cell: ({ row }) => formatMoney(row.original.weightedLandedUnitCost, currency, lang),
      },
      {
        accessorKey: "tiedUpValue",
        header: t().reports.tiedUpValue,
        enableSorting: false,
        cell: ({ row }) => (
          <span className="font-medium tabular-nums">
            {formatMoney(row.original.tiedUpValue, currency, lang)}
          </span>
        ),
      },
      {
        accessorKey: "active",
        header: t().stock.statusCol,
        enableSorting: false,
        cell: ({ row }) => (
          <Badge variant={row.original.active ? "success" : "secondary"}>
            {row.original.active ? t().common.active : t().common.inactive}
          </Badge>
        ),
      },
    ],
    [currency, lang, timezone]
  );

  return (
    <div className="flex w-full flex-col">
      <PageToolbar icon={PackageReceive01Icon} title={t().reports.reportDeadStock}>
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
          value={String(threshold)}
          items={Object.fromEntries(
            THRESHOLDS.map((days) => [String(days), t().reports.daysThreshold.replace("{days}", String(days))])
          )}
          onValueChange={(value) => {
            setThreshold(Number(value ?? 90) as Threshold);
            resetPages();
          }}
        >
          <SelectTrigger className="w-full sm:w-44"><SelectValue /></SelectTrigger>
          <SelectContent>
            {THRESHOLDS.map((days) => (
              <SelectItem key={days} value={String(days)}>
                {t().reports.daysThreshold.replace("{days}", String(days))}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </PageToolbar>

      <div className="flex flex-col gap-4 p-4">
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
          <Summary label={t().reports.tiedUpValue} value={formatMoney(report?.totals.tiedUpValue ?? 0, currency, lang)} />
          <Summary label={t().reports.totalUnits} value={String(report?.totals.totalUnits ?? 0)} />
          <Summary label={t().reports.variantCount} value={String(report?.totals.variantCount ?? 0)} />
          <Summary label={t().reports.neverSold} value={String(report?.totals.neverSoldCount ?? 0)} />
          <Summary label={t().reports.inactiveStockRows} value={String(report?.totals.inactiveVariantCount ?? 0)} />
        </div>
        <p className="text-sm text-muted-foreground">{t().reports.deadStockHint}</p>
        <DataTable
          columns={columns}
          data={(report?.page ?? []) as DeadStockRow[]}
          persistKey="reports-dead-stock"
          loading={report === undefined}
          totalCount={report?.total}
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
                current[pageIndex] === undefined ? [...current, report.continueCursor] : current
              );
              setPageIndex((index) => index + 1);
            }
          }}
          cardRender={(row) => (
            <DeadStockCard row={row} currency={currency} timezone={timezone} lang={lang} />
          )}
        />
      </div>
    </div>
  );
}

function Summary({ label, value }: { label: string; value: string }) {
  return (
    <Card>
      <CardHeader className="pb-1"><CardTitle className="text-sm font-medium text-muted-foreground">{label}</CardTitle></CardHeader>
      <CardContent><p className="font-heading text-2xl font-semibold tabular-nums">{value}</p></CardContent>
    </Card>
  );
}

function DeadStockCard({ row, currency, timezone, lang }: { row: DeadStockRow; currency: string; timezone: string; lang: ReturnType<typeof getLang> }) {
  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-2">
        <div>
          <CardTitle><Link href={`/stock/${row.productId}`} className="hover:underline">{row.productName}</Link></CardTitle>
          <p className="text-sm text-muted-foreground">{[row.size, row.color, row.sku].filter(Boolean).join(" · ")}</p>
        </div>
        <Badge variant={row.active ? "success" : "secondary"}>{row.active ? t().common.active : t().common.inactive}</Badge>
      </CardHeader>
      <CardContent className="grid gap-3">
        <div className="grid grid-cols-3 gap-2 text-sm">
          <Metric label={t().reports.currentQty} value={String(row.currentQty)} />
          <Metric label={t().reports.daysWithoutSale} value={String(row.ageDays)} />
          <Metric label={t().reports.tiedUpValue} value={formatMoney(row.tiedUpValue, currency, lang)} />
        </div>
        <p className="text-sm text-muted-foreground">
          {t().reports.lastSale}: {row.lastSoldAt === undefined ? t().reports.neverSold : formatDateTime(row.lastSoldAt, timezone, lang)}
        </p>
      </CardContent>
    </Card>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="min-w-0 rounded-md border p-2"><p className="truncate text-xs text-muted-foreground">{label}</p><p className="truncate font-medium">{value}</p></div>;
}
