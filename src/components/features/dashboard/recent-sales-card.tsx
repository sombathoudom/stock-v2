"use client";

import type { FunctionReturnType } from "convex/server";
import Link from "next/link";

import { api } from "@convex/_generated/api";
import type { Language } from "@/config/labels";
import { SaleStatusBadge } from "@/components/features/sales/sale-status-badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { buttonVariants } from "@/components/ui/button";
import { formatMoney, t } from "@/lib/utils";

// Recent Sales — the range's 5 newest orders (drafts excluded), each row a
// link to the order's detail page with status and a friendly relative time.

type Overview = NonNullable<FunctionReturnType<typeof api.dashboard.getOverview>>;
export type RecentSaleRow = Overview["recentSales"][number];

function relativeTime(ts: number): string {
  const dash = t().dashboard;
  const minutes = Math.max(0, Math.floor((Date.now() - ts) / 60_000));
  if (minutes < 1) return dash.timeJustNow;
  if (minutes < 60) return dash.timeMinutesAgo.replace("{n}", String(minutes));
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return dash.timeHoursAgo.replace("{n}", String(hours));
  const days = Math.floor(hours / 24);
  return days === 1 ? dash.timeDayAgo : dash.timeDaysAgo.replace("{n}", String(days));
}

export function RecentSalesCard({
  rows,
  currency,
  lang,
}: {
  rows: RecentSaleRow[];
  currency: string;
  lang: Language;
}) {
  const dash = t().dashboard;

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle className="text-base font-medium">{dash.recentSalesTitle}</CardTitle>
        <Link href="/sales" className={buttonVariants({ variant: "ghost", size: "sm" })}>
          {t().nav.sales}
        </Link>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">{dash.recentSalesEmpty}</p>
        ) : (
          <ul className="flex flex-col">
            {rows.map((row) => (
              <li key={row.sale._id}>
                <Link
                  href={`/sales/${row.sale._id}`}
                  className="flex items-center justify-between gap-2 border-b py-2.5 text-sm last:border-b-0 hover:bg-muted/50"
                >
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <span className="truncate font-medium">{row.sale.code}</span>
                    <span className="flex items-center gap-2">
                      <span className="truncate text-muted-foreground">
                        {row.customerName}
                      </span>
                      <SaleStatusBadge status={row.sale.status} />
                    </span>
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-0.5">
                    <span className="font-medium">
                      {formatMoney(row.total, currency, lang)}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {relativeTime(row.sale.createdAt)}
                    </span>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
