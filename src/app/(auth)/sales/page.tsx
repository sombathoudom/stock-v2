"use client";

import {
  PlusSignIcon,
  ShoppingBag01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useQuery } from "convex/react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import {
  DataTable,
  type DataTableColumn,
} from "@/components/features/data-table/data-table";
import { PaymentStatusBadge } from "@/components/features/sales/payment-status-badge";
import {
  SaleRowActions,
  type SaleListRow,
} from "@/components/features/sales/sale-row-actions";
import { SaleStatusBadge } from "@/components/features/sales/sale-status-badge";
import {
  SalesFilterPanel,
  type SalesPaymentFilter,
  type SalesStatusFilter,
} from "@/components/features/sales/sales-filter-panel";
import {
  SalesSummaryCards,
  type SalesFilters,
} from "@/components/features/sales/sales-summary-cards";
import { PageToolbar } from "@/components/features/shell/page-toolbar";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useCurrentUser } from "@/hooks/use-current-user";
import { usePersistentState } from "@/hooks/use-persistent-state";
import { formatDateTime, formatMoney, getLang, t } from "@/lib/utils";

// T12 — Sales list (AGENTS.md). Filters: search by order code, status (with
// "Today" and "Still owed" shortcuts), the sales page the order came from,
// a From/To date range, customer, and payment status — index-driven
// server-side where possible; the payment-state filters scan a bounded
// window (see convex/sales.ts filteredRows). Summary cards above the
// filters take the SAME args, so card numbers always match the rows.
// Every row shows its computed total / paid / remaining; tapping opens the
// order detail (UUID route).

/** Today's YYYY-MM-DD in the shop timezone (en-CA formats as ISO date). */
function todayInTimezone(timezone: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
  } catch {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }
}

