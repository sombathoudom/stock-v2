"use client";

import { Contact01Icon, Search01Icon } from "@hugeicons/core-free-icons";
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
import { useCurrentUser } from "@/hooks/use-current-user";
import { usePersistentState } from "@/hooks/use-persistent-state";
import { useShop } from "@/hooks/use-shop";
import { formatDateTime, formatMoney, getLang, t } from "@/lib/utils";

type Aging = {
  days0To7: number;
  days8To30: number;
  days31To60: number;
  over60Days: number;
};

type CustomerDebtRow = {
  customerId: Id<"customers">;
  customerName: string;
  customerPhone: string;
  totalOwed: number;
  unpaidOrderCount: number;
  aging: Aging;
  oldestOrderId: Id<"sales">;
  oldestOrderCode: string;
  oldestOrderAt: number;
  oldestAgeDays: number;
};

export function CustomerDebtReport() {
  const user = useCurrentUser();
  const shop = useShop();
  const [search, setSearch] = usePersistentState("reports:customerDebtSearch", "");
  const deferredSearch = useDeferredValue(search);
  const [pageSize, setPageSize] = usePersistentState(
    "reports:customerDebtPageSize",
    20
  );
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
    api.reports.getCustomerDebtReport,
    user == null
      ? "skip"
      : {
          search: deferredSearch.trim() || undefined,
          paginationOpts: {
            numItems: pageSize,
            cursor: pageIndex === 0 ? null : (cursors[pageIndex - 1] ?? null),
          },
        }
  );

  const columns = useMemo<DataTableColumn<CustomerDebtRow>[]>(
    () => [
      {
        accessorKey: "customerName",
        header: t().sales.customer,
        enableSorting: false,
        cell: ({ row }) => (
          <Link
            href={`/customers/${row.original.customerId}`}
            className="font-medium hover:underline"
          >
            {row.original.customerName}
          </Link>
        ),
      },
      {
        accessorKey: "customerPhone",
        header: t().common.phone,
        enableSorting: false,
      },
      {
        accessorKey: "unpaidOrderCount",
        header: t().reports.unpaidOrders,
        enableSorting: false,
      },
      {
        accessorKey: "totalOwed",
        header: t().reports.totalOwed,
        enableSorting: false,
        cell: ({ row }) => (
          <span className="font-medium tabular-nums">
            {formatMoney(row.original.totalOwed, currency, lang)}
          </span>
        ),
      },
      ...agingColumns(currency, lang),
      {
        accessorKey: "oldestOrderAt",
        header: t().reports.oldestOrder,
        enableSorting: false,
        cell: ({ row }) => (
          <div className="flex flex-col">
            <Link
              href={`/sales/${row.original.oldestOrderId}`}
              className="font-medium hover:underline"
            >
              {row.original.oldestOrderCode}
            </Link>
            <span className="text-xs text-muted-foreground">
              {formatDateTime(row.original.oldestOrderAt, timezone, lang)}
            </span>
          </div>
        ),
      },
    ],
    [currency, lang, timezone]
  );

  const summaries = report
    ? [
        { label: t().reports.totalOwed, value: report.totalOwed },
        { label: t().reports.days0To7, value: report.aging.days0To7 },
        { label: t().reports.days8To30, value: report.aging.days8To30 },
        { label: t().reports.days31To60, value: report.aging.days31To60 },
        { label: t().reports.over60Days, value: report.aging.over60Days },
      ]
    : [];

  return (
    <div className="flex w-full flex-col">
      <PageToolbar icon={Contact01Icon} title={t().reports.reportCustomerDebt}>
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
            placeholder={t().reports.searchCustomerDebt}
            aria-label={t().reports.searchCustomerDebt}
          />
        </InputGroup>
      </PageToolbar>

      <div className="grid gap-3 p-4 sm:grid-cols-2 xl:grid-cols-5">
        {summaries.map((summary) => (
          <Card key={summary.label}>
            <CardHeader className="pb-1">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                {summary.label}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="font-heading text-2xl font-semibold tabular-nums">
                {formatMoney(summary.value, currency, lang)}
              </p>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="px-4 pb-4">
        <p className="mb-2 text-sm text-muted-foreground">
          {report
            ? t()
                .reports.customerDebtAsOf.replace("{day}", report.asOfDay)
                .replace("{count}", String(report.customerCount))
            : t().common.loading}
        </p>
        <DataTable
          columns={columns}
          data={(report?.page ?? []) as CustomerDebtRow[]}
          persistKey="reports-customer-debt"
          loading={report === undefined}
          totalCount={report?.total}
          pageIndex={pageIndex}
          pageSize={pageSize}
          onPageSizeChange={(size) => {
            setPageSize(size);
            resetPages();
          }}
          onPageChange={(direction) => {
            if (direction === "prev") {
              setPageIndex((index) => Math.max(0, index - 1));
            } else if (report?.continueCursor) {
              setCursors((current) =>
                current[pageIndex] === undefined
                  ? [...current, report.continueCursor]
                  : current
              );
              setPageIndex((index) => index + 1);
            }
          }}
          cardRender={(row) => (
            <CustomerDebtCard row={row} currency={currency} timezone={timezone} lang={lang} />
          )}
        />
      </div>
    </div>
  );
}

function agingColumns(currency: string, lang: ReturnType<typeof getLang>) {
  const columns: { key: keyof Aging; label: string }[] = [
    { key: "days0To7", label: t().reports.days0To7 },
    { key: "days8To30", label: t().reports.days8To30 },
    { key: "days31To60", label: t().reports.days31To60 },
    { key: "over60Days", label: t().reports.over60Days },
  ];
  return columns.map<DataTableColumn<CustomerDebtRow>>(({ key, label }) => ({
    id: key,
    header: label,
    enableSorting: false,
    cell: ({ row }) => (
      <span className="tabular-nums">
        {formatMoney(row.original.aging[key], currency, lang)}
      </span>
    ),
  }));
}

function CustomerDebtCard({
  row,
  currency,
  timezone,
  lang,
}: {
  row: CustomerDebtRow;
  currency: string;
  timezone: string;
  lang: ReturnType<typeof getLang>;
}) {
  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-2">
        <div className="min-w-0">
          <CardTitle>
            <Link href={`/customers/${row.customerId}`} className="hover:underline">
              {row.customerName}
            </Link>
          </CardTitle>
          <p className="text-sm text-muted-foreground">{row.customerPhone || "—"}</p>
        </div>
        <span className="shrink-0 font-heading text-lg font-semibold tabular-nums">
          {formatMoney(row.totalOwed, currency, lang)}
        </span>
      </CardHeader>
      <CardContent className="grid gap-3">
        <div className="grid grid-cols-2 gap-2 text-sm">
          <DebtAmount label={t().reports.days0To7} amount={row.aging.days0To7} currency={currency} lang={lang} />
          <DebtAmount label={t().reports.days8To30} amount={row.aging.days8To30} currency={currency} lang={lang} />
          <DebtAmount label={t().reports.days31To60} amount={row.aging.days31To60} currency={currency} lang={lang} />
          <DebtAmount label={t().reports.over60Days} amount={row.aging.over60Days} currency={currency} lang={lang} />
        </div>
        <div className="flex items-center justify-between gap-2 border-t pt-3 text-sm">
          <span className="text-muted-foreground">
            {t().reports.unpaidOrders}: {row.unpaidOrderCount}
          </span>
          <Link href={`/sales/${row.oldestOrderId}`} className="font-medium hover:underline">
            {row.oldestOrderCode} · {formatDateTime(row.oldestOrderAt, timezone, lang)}
          </Link>
        </div>
      </CardContent>
    </Card>
  );
}

function DebtAmount({
  label,
  amount,
  currency,
  lang,
}: {
  label: string;
  amount: number;
  currency: string;
  lang: ReturnType<typeof getLang>;
}) {
  return (
    <div className="rounded-md border p-2">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="font-medium tabular-nums">{formatMoney(amount, currency, lang)}</p>
    </div>
  );
}
