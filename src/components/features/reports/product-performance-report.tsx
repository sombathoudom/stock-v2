"use client";

import { Search01Icon, Shirt01Icon } from "@hugeicons/core-free-icons";
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
import { Input } from "@/components/ui/input";
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
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useCurrentUser } from "@/hooks/use-current-user";
import { usePersistentState } from "@/hooks/use-persistent-state";
import { useShop } from "@/hooks/use-shop";
import { formatMoney, getLang, t } from "@/lib/utils";

type PeriodType = "day" | "month" | "year";
type ProductPerformanceRow = {
  productId: Id<"products">;
  variantId: Id<"productVariants">;
  productName: string;
  productCode?: string;
  size: string;
  color?: string;
  sku?: string;
  unitsSold: number;
  returnedUnits: number;
  exchangedUnits: number;
  revenue: number;
  landedCost: number;
  profit: number;
};

function localDefaults() {
  const date = new Date();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return {
    day: `${date.getFullYear()}-${month}-${day}`,
    month: `${date.getFullYear()}-${month}`,
    year: String(date.getFullYear()),
  };
}

export function ProductPerformanceReport() {
  const user = useCurrentUser();
  const shop = useShop();
  const defaults = useMemo(() => localDefaults(), []);
  const [periodType, setPeriodType] = usePersistentState<PeriodType>(
    "reports:productPerformance:periodType",
    "month"
  );
  const [dayValue, setDayValue] = usePersistentState(
    "reports:productPerformance:day",
    defaults.day
  );
  const [monthValue, setMonthValue] = usePersistentState(
    "reports:productPerformance:month",
    defaults.month
  );
  const [yearValue, setYearValue] = usePersistentState(
    "reports:productPerformance:year",
    defaults.year
  );
  const [search, setSearch] = usePersistentState(
    "reports:productPerformance:search",
    ""
  );
  const deferredSearch = useDeferredValue(search);
  const [pageSize, setPageSize] = usePersistentState(
    "reports:productPerformance:pageSize",
    20
  );
  const [pageIndex, setPageIndex] = useState(0);
  const [cursors, setCursors] = useState<string[]>([]);
  const currency = shop?.currency ?? "USD";
  const lang = getLang();
  const periodValue =
    periodType === "day" ? dayValue : periodType === "month" ? monthValue : yearValue;
  const years = useMemo(() => {
    const current = new Date().getFullYear();
    return Array.from({ length: 11 }, (_, index) => current - 5 + index);
  }, []);

  function resetPages() {
    setPageIndex(0);
    setCursors([]);
  }

  const report = useQuery(
    api.reports.getProductPerformanceReport,
    user == null
      ? "skip"
      : {
          period: { type: periodType, value: periodValue },
          search: deferredSearch.trim() || undefined,
          paginationOpts: {
            numItems: pageSize,
            cursor: pageIndex === 0 ? null : (cursors[pageIndex - 1] ?? null),
          },
        }
  );

  const columns = useMemo<DataTableColumn<ProductPerformanceRow>[]>(
    () => [
      {
        accessorKey: "productName",
        header: t().purchases.product,
        enableSorting: false,
        cell: ({ row }) => (
          <Link href={`/products/${row.original.productId}`} className="font-medium hover:underline">
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
      metricColumn("unitsSold", t().reports.unitsSold),
      metricColumn("returnedUnits", t().reports.returnedUnits),
      metricColumn("exchangedUnits", t().reports.exchangedUnits),
      moneyColumn("revenue", t().reports.revenueCol, currency, lang),
      moneyColumn("landedCost", t().reports.landedCost, currency, lang),
      moneyColumn("profit", t().reports.profitCol, currency, lang, true),
    ],
    [currency, lang]
  );

  const summaries = report
    ? [
        { label: t().reports.unitsSold, value: String(report.totals.unitsSold) },
        { label: t().reports.returnedUnits, value: String(report.totals.returnedUnits) },
        { label: t().reports.exchangedUnits, value: String(report.totals.exchangedUnits) },
        { label: t().reports.revenueCol, value: formatMoney(report.totals.revenue, currency, lang) },
        { label: t().reports.landedCost, value: formatMoney(report.totals.landedCost, currency, lang) },
        { label: t().reports.profitCol, value: formatMoney(report.totals.profit, currency, lang), negative: report.totals.profit < 0 },
      ]
    : [];

  return (
    <div className="flex w-full flex-col">
      <PageToolbar icon={Shirt01Icon} title={t().reports.reportProductPerformance}>
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
            placeholder={t().reports.searchProducts}
            aria-label={t().reports.searchProducts}
          />
        </InputGroup>
      </PageToolbar>

      <div className="flex flex-col gap-4 p-4">
        <Card>
          <CardContent className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
            <Tabs
              value={periodType}
              onValueChange={(value) => {
                setPeriodType(value as PeriodType);
                resetPages();
              }}
            >
              <TabsList>
                <TabsTrigger value="day">{t().reports.periodDaily}</TabsTrigger>
                <TabsTrigger value="month">{t().reports.periodMonthly}</TabsTrigger>
                <TabsTrigger value="year">{t().reports.periodYearly}</TabsTrigger>
              </TabsList>
            </Tabs>
            <PeriodInput
              type={periodType}
              day={dayValue}
              month={monthValue}
              year={yearValue}
              years={years}
              onDay={(value) => {
                setDayValue(value);
                resetPages();
              }}
              onMonth={(value) => {
                setMonthValue(value);
                resetPages();
              }}
              onYear={(value) => {
                setYearValue(value);
                resetPages();
              }}
            />
          </CardContent>
        </Card>

        <p className="text-sm text-muted-foreground">
          {t().reports.productPerformanceTiming}
        </p>

        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-6">
          {summaries.map((summary) => (
            <Card key={summary.label}>
              <CardHeader className="pb-1">
                <CardTitle className="text-sm font-medium text-muted-foreground">
                  {summary.label}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className={summary.negative ? "font-heading text-2xl font-semibold text-destructive" : "font-heading text-2xl font-semibold"}>
                  {summary.value}
                </p>
              </CardContent>
            </Card>
          ))}
        </div>

        <DataTable
          columns={columns}
          data={(report?.page ?? []) as ProductPerformanceRow[]}
          persistKey="reports-product-performance"
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
          cardRender={(row) => <ProductPerformanceCard row={row} currency={currency} lang={lang} />}
        />
      </div>
    </div>
  );
}

function PeriodInput({
  type,
  day,
  month,
  year,
  years,
  onDay,
  onMonth,
  onYear,
}: {
  type: PeriodType;
  day: string;
  month: string;
  year: string;
  years: number[];
  onDay: (value: string) => void;
  onMonth: (value: string) => void;
  onYear: (value: string) => void;
}) {
  if (type === "day") {
    return <Input type="date" value={day} onChange={(event) => event.target.value && onDay(event.target.value)} className="w-full sm:w-44" />;
  }
  if (type === "month") {
    return <Input type="month" value={month} onChange={(event) => event.target.value && onMonth(event.target.value)} className="w-full sm:w-44" />;
  }
  return (
    <Select value={year} items={Object.fromEntries(years.map((item) => [String(item), String(item)]))} onValueChange={(value) => value && onYear(value)}>
      <SelectTrigger className="w-full sm:w-44"><SelectValue /></SelectTrigger>
      <SelectContent>
        {years.map((item) => <SelectItem key={item} value={String(item)}>{item}</SelectItem>)}
      </SelectContent>
    </Select>
  );
}

function metricColumn(key: "unitsSold" | "returnedUnits" | "exchangedUnits", label: string): DataTableColumn<ProductPerformanceRow> {
  return {
    accessorKey: key,
    header: label,
    enableSorting: false,
    cell: ({ row }) => (
      <span className={row.original[key] < 0 ? "tabular-nums text-destructive" : "tabular-nums"}>
        {row.original[key]}
      </span>
    ),
  };
}

function moneyColumn(
  key: "revenue" | "landedCost" | "profit",
  label: string,
  currency: string,
  lang: ReturnType<typeof getLang>,
  highlightNegative = false
): DataTableColumn<ProductPerformanceRow> {
  return {
    accessorKey: key,
    header: label,
    enableSorting: false,
    cell: ({ row }) => (
      <span className={highlightNegative && row.original[key] < 0 ? "tabular-nums text-destructive" : "tabular-nums"}>
        {formatMoney(row.original[key], currency, lang)}
      </span>
    ),
  };
}

function ProductPerformanceCard({ row, currency, lang }: { row: ProductPerformanceRow; currency: string; lang: ReturnType<typeof getLang> }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle><Link href={`/products/${row.productId}`} className="hover:underline">{row.productName}</Link></CardTitle>
        <p className="text-sm text-muted-foreground">{[row.size, row.color, row.sku].filter(Boolean).join(" · ")}</p>
      </CardHeader>
      <CardContent className="grid gap-3">
        <div className="grid grid-cols-3 gap-2 text-center text-sm">
          <Metric label={t().reports.unitsSold} value={row.unitsSold} />
          <Metric label={t().reports.returnedUnits} value={row.returnedUnits} />
          <Metric label={t().reports.exchangedUnits} value={row.exchangedUnits} />
        </div>
        <div className="grid gap-1 border-t pt-3 text-sm">
          <MoneyLine label={t().reports.revenueCol} value={row.revenue} currency={currency} lang={lang} />
          <MoneyLine label={t().reports.landedCost} value={row.landedCost} currency={currency} lang={lang} />
          <MoneyLine label={t().reports.profitCol} value={row.profit} currency={currency} lang={lang} strong />
        </div>
      </CardContent>
    </Card>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return <div className="rounded-md border p-2"><p className="text-xs text-muted-foreground">{label}</p><p className="font-medium tabular-nums">{value}</p></div>;
}

function MoneyLine({ label, value, currency, lang, strong = false }: { label: string; value: number; currency: string; lang: ReturnType<typeof getLang>; strong?: boolean }) {
  return <div className={strong ? "flex justify-between font-medium" : "flex justify-between"}><span className="text-muted-foreground">{label}</span><span className={value < 0 ? "tabular-nums text-destructive" : "tabular-nums"}>{formatMoney(value, currency, lang)}</span></div>;
}