export default function SalesPage() {
  const user = useCurrentUser();
  const shop = useQuery(api.shop.get, user == null ? "skip" : {});

  const [search, setSearch] = usePersistentState("sales:search", "");
  const [debouncedSearch, setDebouncedSearch] = useState(search);
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const [filter, setFilter] = usePersistentState<SalesStatusFilter>("sales:filter", "all");
  const [channelId, setChannelId] = usePersistentState("sales:channel", "all");
  const [fromDay, setFromDay] = usePersistentState("sales:fromDay", "");
  const [toDay, setToDay] = usePersistentState("sales:toDay", "");
  const [customerFilter, setCustomerFilter] = usePersistentState<
    Id<"customers"> | "all"
  >("sales:customer", "all");
  const [paymentFilter, setPaymentFilter] =
    usePersistentState<SalesPaymentFilter>("sales:paymentStatus", "all");

  // Deep links like /sales?filter=unpaid (dashboard "View all") preselect the
  // filter once on mount; afterwards the persisted preference wins.
  useEffect(() => {
    const param = new URLSearchParams(window.location.search).get("filter");
    if (param === "all" || param === "today" || param === "unpaid") {
      setFilter(param);
      // "unpaid" is a payment-state shortcut — don't fight an explicit
      // payment-status selection over it.
      if (param === "unpaid") setPaymentFilter("all");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [pageSize, setPageSize] = usePersistentState("sales:pageSize", 20);
  const [pageIndex, setPageIndex] = useState(0);
  const [cursors, setCursors] = useState<string[]>([]);

  function resetPages() {
    setPageIndex(0);
    setCursors([]);
  }

  function clearFilters() {
    setSearch("");
    setFilter("all");
    setChannelId("all");
    setFromDay("");
    setToDay("");
    setCustomerFilter("all");
    setPaymentFilter("all");
    resetPages();
  }

  const channels =
    useQuery(api.channels.listActive, user == null ? "skip" : {}) ?? [];

  const paginationOpts = {
    numItems: pageSize,
    cursor: pageIndex === 0 ? null : (cursors[pageIndex - 1] ?? null),
  };

  const day =
    filter === "today" && shop != null
      ? todayInTimezone(shop.timezone)
      : undefined;
  const statusFilter =
    filter === "all" || filter === "today" || filter === "unpaid"
      ? undefined
      : filter;

  // One shared filters object for the list AND the summary cards, so the
  // card numbers always match the rows below. The "unpaid" status shortcut
  // maps to paymentStatus so everything goes through one query.
  const filters: SalesFilters = {
    search: debouncedSearch.trim() || undefined,
    status: statusFilter,
    channelId:
      channelId === "all" ? undefined : (channelId as Id<"salesChannels">),
    day,
    customerId: customerFilter === "all" ? undefined : customerFilter,
    fromDay: fromDay || undefined,
    toDay: toDay || undefined,
    paymentStatus:
      paymentFilter !== "all"
        ? paymentFilter
        : filter === "unpaid"
          ? "unpaid"
          : undefined,
  };

  const list = useQuery(
    api.sales.list,
    user == null ? "skip" : { paginationOpts, ...filters }
  );

  const columns = useMemo<DataTableColumn<SaleListRow>[]>(
    () => [
      {
        accessorKey: "code",
        header: t().sales.order,
        enableSorting: false,
        cell: ({ row }) => (
          <Link
            href={`/sales/${row.original.sale._id}`}
            className="font-medium hover:underline"
          >
            {row.original.sale.code}
          </Link>
        ),
      },
      {
        accessorKey: "createdAt",
        header: t().sales.date,
        enableSorting: false,
        cell: ({ row }) => (
          <span className="text-muted-foreground">
            {formatDateTime(row.original.sale.createdAt, shop?.timezone ?? "Asia/Phnom_Penh", getLang())}
          </span>
        ),
      },
      {
        accessorKey: "customerName",
        header: t().sales.customer,
        enableSorting: false,
        cell: ({ row }) => (
          <span>
            {row.original.customerName}
            {row.original.customerPhone ? (
              <span className="text-xs text-muted-foreground">
                {" "}
                · {row.original.customerPhone}
              </span>
            ) : null}
          </span>
        ),
      },
      {
        accessorKey: "channelName",
        header: t().sales.channel,
        enableSorting: false,
        cell: ({ row }) => (
          <span className="text-muted-foreground">{row.original.channelName}</span>
        ),
      },
      {
        accessorKey: "status",
        header: t().sales.status,
        enableSorting: false,
        cell: ({ row }) => <SaleStatusBadge status={row.original.sale.status} />,
      },
      {
        accessorKey: "paymentStatus",
        header: t().sales.paymentStatus,
        enableSorting: false,
        cell: ({ row }) => (
          <PaymentStatusBadge
            status={row.original.sale.status}
            paid={row.original.paid}
            remaining={row.original.remaining}
          />
        ),
      },
      {
        accessorKey: "total",
        header: t().sales.total,
        enableSorting: false,
        cell: ({ row }) => (
          <span className="tabular-nums">
            {formatMoney(row.original.total, shop?.currency ?? "USD", getLang())}
          </span>
        ),
      },
      {
        accessorKey: "paid",
        header: t().sales.paid,
        enableSorting: false,
        cell: ({ row }) => (
          <span className="tabular-nums">
            {formatMoney(row.original.paid, shop?.currency ?? "USD", getLang())}
          </span>
        ),
      },
      {
        accessorKey: "remaining",
        header: t().sales.remaining,
        enableSorting: false,
        cell: ({ row }) =>
          row.original.remaining > 0 ? (
            <span className="font-medium tabular-nums">
              {formatMoney(row.original.remaining, shop?.currency ?? "USD", getLang())}
            </span>
          ) : (
            <span className="text-muted-foreground">—</span>
          ),
      },
      {
        id: "actions",
        header: t().common.actions,
        enableSorting: false,
        cell: ({ row }) => <SaleRowActions row={row.original} />,
      },
    ],
    [shop?.timezone, shop?.currency]
  );

  return (
    <div className="flex w-full flex-col">
      <PageToolbar icon={ShoppingBag01Icon} title={t().nav.sales}>
        <Link href="/sales/new" className={buttonVariants()}>
          <HugeiconsIcon icon={PlusSignIcon} strokeWidth={2} className="size-4" />
          {t().sales.newSale}
        </Link>
      </PageToolbar>

      {/* Summary cards — same filters as the list below, so the numbers
          always match the rows. */}
      <SalesSummaryCards filters={filters} />

      <SalesFilterPanel
        search={search}
        onSearchChange={(value) => {
          setSearch(value);
          resetPages();
        }}
        status={filter}
        onStatusChange={(value) => {
          setFilter(value);
          if (value === "unpaid") setPaymentFilter("all");
          resetPages();
        }}
        channelId={channelId}
        channels={channels}
        onChannelChange={(value) => {
          setChannelId(value);
          resetPages();
        }}
        fromDay={fromDay}
        onFromDayChange={(value) => {
          setFromDay(value);
          resetPages();
        }}
        toDay={toDay}
        onToDayChange={(value) => {
          setToDay(value);
          resetPages();
        }}
        customerId={customerFilter}
        onCustomerChange={(value) => {
          setCustomerFilter(value);
          resetPages();
        }}
        paymentStatus={paymentFilter}
        onPaymentStatusChange={(value) => {
          setPaymentFilter(value);
          if (value !== "all") setFilter("all");
          resetPages();
        }}
        onClear={clearFilters}
      />

      <div className="p-4">
        <DataTable
          columns={columns}
          data={list?.page ?? []}
          persistKey="sales"
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
                <div className="flex items-center justify-between gap-2">
                  <CardTitle>{row.sale.code}</CardTitle>
                  <div className="flex items-center gap-2">
                    <PaymentStatusBadge
                      status={row.sale.status}
                      paid={row.paid}
                      remaining={row.remaining}
                    />
                    <SaleStatusBadge status={row.sale.status} />
                  </div>
                </div>
                <p className="text-sm text-muted-foreground">
                  {row.customerName}
                  {row.customerPhone ? ` · ${row.customerPhone}` : ""}
                </p>
                <p className="text-sm text-muted-foreground">
                  {formatDateTime(row.sale.createdAt, shop?.timezone ?? "Asia/Phnom_Penh", getLang())}
                  {" · "}
                  {row.channelName}
                </p>
              </CardHeader>
              <CardContent className="flex-row items-center justify-between">
                <div className="flex flex-col gap-0.5 text-sm">
                  <span>
                    {t().sales.total}:{" "}
                    <span className="tabular-nums">
                      {formatMoney(row.total, shop?.currency ?? "USD", getLang())}
                    </span>
                  </span>
                  {row.remaining > 0 ? (
                    <Badge variant="secondary" className="w-fit tabular-nums">
                      {t().sales.remaining}:{" "}
                      {formatMoney(row.remaining, shop?.currency ?? "USD", getLang())}
                    </Badge>
                  ) : null}
                </div>
                <SaleRowActions row={row} />
              </CardContent>
            </Card>
          )}
        />
      </div>
    </div>
  );
}
