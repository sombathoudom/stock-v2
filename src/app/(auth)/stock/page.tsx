"use client";

import {
  ChevronRightIcon,
  Download01Icon,
  Image01Icon,
  Search01Icon,
  Table01Icon,
  WarehouseIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ColumnVisibilityState } from "@tanstack/react-table";
import { useConvex, useQuery } from "convex/react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { api } from "@convex/_generated/api";
import type { Doc } from "@convex/_generated/dataModel";
import {
  columnIdOf,
  columnLabelOfDef,
  DataTable,
  type DataTableColumn,
} from "@/components/features/data-table/data-table";
import { PageToolbar } from "@/components/features/shell/page-toolbar";
import { ReorderAlert } from "@/components/features/stock/reorder-alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
import { useCurrentUser } from "@/hooks/use-current-user";
import { usePersistentState } from "@/hooks/use-persistent-state";
import {
  centsToDecimal,
  downloadCsv,
  formatDateTime,
  getLang,
  imageUrl,
  t,
  toastError,
} from "@/lib/utils";

// T6 — Stock list (AGENTS.md). Rows are products; each row shows the
// available stock (sum of ledger deltas, never a stored counter), a compact
// variant summary (count + size chips — never a long comma list), the status
// badge and the newest stock movement time ("Last updated" — products have
// no updatedAt field, so the newest movement is the honest value). The whole
// row opens the product's variant page; the flow is
// Stock list → View variants → View movements.

type StockRow = {
  product: Doc<"products">;
  variants: {
    variant: Doc<"productVariants">;
    qty: number;
    lastMovementTs?: number;
  }[];
  totalQty: number;
  variantCount: number;
  sizeChips: { sizes: string[]; overflow: number };
  status: "in" | "low" | "out";
  lastUpdated?: number;
};

function StatusBadge({ status }: { status: StockRow["status"] }) {
  const labels = t().stock;
  if (status === "out") {
    return <Badge variant="destructive">{labels.statusOutOfStock}</Badge>;
  }
  if (status === "low") {
    return <Badge variant="warning">{labels.statusLowStock}</Badge>;
  }
  return <Badge variant="success">{labels.statusInStock}</Badge>;
}

/** First 3 unique sizes as chips + a "+N" overflow badge. */
function VariantChips({ chips }: { chips: StockRow["sizeChips"] }) {
  const labels = t().stock;
  return (
    <>
      {chips.sizes.map((size) => (
        <Badge key={size} variant="secondary">
          {size}
        </Badge>
      ))}
      {chips.overflow > 0 && (
        <Badge variant="outline">
          {labels.plusN.replace("{n}", String(chips.overflow))}
        </Badge>
      )}
    </>
  );
}

