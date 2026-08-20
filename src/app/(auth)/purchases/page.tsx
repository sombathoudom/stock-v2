"use client";

import { BoxIcon, PencilEdit01Icon, PlusSignIcon, Search01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useQuery } from "convex/react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import { api } from "@convex/_generated/api";
import {
  DataTable,
  type DataTableColumn,
} from "@/components/features/data-table/data-table";
import { PageToolbar } from "@/components/features/shell/page-toolbar";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useCurrentUser } from "@/hooks/use-current-user";
import { usePersistentState } from "@/hooks/use-persistent-state";
import { formatDateTime, formatMoney, getLang, t } from "@/lib/utils";

// T5 — Purchases list (AGENTS.md). Status filter + code search in the
// header; the shared DataTable shows supplier, totals and status.

type PurchaseRow = {
  purchase: {
    _id: string;
    code: string;
    status: "draft" | "received";
    createdAt: number;
    purchasedAt: number;
  };
  supplierName: string;
  itemCount: number;
  totalCost: number;
};

export default function PurchasesPage() {
  const user = useCurrentUser();
  const shop = useQuery(api.shop.get, user == null ? "skip" : {});
  const currency = shop?.currency ?? "USD";
  const timezone = shop?.timezone ?? "Asia/Phnom_Penh";

  // Search box value + debounced copy that actually drives the query.
  const [search, setSearch] = usePersistentState("purchases:search", "");
  const [debouncedSearch, setDebouncedSearch] = useState(search);
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const [statusFilter, setStatusFilter] = usePersistentState(
    "purchases:status",
    "all"
  );
  const [pageSize, setPageSize] = usePersistentState("purchases:pageSize", 20);
  const [pageIndex, setPageIndex] = useState(0);
  const [cursors, setCursors] = useState<string[]>([]);

  const list = useQuery(
    api.purchases.list,
    user == null
      ? "skip"
      : {
          paginationOpts: {
            numItems: pageSize,
            cursor: pageIndex === 0 ? null : (cursors[pageIndex - 1] ?? null),
          },
          status:
            statusFilter === "all" ? undefined : (statusFilter as "draft" | "received"),
          search: debouncedSearch.trim() || undefined,
        }
  );

  // Changing the search, status or the page size restarts from page 1.
  function resetPages() {
    setPageIndex(0);
    setCursors([]);
  }

  const rows: PurchaseRow[] = useMemo(
    () =>
      (list?.page ?? []).map((row) => ({
        purchase: {
          _id: row.purchase._id,
          code: row.purchase.code,
          status: row.purchase.status,
          createdAt: row.purchase.createdAt,
          purchasedAt: row.purchase.purchasedAt,
        },
        supplierName: row.supplierName,
        itemCount: row.itemCount,
        totalCost: row.totalCost,
      })),
    [list]
  );

  const columns = useMemo<DataTableColumn<PurchaseRow>[]>(
    () => [
      {
        accessorKey: "code",
        header: t().purchases.code,
        enableSorting: false,
        cell: ({ row }) => (
          <span className="font-mono text-sm">{row.original.purchase.code}</span>
        ),
      },
      {
        accessorKey: "supplierName",
        header: t().purchases.supplier,
        enableSorting: false,
        cell: ({ row }) => row.original.supplierName,
      },
      {
        accessorKey: "itemCount",
        header: t().purchases.items,
        enableSorting: false,
        cell: ({ row }) => row.original.itemCount,
      },
      {
        accessorKey: "totalCost",
        header: t().purchases.totalCost,
        enableSorting: false,
        cell: ({ row }) => formatMoney(row.original.totalCost, currency),
      },
      {
        accessorKey: "status",
        header: t().common.filter,
        enableSorting: false,
        cell: ({ row }) => (
          <Badge
            variant={row.original.purchase.status === "received" ? "default" : "secondary"}
          >
            {t().status[row.original.purchase.status]}
          </Badge>
        ),
      },
      {
        accessorKey: "createdAt",
        header: t().purchases.createdLabel,
        enableSorting: false,
        // The BUSINESS (purchase) date — not the row's creation timestamp.
        cell: ({ row }) =>
          formatDateTime(
            row.original.purchase.purchasedAt ?? row.original.purchase.createdAt,
            timezone,
            getLang()
          ),
      },
      {
        id: "actions",
        header: t().common.actions,
        enableSorting: false,
        cell: ({ row }) => (
          // Base UI Button render= needs a native <button> — links use the
          // button variant classes directly on an <a> instead.
          <Link
            href={`/purchases/${row.original.purchase._id}`}
            className={buttonVariants({ variant: "outline", size: "sm" })}
          >
            <HugeiconsIcon icon={PencilEdit01Icon} strokeWidth={2} className="size-4" />
            {t().common.edit}
          </Link>
        ),
      },
    ],
    [currency, timezone]
  );

  return (
    <div className="flex w-full flex-col">
      <PageToolbar icon={BoxIcon} title={t().nav.purchases}>
        <InputGroup className="w-full sm:w-56">
          <InputGroupAddon>
            <HugeiconsIcon icon={Search01Icon} strokeWidth={2} className="size-4" />
          </InputGroupAddon>
          <InputGroupInput
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              resetPages();
            }}
            placeholder={t().purchases.searchPlaceholder}
            aria-label={t().purchases.searchPlaceholder}
          />
        </InputGroup>
        <Select
          value={statusFilter}
          // Base UI shows the RAW value in the trigger without this map.
          items={{
            all: t().purchases.allStatuses,
            draft: t().status.draft,
            received: t().status.received,
          }}
          onValueChange={(value) => {
            setStatusFilter(value ?? "all");
            resetPages();
          }}
        >
          <SelectTrigger className="w-40" aria-label={t().common.filter}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t().purchases.allStatuses}</SelectItem>
            <SelectItem value="draft">{t().status.draft}</SelectItem>
            <SelectItem value="received">{t().status.received}</SelectItem>
          </SelectContent>
        </Select>
        <Link href="/purchases/new" className={buttonVariants()}>
          <HugeiconsIcon icon={PlusSignIcon} strokeWidth={2} className="size-4" />
          {t().purchases.addPurchase}
        </Link>
      </PageToolbar>

      <div className="p-4">
        <DataTable
          columns={columns}
          data={rows}
          persistKey="purchases"
          loading={list === undefined}
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
                c[pageIndex] === undefined ? [...c, list.continueCursor] : c
              );
              setPageIndex((i) => i + 1);
            }
          }}
          cardRender={(row) => (
            <Card>
              <CardHeader>
                <CardTitle className="font-mono text-sm">
                  {row.purchase.code}
                </CardTitle>
                <p className="text-sm text-muted-foreground">{row.supplierName}</p>
              </CardHeader>
              <CardContent className="flex-row items-center justify-between">
                <div className="text-sm">
                  <p>
                    {row.itemCount} {t().purchases.items}
                  </p>
                  <p className="font-medium">
                    {formatMoney(row.totalCost, currency)}
                  </p>
                </div>
                <div className="flex flex-col items-end gap-2">
                  <Badge
                    variant={
                      row.purchase.status === "received" ? "default" : "secondary"
                    }
                  >
                    {t().status[row.purchase.status]}
                  </Badge>
                  <Link
                    href={`/purchases/${row.purchase._id}`}
                    className={buttonVariants({ variant: "outline", size: "sm" })}
                  >
                    <HugeiconsIcon icon={PencilEdit01Icon} strokeWidth={2} className="size-4" />
                    {t().common.edit}
                  </Link>
                </div>
              </CardContent>
            </Card>
          )}
        />
      </div>
    </div>
  );
}
