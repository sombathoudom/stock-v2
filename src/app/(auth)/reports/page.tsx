"use client";

import { Analytics01Icon, Download01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useConvex, useQuery } from "convex/react";
import { useMemo, useState } from "react";
import { toast } from "sonner";

import { api } from "@convex/_generated/api";
import {
  DataTable,
  type DataTableColumn,
} from "@/components/features/data-table/data-table";
import { PageToolbar } from "@/components/features/shell/page-toolbar";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useCurrentUser } from "@/hooks/use-current-user";
import { usePersistentState } from "@/hooks/use-persistent-state";
import { useShop } from "@/hooks/use-shop";
import {
  centsToDecimal,
  downloadCsv,
  formatDateTime,
  formatMoney,
  getLang,
  t,
  toastError,
} from "@/lib/utils";

// T19 + T21 — Reports. Cash-basis P/L (money counts on the day it is
// RECEIVED — AGENTS.md rule #2), sales by channel, and the stock movement
// report. Monthly / yearly are the same daily rows aggregated over the whole
// range — nothing is ever stored or cached.

type ReportType = "pl" | "channels" | "stock";
type PeriodType = "day" | "month" | "year";

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

type StockReason = (typeof REASON_OPTIONS)[number];

function localDefaults() {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return {
    day: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    month: `${d.getFullYear()}-${pad(d.getMonth() + 1)}`,
    year: String(d.getFullYear()),
    monthStart: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-01`,
  };
}

export default function ReportsPage() {
  const user = useCurrentUser();
  const convex = useConvex();
  const [exporting, setExporting] = useState(false);
  const shop = useShop();
  const lang = getLang();
  const defaults = useMemo(() => localDefaults(), []);

  const [reportType, setReportType] = usePersistentState<ReportType>("reports:type", "pl");
  const [periodType, setPeriodType] = usePersistentState<PeriodType>("reports:periodType", "day");
  const [dayValue, setDayValue] = usePersistentState("reports:value:day", defaults.day);
  const [monthValue, setMonthValue] = usePersistentState("reports:value:month", defaults.month);
  const [yearValue, setYearValue] = usePersistentState("reports:value:year", defaults.year);

  const [stockFrom, setStockFrom] = usePersistentState("reports:stockFrom", defaults.monthStart);
  const [stockTo, setStockTo] = usePersistentState("reports:stockTo", defaults.day);
  const [stockReason, setStockReason] = usePersistentState<StockReason | "all">(
    "reports:stockReason",
    "all",
  );
  const [pageSize, setPageSize] = usePersistentState("reports:stockPageSize", 20);
  const [pageIndex, setPageIndex] = useState(0);
  const [cursors, setCursors] = useState<string[]>([]);

  function resetPages() {
    setPageIndex(0);
    setCursors([]);
  }

  const periodValue =
    periodType === "day" ? dayValue : periodType === "month" ? monthValue : yearValue;

  const report = useQuery(
    api.reports.getPlReport,
    user == null || reportType !== "pl"
      ? "skip"
      : { period: { type: periodType, value: periodValue } },
  );
  const channelReport = useQuery(
    api.reports.getChannelReport,
    user == null || reportType !== "channels"
      ? "skip"
      : { period: { type: periodType, value: periodValue } },
  );
  const movements = useQuery(
    api.reports.getStockMovements,
    user == null || reportType !== "stock"
      ? "skip"
      : {
          fromDay: stockFrom,
          toDay: stockTo,
          reason: stockReason === "all" ? undefined : stockReason,
          paginationOpts: {
            numItems: pageSize,
            cursor: pageIndex === 0 ? null : (cursors[pageIndex - 1] ?? null),
          },
        },
  );

  const currency = shop?.currency ?? "USD";
  const timezone = shop?.timezone ?? "Asia/Phnom_Penh";
  const years = useMemo(() => {
    const current = new Date().getFullYear();
    return Array.from({ length: 11 }, (_, i) => current - 5 + i);
  }, []);

  const stats = report
    ? [
        { label: t().reports.moneyIn, value: report.moneyIn },
        { label: t().reports.refunds, value: -report.refunds, muted: true },
        { label: t().reports.itemsCost, value: -report.cogs, muted: true },
        { label: t().reports.deliveryIncome, value: report.deliveryIncome },
        { label: t().reports.deliveryCost, value: -report.deliveryCost, muted: true },
        { label: t().reports.expenses, value: -report.expenses, muted: true },
      ]
    : [];

  type MovementRow = NonNullable<typeof movements>["page"][number];

  const movementColumns = useMemo<DataTableColumn<MovementRow>[]>(
    () => [
      {
        accessorKey: "ts",
        header: t().stock.dateCol,
        enableSorting: false,
        cell: ({ row }) => formatDateTime(row.original.row.ts, timezone, lang),
      },
      {
        accessorKey: "label",
        header: t().reports.itemCol,
        enableSorting: false,
        cell: ({ row }) => (
          <span className="block max-w-56 truncate">{row.original.label}</span>
        ),
      },
      {
        accessorKey: "delta",
        header: t().reports.inOutCol,
        enableSorting: false,
        cell: ({ row }) => (
          <span
            className={
              row.original.row.delta > 0
                ? "font-medium"
                : "font-medium text-destructive"
            }
          >
            {row.original.row.delta > 0
              ? `+${row.original.row.delta}`
              : String(row.original.row.delta)}
          </span>
        ),
      },
      {
        accessorKey: "reason",
        header: t().stock.reasonCol,
        enableSorting: false,
        cell: ({ row }) => t().stock.reasons[row.original.row.reason],
      },
      {
        accessorKey: "userName",
        header: t().reports.byCol,
        enableSorting: false,
        cell: ({ row }) => row.original.userName,
      },
    ],
    [timezone, lang],
  );

  const channelTotals = useMemo(() => {
    if (!channelReport) return null;
    return {
      orders: channelReport.reduce((sum, r) => sum + r.orders, 0),
      revenue: channelReport.reduce((sum, r) => sum + r.revenue, 0),
      profit: channelReport.reduce((sum, r) => sum + r.profit, 0),
    };
  }, [channelReport]);

  // T24 — one-shot export of the CURRENT period as a per-day P/L CSV.
  // The server re-derives every number; the client only picks the file up.
  async function exportReportCsv() {
    try {
      setExporting(true);
      const result = await convex.query(api.reports.getReportCsv, {
        period: { type: periodType, value: periodValue },
      });
      const r = t().reports;
      downloadCsv(`report-${periodType}-${periodValue}.csv`, [
        [r.csvDay, r.moneyIn, r.refunds, r.itemsCost, r.expenses, r.profit],
        ...result.rows.map((row) => [
          row.day,
          centsToDecimal(row.moneyIn),
          centsToDecimal(row.refunds),
          centsToDecimal(row.cogs),
          centsToDecimal(row.expenses),
          centsToDecimal(row.profit),
        ]),
      ]);
      toast.success(t().reports.exportDone);
    } catch (err) {
      toastError(err);
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="flex w-full flex-col">
      <PageToolbar icon={Analytics01Icon} title={t().nav.reports} />

      <div className="flex flex-col gap-4 p-4">
        {/* Which report */}
        <Card>
          <CardContent>
            <Tabs
              value={reportType}
              onValueChange={(value) => setReportType(value as ReportType)}
              className="w-full"
            >
              <TabsList className="w-full sm:w-auto">
                <TabsTrigger value="pl">{t().reports.reportPl}</TabsTrigger>
                <TabsTrigger value="channels">{t().reports.reportChannels}</TabsTrigger>
                <TabsTrigger value="stock">{t().reports.reportStock}</TabsTrigger>
              </TabsList>
            </Tabs>
          </CardContent>
        </Card>

        {/* Period / range controls */}
        {reportType !== "stock" && (
          <Card>
            <CardContent className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
              <Tabs
                value={periodType}
                onValueChange={(value) => setPeriodType(value as PeriodType)}
                className="w-full sm:w-auto"
              >
                <TabsList>
                  <TabsTrigger value="day">{t().reports.periodDaily}</TabsTrigger>
                  <TabsTrigger value="month">{t().reports.periodMonthly}</TabsTrigger>
                  <TabsTrigger value="year">{t().reports.periodYearly}</TabsTrigger>
                </TabsList>
              </Tabs>
              {periodType === "day" && (
                <Input
                  type="date"
                  value={dayValue}
                  onChange={(e) => e.target.value && setDayValue(e.target.value)}
                  className="w-full sm:w-44"
                  aria-label={t().reports.periodDaily}
                />
              )}
              {periodType === "month" && (
                <Input
                  type="month"
                  value={monthValue}
                  onChange={(e) => e.target.value && setMonthValue(e.target.value)}
                  className="w-full sm:w-44"
                  aria-label={t().reports.periodMonthly}
                />
              )}
              {periodType === "year" && (
                <Select
                  value={yearValue}
                  // Base UI shows the RAW value in the trigger without this map.
                  items={Object.fromEntries(years.map((year) => [String(year), String(year)]))}
                  onValueChange={(value) => value != null && setYearValue(value)}
                >
                  <SelectTrigger className="w-full sm:w-44" aria-label={t().reports.periodYearly}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {years.map((year) => (
                      <SelectItem key={year} value={String(year)}>
                        {String(year)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              <Button
                type="button"
                variant="outline"
                onClick={exportReportCsv}
                disabled={exporting}
              >
                <HugeiconsIcon icon={Download01Icon} strokeWidth={2} className="size-4" />
                {t().reports.exportCsv}
              </Button>
            </CardContent>
          </Card>
        )}

        {reportType === "stock" && (
          <Card>
            <CardContent className="flex flex-col gap-3 sm:flex-row sm:items-end">
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-muted-foreground">{t().reports.stockFrom}</span>
                <Input
                  type="date"
                  value={stockFrom}
                  onChange={(e) => {
                    if (e.target.value) {
                      setStockFrom(e.target.value);
                      resetPages();
                    }
                  }}
                  className="w-full sm:w-44"
                />
              </label>
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-muted-foreground">{t().reports.stockTo}</span>
                <Input
                  type="date"
                  value={stockTo}
                  onChange={(e) => {
                    if (e.target.value) {
                      setStockTo(e.target.value);
                      resetPages();
                    }
                  }}
                  className="w-full sm:w-44"
                />
              </label>
              <Select
                value={stockReason}
                // Base UI shows the RAW value in the trigger without this map.
                items={{
                  all: t().reports.allReasons,
                  ...Object.fromEntries(
                    REASON_OPTIONS.map((reason) => [reason, t().stock.reasons[reason]])
                  ),
                }}
                onValueChange={(value) => {
                  // Values come only from the SelectItems below ("all" or a
                  // REASON_OPTIONS entry), so the cast is safe.
                  if (value != null) {
                    setStockReason(value as StockReason | "all");
                    resetPages();
                  }
                }}
              >
                <SelectTrigger className="w-full sm:w-44" aria-label={t().stock.reasonCol}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t().reports.allReasons}</SelectItem>
                  {REASON_OPTIONS.map((reason) => (
                    <SelectItem key={reason} value={reason}>
                      {t().stock.reasons[reason]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </CardContent>
          </Card>
        )}

        {/* --- P/L panel --- */}
        {reportType === "pl" &&
          (report === undefined ? (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {Array.from({ length: 6 }, (_, i) => (
                <Skeleton key={i} className="h-28 w-full" />
              ))}
            </div>
          ) : (
            <>
              <Card>
                <CardHeader>
                  <CardTitle className="text-base font-medium">
                    {report.profit >= 0 ? t().reports.profit : t().reports.loss}
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <p
                    className={
                      report.profit >= 0
                        ? "font-heading text-3xl font-semibold"
                        : "font-heading text-3xl font-semibold text-destructive"
                    }
                  >
                    {formatMoney(Math.abs(report.profit), currency, lang)}
                  </p>
                </CardContent>
              </Card>

              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {stats.map((stat) => (
                  <Card key={stat.label}>
                    <CardHeader>
                      <CardTitle className="text-base font-medium">{stat.label}</CardTitle>
                    </CardHeader>
                    <CardContent>
                      <p
                        className={
                          stat.muted
                            ? "font-heading text-2xl font-semibold text-muted-foreground"
                            : "font-heading text-2xl font-semibold"
                        }
                      >
                        {formatMoney(stat.value, currency, lang)}
                      </p>
                    </CardContent>
                  </Card>
                ))}
              </div>

              <Card>
                <CardHeader>
                  <CardTitle className="text-base font-medium">
                    {t().reports.byCategory}
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  {report.expensesByCategory.length === 0 ? (
                    <p className="text-sm text-muted-foreground">{t().reports.noExpenses}</p>
                  ) : (
                    <ul className="flex flex-col gap-2">
                      {report.expensesByCategory.map((row) => (
                        <li
                          key={row.category}
                          className="flex items-center justify-between border-b pb-2 text-sm last:border-b-0"
                        >
                          <span>{row.category}</span>
                          <span className="font-medium">
                            {formatMoney(row.amount, currency, lang)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </CardContent>
              </Card>
            </>
          ))}

        {/* --- Sales pages panel --- */}
        {reportType === "channels" && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base font-medium">
                {t().reports.reportChannels}
              </CardTitle>
            </CardHeader>
            <CardContent>
              {channelReport === undefined ? (
                <Skeleton className="h-40 w-full" />
              ) : channelReport.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t().reports.noChannels}</p>
              ) : (
                <ul className="flex flex-col">
                  <li className="flex items-center justify-between gap-2 border-b pb-2 text-sm font-medium">
                    <span className="flex-1">{t().reports.reportChannels}</span>
                    <span className="w-16 text-right">{t().reports.ordersCol}</span>
                    <span className="w-24 text-right">{t().reports.revenueCol}</span>
                    <span className="w-24 text-right">{t().reports.profitCol}</span>
                  </li>
                  {channelReport.map((row) => (
                    <li
                      key={row.channelId}
                      className="flex items-center justify-between gap-2 border-b py-2 text-sm last:border-b-0"
                    >
                      <span className="flex-1 truncate">{row.channelName}</span>
                      <span className="w-16 text-right">{String(row.orders)}</span>
                      <span className="w-24 text-right font-medium">
                        {formatMoney(row.revenue, currency, lang)}
                      </span>
                      <span
                        className={
                          row.profit < 0
                            ? "w-24 text-right font-medium text-destructive"
                            : "w-24 text-right font-medium"
                        }
                      >
                        {formatMoney(row.profit, currency, lang)}
                      </span>
                    </li>
                  ))}
                  {channelTotals && (
                    <li className="flex items-center justify-between gap-2 pt-2 text-sm font-medium">
                      <span className="flex-1">{t().common.total}</span>
                      <span className="w-16 text-right">{String(channelTotals.orders)}</span>
                      <span className="w-24 text-right">
                        {formatMoney(channelTotals.revenue, currency, lang)}
                      </span>
                      <span className="w-24 text-right">
                        {formatMoney(channelTotals.profit, currency, lang)}
                      </span>
                    </li>
                  )}
                </ul>
              )}
            </CardContent>
          </Card>
        )}

        {/* --- Stock movements panel --- */}
        {reportType === "stock" && (
          <DataTable
            columns={movementColumns}
            data={movements?.page ?? []}
            persistKey="reports-stock"
            loading={movements === undefined}
            totalCount={movements?.total}
            pageIndex={pageIndex}
            pageSize={pageSize}
            onPageSizeChange={(size) => {
              setPageSize(size);
              resetPages();
            }}
            onPageChange={(direction) => {
              if (direction === "prev") {
                setPageIndex((i) => Math.max(0, i - 1));
              } else if (movements?.continueCursor) {
                setCursors((c) =>
                  c[pageIndex] === undefined ? [...c, movements.continueCursor] : c,
                );
                setPageIndex((i) => i + 1);
              }
            }}
            cardRender={(movement) => (
              <Card>
                <CardHeader>
                  <CardTitle>{movement.label}</CardTitle>
                  <p className="text-sm text-muted-foreground">
                    {formatDateTime(movement.row.ts, timezone, lang)}
                  </p>
                </CardHeader>
                <CardContent className="flex-row items-center justify-between">
                  <div className="flex flex-col gap-0.5">
                    <span
                      className={
                        movement.row.delta > 0
                          ? "font-heading text-lg font-semibold"
                          : "font-heading text-lg font-semibold text-destructive"
                      }
                    >
                      {movement.row.delta > 0
                        ? `+${movement.row.delta}`
                        : String(movement.row.delta)}
                    </span>
                    <span className="text-sm text-muted-foreground">
                      {t().stock.reasons[movement.row.reason]} · {movement.userName}
                    </span>
                  </div>
                </CardContent>
              </Card>
            )}
          />
        )}
      </div>
    </div>
  );
}
