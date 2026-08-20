"use client";

import type { Id } from "@convex/_generated/dataModel";

import type { Language } from "@/config/labels";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn, formatMoney, t } from "@/lib/utils";

// Top Customers — the range's 5 best customers by money received (refunds
// already netted out server-side), ranked with revenue right-aligned.

export type TopCustomer = {
  customerId: Id<"customers">;
  name: string;
  revenue: number;
};

const RANK_TILE = [
  "bg-primary/15 text-primary",
  "bg-info/15 text-info",
  "bg-violet/15 text-violet",
  "bg-warning/15 text-warning",
  "bg-success/15 text-success",
];

export function TopCustomersCard({
  topCustomers,
  currency,
  lang,
}: {
  topCustomers: TopCustomer[];
  currency: string;
  lang: Language;
}) {
  const dash = t().dashboard;

  return (
    <Card className="h-full">
      <CardHeader>
        <CardTitle className="text-base font-medium">{dash.topCustomersTitle}</CardTitle>
      </CardHeader>
      <CardContent>
        {topCustomers.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            {dash.topCustomersEmpty}
          </p>
        ) : (
          <ol className="space-y-3">
            {topCustomers.map((customer, i) => (
              <li key={customer.customerId} className="flex items-center gap-3">
                <span
                  className={cn(
                    "flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold",
                    RANK_TILE[i]
                  )}
                >
                  {i + 1}
                </span>
                <span className="min-w-0 flex-1 truncate font-medium">
                  {customer.name}
                </span>
                <span className="shrink-0 tabular-nums text-muted-foreground">
                  {formatMoney(customer.revenue, currency, lang)}
                </span>
              </li>
            ))}
          </ol>
        )}
      </CardContent>
    </Card>
  );
}
