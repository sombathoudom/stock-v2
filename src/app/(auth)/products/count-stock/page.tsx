"use client";

import {
  ClipboardIcon,
  Download01Icon,
  Search01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useQuery } from "convex/react";
import { useMemo, useState } from "react";
import * as XLSX from "xlsx";

import { api } from "@convex/_generated/api";
import type { Doc } from "@convex/_generated/dataModel";
import {
  DataTable,
  type DataTableColumn,
} from "@/components/features/data-table/data-table";
import { PageToolbar } from "@/components/features/shell/page-toolbar";
import { Button } from "@/components/ui/button";
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
import { t } from "@/lib/utils";

// Count Stock page — lists all products with their variant stock counts.
// Users can filter by category or see everything, then download as XLSX.

type CountStockVariant = {
  size: string;
  color?: string;
  sku?: string;
  qty: number;
};

type CountStockProduct = {
  productName: string;
  categoryName: string;
  variants: CountStockVariant[];
  totalQty: number;
};

/** Flatten the product-level data into one row per variant for the table. */
type FlatRow = {
  id: string;
  productName: string;
  categoryName: string;
  size: string;
  color: string;
  sku: string;
  qty: number;
};

export default function CountStockPage() {
  const user = useCurrentUser();
  const categoriesQuery = useQuery(
    api.categories.listAll,
    user == null ? "skip" : {},
  );

  const [categoryFilter, setCategoryFilter] = usePersistentState(
    "countStock:categoryFilter",
    "all",
  );
  const [search, setSearch] = usePersistentState("countStock:search", "");
  const [pageSize, setPageSize] = usePersistentState("countStock:pageSize", 20);
  const [pageIndex, setPageIndex] = useState(0);
  const [cursors, setCursors] = useState<string[]>([]);

  const data = useQuery(
    api.stock.countStock,
    user == null
      ? "skip"
      : {
          categoryId:
            categoryFilter !== "all"
              ? (categoryFilter as Doc<"categories">["_id"])
              : undefined,
        },
  );

  function resetPages() {
    setPageIndex(0);
    setCursors([]);
  }

  // Flatten products into variant-level rows for the table.
  const flatRows = useMemo<FlatRow[]>(() => {
    if (!data) return [];
    const rows: FlatRow[] = [];
    for (const product of data) {
      for (const v of product.variants) {
        rows.push({
          id: `${product.productName}-${v.size}-${v.color ?? ""}-${v.sku ?? ""}`,
          productName: product.productName,
          categoryName: product.categoryName,
          size: v.size,
          color: v.color ?? "",
          sku: v.sku ?? "",
          qty: v.qty,
        });
      }
    }
    return rows;
  }, [data]);

  // Client-side search filter.
  const filteredRows = useMemo(() => {
    if (!search.trim()) return flatRows;
    const term = search.trim().toLowerCase();
    return flatRows.filter(
      (r) =>
        r.productName.toLowerCase().includes(term) ||
        r.size.toLowerCase().includes(term) ||
        r.color.toLowerCase().includes(term) ||
        r.sku.toLowerCase().includes(term),
    );
  }, [flatRows, search]);

  // Paginate the filtered rows client-side.
  const paginatedRows = useMemo(() => {
    const start = pageIndex * pageSize;
    return filteredRows.slice(start, start + pageSize);
  }, [filteredRows, pageIndex, pageSize]);

  const totalPages = Math.max(1, Math.ceil(filteredRows.length / pageSize));

  // Summary stats.
  const summary = useMemo(() => {
    if (!data) return { products: 0, variants: 0, units: 0 };
    const activeProducts = data.filter((p) => p.variants.length > 0);
    return {
      products: activeProducts.length,
      variants: activeProducts.reduce((s, p) => s + p.variants.length, 0),
      units: activeProducts.reduce((s, p) => s + p.totalQty, 0),
    };
  }, [data]);

  // Download the full data as XLSX.
  function downloadXlsx() {
    if (!data) return;
    const labels = t().countStock;

    // Build flat rows for the spreadsheet — one row per variant.
    const rows: (string | number)[][] = [
      [
        labels.productCol,
        labels.categoryCol,
        labels.sizeCol,
        labels.colorCol,
        labels.skuCol,
        labels.qtyCol,
      ],
    ];
    for (const product of data) {
      for (const v of product.variants) {
        rows.push([
          product.productName,
          product.categoryName,
          v.size,
          v.color ?? "",
          v.sku ?? "",
          v.qty,
        ]);
      }
    }

    // Summary row.
    rows.push([]);
    rows.push([labels.grandTotal]);
    rows.push([labels.totalProducts, summary.products]);
    rows.push([labels.totalVariants, summary.variants]);
    rows.push([labels.totalUnits, summary.units]);

    const ws = XLSX.utils.aoa_to_sheet(rows);

    // Auto-size columns.
    const colWidths = rows[0].map((_, colIdx) => {
      let max = 10;
      for (const row of rows) {
        const cell = row[colIdx];
        if (cell !== undefined && cell !== null) {
          max = Math.max(max, String(cell).length + 2);
        }
      }
      return { wch: Math.min(max, 40) };
    });
    ws["!cols"] = colWidths;

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Stock Count");
    XLSX.writeFile(
      wb,
      `stock-count-${new Date().toISOString().slice(0, 10)}.xlsx`,
    );
  }

  const columns = useMemo<DataTableColumn<FlatRow>[]>(
    () => [
      {
        id: "productName",
        accessorKey: "productName",
        header: t().countStock.productCol,
        enableSorting: false,
        cell: ({ row }) => (
          <span className="font-semibold">{row.original.productName}</span>
        ),
      },
      {
        id: "categoryName",
        accessorKey: "categoryName",
        header: t().countStock.categoryCol,
        enableSorting: false,
        meta: {
          headerClassName: "hidden md:table-cell",
          cellClassName: "hidden md:table-cell",
        },
        cell: ({ row }) => (
          <span className="text-sm text-muted-foreground">
            {row.original.categoryName}
          </span>
        ),
      },
      {
        id: "size",
        accessorKey: "size",
        header: t().countStock.sizeCol,
        enableSorting: false,
        cell: ({ row }) => row.original.size,
      },
      {
        id: "color",
        accessorKey: "color",
        header: t().countStock.colorCol,
        enableSorting: false,
        meta: {
          headerClassName: "hidden sm:table-cell",
          cellClassName: "hidden sm:table-cell",
        },
        cell: ({ row }) => row.original.color || "—",
      },
      {
        id: "sku",
        accessorKey: "sku",
        header: t().countStock.skuCol,
        enableSorting: false,
        meta: {
          headerClassName: "hidden lg:table-cell",
          cellClassName: "hidden lg:table-cell",
        },
        cell: ({ row }) => row.original.sku || "—",
      },
      {
        id: "qty",
        accessorKey: "qty",
        header: t().countStock.qtyCol,
        enableSorting: false,
        meta: { headerClassName: "text-end" },
        cell: ({ row }) => (
          <span className="block text-end font-mono tabular-nums">
            {row.original.qty}
          </span>
        ),
      },
    ],
    // Built once per language like every other list page (repo convention).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  return (
    <div className="flex w-full flex-col">
      <PageToolbar icon={ClipboardIcon} title={t().countStock.title}>
        <InputGroup className="w-full sm:w-64">
          <InputGroupAddon>
            <HugeiconsIcon
              icon={Search01Icon}
              strokeWidth={2}
              className="size-4"
            />
          </InputGroupAddon>
          <InputGroupInput
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              resetPages();
            }}
            placeholder={t().stock.searchPlaceholder}
            aria-label={t().stock.searchPlaceholder}
          />
        </InputGroup>
        <Select
          value={categoryFilter}
          items={{
            all: t().countStock.allCategories,
            ...Object.fromEntries(
              (categoriesQuery ?? []).map((c) => [c._id, c.name]),
            ),
          }}
          onValueChange={(value) => {
            setCategoryFilter(value ?? "all");
            resetPages();
          }}
        >
          <SelectTrigger className="w-40" aria-label={t().products.category}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">
              {t().countStock.allCategories}
            </SelectItem>
            {(categoriesQuery ?? []).map((c) => (
              <SelectItem key={c._id} value={c._id}>
                {c.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          type="button"
          variant="outline"
          onClick={downloadXlsx}
          disabled={data === undefined || data.length === 0}
        >
          <HugeiconsIcon
            icon={Download01Icon}
            strokeWidth={2}
            className="size-4"
          />
          {t().countStock.downloadXlsx}
        </Button>
      </PageToolbar>

      {/* Summary cards */}
      <div className="grid grid-cols-3 gap-3 px-4 pt-4 sm:gap-4">
        <Card>
          <CardContent className="flex flex-col items-center py-3 sm:py-4">
            <span className="text-xs text-muted-foreground sm:text-sm">
              {t().countStock.totalProducts}
            </span>
            <span className="text-lg font-bold sm:text-2xl">
              {summary.products}
            </span>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="flex flex-col items-center py-3 sm:py-4">
            <span className="text-xs text-muted-foreground sm:text-sm">
              {t().countStock.totalVariants}
            </span>
            <span className="text-lg font-bold sm:text-2xl">
              {summary.variants}
            </span>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="flex flex-col items-center py-3 sm:py-4">
            <span className="text-xs text-muted-foreground sm:text-sm">
              {t().countStock.totalUnits}
            </span>
            <span className="text-lg font-bold sm:text-2xl">
              {summary.units}
            </span>
          </CardContent>
        </Card>
      </div>

      <div className="p-4">
        <DataTable
          columns={columns}
          data={paginatedRows}
          getRowId={(row) => row.id}
          persistKey="countStock"
          loading={data === undefined}
          totalCount={filteredRows.length}
          pageIndex={pageIndex}
          pageSize={pageSize}
          onPageSizeChange={(size) => {
            setPageSize(size);
            resetPages();
          }}
          onPageChange={(direction) => {
            if (direction === "prev") {
              setPageIndex((i) => Math.max(0, i - 1));
            } else if (pageIndex < totalPages - 1) {
              setPageIndex((i) => i + 1);
            }
          }}
          cardRender={(row) => (
            <Card>
              <CardHeader className="flex-row items-center justify-between gap-3 pb-2">
                <CardTitle className="truncate text-base font-semibold">
                  {row.productName}
                </CardTitle>
                <span className="font-mono text-lg tabular-nums">
                  {row.qty}
                </span>
              </CardHeader>
              <CardContent className="flex flex-col gap-1 pt-0">
                <div className="flex items-center justify-between text-sm text-muted-foreground">
                  <span>
                    {row.size}
                    {row.color ? ` / ${row.color}` : ""}
                  </span>
                  {row.sku && <span className="font-mono">{row.sku}</span>}
                </div>
                <div className="text-xs text-muted-foreground">
                  {row.categoryName}
                </div>
              </CardContent>
            </Card>
          )}
        />
      </div>
    </div>
  );
}