export default function StockPage() {
  const user = useCurrentUser();
  const convex = useConvex();
  const router = useRouter();
  const lang = getLang();
  const shop = useQuery(api.shop.get, user == null ? "skip" : {});
  const timezone = shop?.timezone ?? "Asia/Phnom_Penh";
  const threshold = shop?.lowStockThreshold ?? 5;
  const [exporting, setExporting] = useState(false);

  // T23 — the reorder alert: the same shared low-stock walk the dashboard
  // card and the nav badge read, so the three can never disagree.
  const low = useQuery(api.lowStock.lowStock, user == null ? "skip" : {});

  const [search, setSearch] = usePersistentState("stock:search", "");
  const [debouncedSearch, setDebouncedSearch] = useState(search);
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const [pageSize, setPageSize] = usePersistentState("stock:pageSize", 20);
  const [pageIndex, setPageIndex] = useState(0);
  const [cursors, setCursors] = useState<string[]>([]);

  // Column visibility is hosted in the page header's Columns menu; the same
  // `dt:stock:visibility` store the DataTable would otherwise own.
  const [columnVisibility, setColumnVisibility] =
    usePersistentState<ColumnVisibilityState>("dt:stock:visibility", {});

  const list = useQuery(
    api.stock.list,
    user == null
      ? "skip"
      : {
          paginationOpts: {
            numItems: pageSize,
            cursor: pageIndex === 0 ? null : (cursors[pageIndex - 1] ?? null),
          },
          search: debouncedSearch.trim() || undefined,
        },
  );

  function resetPages() {
    setPageIndex(0);
    setCursors([]);
  }

  function toggleColumn(id: string, visible: boolean) {
    setColumnVisibility((prev) => {
      const next = { ...prev };
      if (visible) delete next[id];
      else next[id] = false;
      return next;
    });
  }

  // T24 — one-shot stock CSV export: the server walks active variants and
  // computes every qty and price; the client only builds the file.
  async function exportStockCsv() {
    try {
      setExporting(true);
      const rows = await convex.query(api.stock.stockCsv, {});
      downloadCsv(`stock-${new Date().toISOString().slice(0, 10)}.csv`, [
        [
          t().stock.productCol,
          t().stock.sizeCol,
          t().stock.colorCol,
          t().stock.skuCol,
          t().stock.qtyCol,
          t().products.defaultPrice,
        ],
        ...rows.map((r) => [
          r.productName,
          r.size,
          r.color ?? "",
          r.sku ?? "",
          r.qty,
          centsToDecimal(r.price),
        ]),
      ]);
      toast.success(t().stock.exportDone);
    } catch (err) {
      toastError(err);
    } finally {
      setExporting(false);
    }
  }

  const rows = useMemo<StockRow[]>(
    () =>
      (list?.page ?? []).map((item) => {
        const totalQty = item.variants.reduce((sum, v) => sum + v.qty, 0);
        const uniqueSizes = [
          ...new Set(item.variants.map((v) => v.variant.size)),
        ];
        let lastUpdated: number | undefined;
        for (const v of item.variants) {
          if (
            v.lastMovementTs !== undefined &&
            (lastUpdated === undefined || v.lastMovementTs > lastUpdated)
          ) {
            lastUpdated = v.lastMovementTs;
          }
        }
        return {
          product: item.product,
          variants: item.variants,
          totalQty,
          variantCount: item.variants.length,
          sizeChips: {
            sizes: uniqueSizes.slice(0, 3),
            overflow: Math.max(0, uniqueSizes.length - 3),
          },
          status: totalQty === 0 ? "out" : totalQty <= threshold ? "low" : "in",
          ...(lastUpdated !== undefined ? { lastUpdated } : {}),
        };
      }),
    [list, threshold],
  );

  const columns = useMemo<DataTableColumn<StockRow>[]>(
    () => [
      {
        id: "image",
        header: t().products.photo,
        enableSorting: false,
        cell: ({ row }) =>
          row.original.product.imageStorageId ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={imageUrl(row.original.product.imageStorageId)}
              alt={row.original.product.name}
              className="size-9 rounded-md border object-cover"
            />
          ) : (
            <span className="flex size-9 items-center justify-center rounded-md border bg-muted text-muted-foreground">
              <HugeiconsIcon icon={Image01Icon} strokeWidth={2} className="size-4" />
            </span>
          ),
      },
      {
        id: "product",
        accessorKey: "product.name",
        header: t().stock.productCol,
        enableSorting: false,
        cell: ({ row }) => (
          <span className="font-semibold">{row.original.product.name}</span>
        ),
      },
      {
        id: "variants",
        header: t().stock.variantsCol,
        enableSorting: false,
        cell: ({ row }) => (
          <span className="flex flex-wrap items-center gap-1.5">
            <span className="text-sm text-muted-foreground">
              {t().stock.variantsSummary.replace(
                "{n}",
                String(row.original.variantCount),
              )}
            </span>
            <VariantChips chips={row.original.sizeChips} />
          </span>
        ),
      },
      {
        id: "availableQty",
        header: t().stock.availableStock,
        enableSorting: false,
        meta: { headerClassName: "text-end" },
        cell: ({ row }) => (
          <span className="block text-end font-mono tabular-nums">
            {row.original.totalQty}
          </span>
        ),
      },
      {
        id: "status",
        header: t().stock.statusCol,
        enableSorting: false,
        cell: ({ row }) => <StatusBadge status={row.original.status} />,
      },
      {
        id: "lastUpdated",
        header: t().stock.lastUpdatedCol,
        enableSorting: false,
        // Hidden on tablets (768–1023) — Product / Available / Status /
        // Action stay; back on desktops (≥ lg).
        meta: {
          headerClassName: "hidden lg:table-cell",
          cellClassName: "hidden lg:table-cell",
        },
        cell: ({ row }) => (
          <span className="text-sm text-muted-foreground">
            {row.original.lastUpdated !== undefined
              ? formatDateTime(row.original.lastUpdated, timezone, lang)
              : "—"}
          </span>
        ),
      },
      {
        id: "actions",
        header: t().common.actions,
        enableSorting: false,
        cell: ({ row }) => (
          <Button
            variant="ghost"
            size="sm"
            onClick={(e) => {
              e.stopPropagation();
              router.push(`/stock/${row.original.product._id}`);
            }}
          >
            {t().stock.viewVariants}
            <HugeiconsIcon
              icon={ChevronRightIcon}
              strokeWidth={2}
              className="size-4"
            />
          </Button>
        ),
      },
    ],
    // Built once per language like every other list page (repo convention).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  return (
    <div className="flex w-full flex-col">
      <PageToolbar icon={WarehouseIcon} title={t().nav.stock}>
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
        <Button
          type="button"
          variant="outline"
          onClick={exportStockCsv}
          disabled={exporting}
        >
          <HugeiconsIcon icon={Download01Icon} strokeWidth={2} className="size-4" />
          {t().stock.exportCsv}
        </Button>
        {/* Columns menu — same visibility state the DataTable renders from. */}
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button variant="outline" />}>
            <HugeiconsIcon icon={Table01Icon} strokeWidth={2} className="size-4" />
            <span className="hidden sm:inline">{t().common.columns}</span>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {/* Base UI group parts must live inside a Menu.Group or they
                throw "MenuGroupContext is missing". */}
            <DropdownMenuGroup>
              <DropdownMenuLabel>{t().common.columns}</DropdownMenuLabel>
              {columns.map((col) => {
                const id = columnIdOf(col);
                if (id === "") return null;
                return (
                  <DropdownMenuCheckboxItem
                    key={id}
                    checked={columnVisibility[id] !== false}
                    onCheckedChange={(checked) => toggleColumn(id, checked)}
                  >
                    {columnLabelOfDef(col)}
                  </DropdownMenuCheckboxItem>
                );
              })}
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => setColumnVisibility({})}>
              {t().common.showAll}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </PageToolbar>

      {low !== undefined && low.items.length > 0 && (
        <div className="px-4 pt-4">
          <ReorderAlert items={low.items} threshold={low.threshold} />
        </div>
      )}

      <div className="p-4">
        <DataTable
          columns={columns}
          data={rows}
          getRowId={(row) => row.product._id}
          persistKey="stock"
          loading={list === undefined}
          onRowClick={(row) => router.push(`/stock/${row.product._id}`)}
          stickyHeader
          hideBuiltInColumnsMenu
          columnVisibility={columnVisibility}
          onColumnVisibilityChange={setColumnVisibility}
          totalCount={list?.total}
          pageIndex={pageIndex}
          pageSize={pageSize}
          onPageSizeChange={(size) => {
            setPageSize(size);
            resetPages();
          }}
          onPageChange={(direction) => {
            if (direction === "prev") {
              setPageIndex((i) => Math.max(0, i - 1));
            } else if (list?.continueCursor) {
              setCursors((c) =>
                c[pageIndex] === undefined ? [...c, list.continueCursor] : c,
              );
              setPageIndex((i) => i + 1);
            }
          }}
          cardRender={(row) => (
            // The whole card is the tap target — no inner button on phones.
            <Link href={`/stock/${row.product._id}`} className="block">
              <Card className="transition-colors hover:bg-muted/30">
                <CardHeader className="flex-row items-center justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-3">
                    {row.product.imageStorageId ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={imageUrl(row.product.imageStorageId)}
                        alt={row.product.name}
                        className="size-12 rounded-md border object-cover"
                      />
                    ) : (
                      <span className="flex size-12 items-center justify-center rounded-md border bg-muted text-muted-foreground">
                        <HugeiconsIcon
                          icon={Image01Icon}
                          strokeWidth={2}
                          className="size-5"
                        />
                      </span>
                    )}
                    <CardTitle className="truncate text-base font-semibold">
                      {row.product.name}
                    </CardTitle>
                  </div>
                  <StatusBadge status={row.status} />
                </CardHeader>
                <CardContent className="flex flex-col gap-2">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-sm text-muted-foreground">
                      {t().stock.variantsSummary.replace(
                        "{n}",
                        String(row.variantCount),
                      )}
                    </span>
                    <VariantChips chips={row.sizeChips} />
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-muted-foreground">
                      {t().stock.availableStock}
                    </span>
                    <span className="flex items-center gap-1 font-mono tabular-nums">
                      {row.totalQty}
                      <HugeiconsIcon
                        icon={ChevronRightIcon}
                        strokeWidth={2}
                        className="size-4 text-muted-foreground"
                      />
                    </span>
                  </div>
                </CardContent>
              </Card>
            </Link>
          )}
        />
      </div>
    </div>
  );
}
