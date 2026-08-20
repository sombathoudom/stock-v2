"use client";

import { DashboardSquare01Icon } from "@hugeicons/core-free-icons";
import { useQuery } from "convex/react";
import { useSyncExternalStore } from "react";

import { api } from "@convex/_generated/api";
import {
  DashboardRangeChips,
  type DashboardRange,
} from "@/components/features/dashboard/dashboard-range-chips";
import { DashboardKpiGrid } from "@/components/features/dashboard/kpi-grid";
import { QuickActionsCard } from "@/components/features/dashboard/quick-actions-card";
import { RecentSalesCard } from "@/components/features/dashboard/recent-sales-card";
import { SalesPurchasesChart } from "@/components/features/dashboard/sales-purchases-chart";
import { StockAlertCard } from "@/components/features/dashboard/stock-alert-card";
import { StockValueCard } from "@/components/features/dashboard/stock-value-card";
import { TopCustomersCard } from "@/components/features/dashboard/top-customers-card";
import { TopProductsCard } from "@/components/features/dashboard/top-products-card";
import { PageToolbar } from "@/components/features/shell/page-toolbar";
import { Skeleton } from "@/components/ui/skeleton";
import { useCurrentUser } from "@/hooks/use-current-user";
import { usePersistentState } from "@/hooks/use-persistent-state";
import { useShop } from "@/hooks/use-shop";
import { getLang, t } from "@/lib/utils";

// T20 — Dashboard. A time-of-day greeting with the staff member's name, a
// Today / 7D / 30D / MTD / YTD range filter (persisted across reloads), and
// the analytics: five KPI cards, Sales & Purchases by day/month, top
// products (donut + progress bars), top customers, stock value, quick
// actions, stock alerts and the 5 newest orders. Every number comes from
// one getOverview query — derived server-side, nothing stored.

const RANGES: DashboardRange[] = ["today", "7d", "30d", "mtd", "ytd"];

export default function DashboardPage() {
  const user = useCurrentUser();
  const shop = useShop();
  const lang = getLang();
  const [range, setRange] = usePersistentState<DashboardRange>("dashboard:range", "today");
  // A persisted value from an older version could be anything — fall back.
  const safeRange: DashboardRange = RANGES.includes(range) ? range : "today";

  const overview = useQuery(
    api.dashboard.getOverview,
    user == null ? "skip" : { range: safeRange },
  );

  // Time-of-day greeting. useSyncExternalStore reads the hour on the client
  // with a null server snapshot, so the server and the first client render
  // agree (no hydration mismatch); until then the title shows the page name.
  const hour = useSyncExternalStore(
    () => () => {}, // the hour is fixed for this visit — no updates to push
    () => new Date().getHours(),
    () => null,
  );
  const dash = t().dashboard;
  const firstName = (user?.name ?? "").trim().split(/\s+/)[0] || "…";
  const greeting =
    hour == null
      ? t().nav.dashboard
      : (hour < 12
          ? dash.greetingMorning
          : hour < 18
            ? dash.greetingAfternoon
            : dash.greetingEvening
        ).replace("{name}", firstName);

  const currency = shop?.currency ?? "USD";

  if (overview === undefined) {
    return (
      <div className="flex w-full flex-col">
        <PageToolbar icon={DashboardSquare01Icon} title={greeting}>
          <DashboardRangeChips value={safeRange} onChange={setRange} />
        </PageToolbar>
        <div className="flex flex-col gap-4 p-4">
          <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-5">
            {Array.from({ length: 5 }, (_, i) => (
              <Skeleton key={i} className="h-[104px] w-full" />
            ))}
          </div>
          <Skeleton className="h-80 w-full" />
        </div>
      </div>
    );
  }

  return (
    <div className="flex w-full flex-col">
      <PageToolbar icon={DashboardSquare01Icon} title={greeting}>
        <DashboardRangeChips value={safeRange} onChange={setRange} />
      </PageToolbar>

      <div className="flex flex-col gap-4 p-4">
        <DashboardKpiGrid kpis={overview.kpis} currency={currency} lang={lang} />

        <div className="grid gap-4 lg:grid-cols-3">
          <div className="lg:col-span-2">
            <SalesPurchasesChart
              buckets={overview.chart.buckets}
              type={overview.chart.type}
              currency={currency}
              lang={lang}
            />
          </div>
          <TopProductsCard
            topProducts={overview.topProducts}
            otherQty={overview.otherQty}
            currency={currency}
            lang={lang}
          />
        </div>

        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          <TopCustomersCard
            topCustomers={overview.topCustomers}
            currency={currency}
            lang={lang}
          />
          <StockValueCard
            totalValue={overview.stockValue.totalValue}
            totalUnits={overview.stockValue.totalUnits}
            currency={currency}
            lang={lang}
          />
          <QuickActionsCard deliveryEnabled={shop?.deliveryEnabled ?? false} />
          <StockAlertCard items={overview.lowStock} />
        </div>

        <RecentSalesCard rows={overview.recentSales} currency={currency} lang={lang} />
      </div>
    </div>
  );
}
