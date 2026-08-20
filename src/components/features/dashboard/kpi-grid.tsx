"use client";

import {
  Cash01Icon,
  Invoice01Icon,
  ShoppingBag01Icon,
  TrendingUpDownIcon,
  Wallet01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import Link from "next/link";

import type { Language } from "@/config/labels";
import { Card, CardContent } from "@/components/ui/card";
import { cn, formatMoney, t } from "@/lib/utils";

// The five KPI cards: Sales, Purchases, Sales due, Invoices, Profit. Each
// icon sits in its own colorful tile (semantic CSS tokens — never hardcoded
// colors, so the theme preset restyles everything). Sales due links to the
// unpaid sales list.

export type DashboardKpis = {
  sales: number;
  purchases: number;
  salesDue: number;
  invoices: number;
  profit: number;
};

export function DashboardKpiGrid({
  kpis,
  currency,
  lang,
}: {
  kpis: DashboardKpis;
  currency: string;
  lang: Language;
}) {
  const dash = t().dashboard;
  const cards: {
    key: string;
    label: string;
    value: string;
    icon: typeof Cash01Icon;
    tile: string;
    href?: string;
    negative?: boolean;
  }[] = [
    {
      key: "sales",
      label: dash.kpiSales,
      value: formatMoney(kpis.sales, currency, lang),
      icon: Cash01Icon,
      tile: "bg-success/15 text-success",
    },
    {
      key: "purchases",
      label: dash.kpiPurchases,
      value: formatMoney(kpis.purchases, currency, lang),
      icon: ShoppingBag01Icon,
      tile: "bg-info/15 text-info",
    },
    {
      key: "salesDue",
      label: dash.kpiSalesDue,
      value: formatMoney(kpis.salesDue, currency, lang),
      icon: Wallet01Icon,
      tile: "bg-warning/15 text-warning",
      href: "/sales?filter=unpaid",
    },
    {
      key: "invoices",
      label: dash.kpiInvoices,
      value: String(kpis.invoices),
      icon: Invoice01Icon,
      tile: "bg-violet/15 text-violet",
    },
    {
      key: "profit",
      label: dash.kpiProfit,
      value: formatMoney(kpis.profit, currency, lang),
      icon: TrendingUpDownIcon,
      tile: "bg-primary/15 text-primary",
      negative: kpis.profit < 0,
    },
  ];

  return (
    <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-5">
      {cards.map((card) => {
        const content = (
          <>
            <div
              className={cn(
                "flex size-10 shrink-0 items-center justify-center rounded-lg",
                card.tile
              )}
            >
              <HugeiconsIcon icon={card.icon} strokeWidth={2} className="size-5" />
            </div>
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-muted-foreground">
                {card.label}
              </p>
              <p
                className={cn(
                  "truncate font-heading text-2xl font-semibold",
                  card.negative && "text-destructive"
                )}
              >
                {card.value}
              </p>
            </div>
          </>
        );
        return card.href ? (
          <Link key={card.key} href={card.href} className="h-full">
            <Card className="h-full transition-colors hover:bg-muted/50">
              <CardContent className="flex h-full items-center gap-3 p-4">
                {content}
              </CardContent>
            </Card>
          </Link>
        ) : (
          <Card key={card.key} className="h-full">
            <CardContent className="flex h-full items-center gap-3 p-4">
              {content}
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
