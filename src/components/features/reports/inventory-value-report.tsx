"use client";

import { Calculator01Icon, Search01Icon } from "@hugeicons/core-free-icons";
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
import { formatMoney, getLang, t } from "@/lib/utils";

type StatusFilter = "all" | "active" | "inactive";
type InventoryValueRow = {
  productId: Id<"products">;
  variantId: Id<"productVariants">;
  productName: string;
  productCode?: string;
  size: string;
  color?: string;
  sku?: string;
  productActive: boolean;
  variantActive: boolean;
  active: boolean;
  currentQty: number;
  weightedLandedUnitCost: number;
  totalValue: number;
};

export function InventoryValueReport() {
  const user = useCurrentUser();
  const shop = useShop();
  const [search, setSearch] = usePersistentState("reports:inventoryValue:search", "");
  const deferredSearch = useDeferredValue(search);
  const [status, setStatus] = usePersistentState<StatusFilter>(
    "reports:inventoryValue:status",
    "all"
  );
  const [pageSize, setPageSize] = usePersistentState(
    "reports:inventoryValue:pageSize",
    20
  );
  const [pageIndex, setPageIndex] = useState(0);
  const [cursors, setCursors] = useState<string[]>([]);
  const currency = shop?.currency ?? "USD";
  const lang = getLang();

  function resetPages() {
    setPageIndex(0);
    setCursors([]);
  }

  const report = useQuery(
    api.reports.getInventoryValueReport,
    user == null
      ? "skip"
      : {
          search: deferredSearch.trim() || undefined,
          status,
          paginationOpts: {
            numItems: pageSize,
            cursor: pageIndex === 0 ? null : (cursors[pageIndex - 1] ?? null),
          },
        }
  );

  const columns = useMemo<DataTableColumn<InventoryValueRow>[]>(
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
        accessorKey: "sku",
        header: t().sales.sku,
        enableSorting: false,
        cell: ({ row }) => row.original.sku ?? "—",
      },
      {
        accessorKey: "active",
        header: t().stock.statusCol,
        enableSorting: false,
        cell: ({ row }) => <ActiveBadge active={row.original.active} />,
      },
      {
        accessorKey: "currentQty",
        header: t().reports.currentQty,
        enableSorting: false,
        cell: ({ row }) => (
          <span className={row.original.currentQty < 0 ? "tabular-nums text-destructive" : "tabular-nums"}>
            {row.original.currentQty}
          </span>
        ),
      },
      {
        accessorKey: "weightedLandedUnitCost",
        header: t().reports.weightedLandedCost,
        enableSorting: false,
        cell: ({ row }) => formatMoney(row.original.weightedLandedUnitCost, currency, lang),
      },
      {
        accessorKey: "totalValue",
        header: t().reports.totalValue,
        enableSorting: false,
        cell: ({ row }) => (
          <span className="font-medium tabular-nums">
            {formatMoney(row.original.totalValue, currency, lang)}
          </span>
        ),
      },
    ],
    [currency, lang]
  );

  return (
    <div className="flex w-full flex-col">
      <PageToolbar icon={Calculator01Icon} title={t().reports.reportInventoryValue}>
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
            aria-label={t().reports.searchInventory}
          />
        </InputGroup>
        <Select
          value={status}
          items={{
            all: t().reports.allInventory,
            active: t().common.active,
            inactive: t().common.inactive,
          }}
          onValueChange={(value) => {
            setStatus((value ?? "all") as StatusFilter);
            resetPages();
          }}
        >
          <SelectTrigger className="w-full sm:w-36"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t().reports.allInventory}</SelectItem>
            <SelectItem value="active">{t().common.active}</SelectItem>
            <SelectItem value="inactive">{t().common.inactive}</SelectItem>
          </SelectContent>
        </Select>
      </PageToolbar>

      <div className="flex flex-col gap-4 p-4">
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <SummaryCard label={t().reports.totalValue} value={formatMoney(report?.totals.totalValue ?? 0, currency, lang)} />
          <SummaryCard label={t().reports.totalUnits} value={String(report?.totals.totalUnits ?? 0)} />
          <SummaryCard label={t().reports.variantCount} value={String(report?.totals.variantCount ?? 0)} />
          <SummaryCard label={t().reports.inactiveStockRows} value={String(report?.totals.inactiveVariantCount ?? 0)} />
        </div>
        <p className="text-sm text-muted-foreground">{t().reports.inventoryValueHint}</p>
        <DataTable
          columns={columns}
          data={(report?.page ?? []) as InventoryValueRow[]}
          persistKey="reports-inventory-value"
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
          cardRender={(row) => <InventoryValueCard row={row} currency={currency} lang={lang} />}
        />
      </div>
    </div>
  );
}

function ActiveBadge({ active }: { active: boolean }) {
  return <Badge variant={active ? "success" : "secondary"}>{active ? t().common.active : t().common.inactive}</Badge>;
}

function SummaryCard({ label, value }: { label: string; value: string }) {
  return <Card><CardHeader className="pb-1"><CardTitle className="text-sm font-medium text-muted-foreground">{label}</CardTitle></CardHeader><CardContent><p className="font-heading text-2xl font-semibold tabular-nums">{value}</p></CardContent></Card>;
}

function InventoryValueCard({ row, currency, lang }: { row: InventoryValueRow; currency: string; lang: ReturnType<typeof getLang> }) {
  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-2">
        <div className="min-w-0">
          <CardTitle><Link href={`/stock/${row.productId}`} className="hover:underline">{row.productName}</Link></CardTitle>
          <p className="text-sm text-muted-foreground">{[row.size, row.color, row.sku].filter(Boolean).join(" · ")}</p>
        </div>
        <ActiveBadge active={row.active} />
      </CardHeader>
      <CardContent className="grid grid-cols-3 gap-2 text-sm">
        <Value label={t().reports.currentQty} value={String(row.currentQty)} destructive={row.currentQty < 0} />
        <Value label={t().reports.weightedLandedCost} value={formatMoney(row.weightedLandedUnitCost, currency, lang)} />
        <Value label={t().reports.totalValue} value={formatMoney(row.totalValue, currency, lang)} strong />
      </CardContent>
    </Card>
  );
}

function Value({ label, value, destructive = false, strong = false }: { label: string; value: string; destructive?: boolean; strong?: boolean }) {
  return <div className="min-w-0 rounded-md border p-2"><p className="truncate text-xs text-muted-foreground">{label}</p><p className={destructive ? "truncate font-medium text-destructive" : strong ? "truncate font-semibold" : "truncate font-medium"}>{value}</p></div>;
}
