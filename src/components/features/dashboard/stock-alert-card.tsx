"use client";

import type { Id } from "@convex/_generated/dataModel";
import Link from "next/link";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { buttonVariants } from "@/components/ui/button";
import { t } from "@/lib/utils";

// Stock Alert — variants at or under the shop's low-stock threshold, worst
// first (server-ordered). Out-of-stock qty shows in destructive red.

export type StockAlertItem = {
  variantId: Id<"productVariants">;
  label: string;
  qty: number;
};

export function StockAlertCard({ items }: { items: StockAlertItem[] }) {
  return (
    <Card className="h-full">
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle className="text-base font-medium">{t().dashboard.lowStockTitle}</CardTitle>
        <Link href="/stock" className={buttonVariants({ variant: "ghost", size: "sm" })}>
          {t().nav.stock}
        </Link>
      </CardHeader>
      <CardContent>
        {items.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t().dashboard.lowStockEmpty}</p>
        ) : (
          <ul className="flex flex-col">
            {items.map((row) => (
              <li
                key={row.variantId}
                className="flex items-center justify-between gap-2 border-b py-2 text-sm last:border-b-0"
              >
                <span className="truncate">{row.label}</span>
                <span
                  className={
                    row.qty <= 0
                      ? "shrink-0 font-medium text-destructive"
                      : "shrink-0 font-medium"
                  }
                >
                  {String(row.qty)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
