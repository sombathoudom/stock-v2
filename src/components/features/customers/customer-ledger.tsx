"use client";

import { useQuery } from "convex/react";
import Link from "next/link";
import { useState } from "react";

import { api } from "@convex/_generated/api";
import type { Doc } from "@convex/_generated/dataModel";
import {
  ReminderDialog,
  type ReminderRow,
} from "@/components/features/dashboard/reminder-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useCurrentUser } from "@/hooks/use-current-user";
import { useShop } from "@/hooks/use-shop";
import { formatMoney, t } from "@/lib/utils";

// T27 — the customer's credit ledger (AGENTS.md). Everything is DERIVED on
// read — there is no stored balance anywhere. The server returns each
// still-owing order with its remaining amount; the total owed is the sum.
// One-tap payment reminders reuse the dashboard's WhatsApp/Telegram dialog.

const PAGE_SIZE = 10;

export function CustomerLedger({
  customer,
  currency,
}: {
  customer: Doc<"customers">;
  currency: string;
}) {
  const user = useCurrentUser();
  const shop = useShop();
  const [cursors, setCursors] = useState<string[]>([]);
  const [pageIndex, setPageIndex] = useState(0);
  const [reminderRow, setReminderRow] = useState<ReminderRow | null>(null);

  const ledger = useQuery(
    api.sales.listOwedByCustomer,
    user == null
      ? "skip"
      : {
          customerId: customer._id,
          paginationOpts: {
            numItems: PAGE_SIZE,
            cursor: pageIndex === 0 ? null : (cursors[pageIndex - 1] ?? null),
          },
        },
  );

  if (ledger === undefined) {
    return <Skeleton className="h-40 w-full" />;
  }

  if (ledger.page.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{t().customers.owedTitle}</CardTitle>
          <CardDescription>{t().customers.owedEmpty}</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-2">
        <div>
          <CardTitle>{t().customers.owedTitle}</CardTitle>
          <CardDescription>
            {t().customers.owedOrders.replace("{n}", String(ledger.total))}
          </CardDescription>
        </div>
        <span className="font-heading text-lg font-semibold">
          {formatMoney(ledger.totalOwed, currency)}
        </span>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {ledger.page.map((row) => (
          <div
            key={row.sale._id}
            className="flex items-center justify-between gap-2 rounded-md border p-3"
          >
            <div className="min-w-0">
              <Link
                href={`/sales/${row.sale._id}`}
                className="block truncate text-sm font-medium underline-offset-2 hover:underline"
              >
                {row.sale.code}
              </Link>
              <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <Badge variant="secondary">{t().status[row.sale.status]}</Badge>
                <span>{row.channelName}</span>
              </div>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {t()
                  .customers.owedPaidOf.replace("{paid}", formatMoney(row.paid, currency))
                  .replace("{total}", formatMoney(row.total, currency))}
              </p>
            </div>
            <div className="flex shrink-0 flex-col items-end gap-1">
              <span className="text-sm font-medium">
                {formatMoney(row.remaining, currency)}
              </span>
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  setReminderRow({
                    saleCode: row.sale.code,
                    customerName: row.customerName,
                    customerPhone: row.customerPhone,
                    remaining: row.remaining,
                  })
                }
              >
                {t().dashboard.reminder}
              </Button>
            </div>
          </div>
        ))}
        {ledger.continueCursor && (
          <Button
            variant="ghost"
            size="sm"
            className="w-full"
            onClick={() => {
              setCursors((c) =>
                c[pageIndex] === undefined ? [...c, ledger.continueCursor] : c,
              );
              setPageIndex((i) => i + 1);
            }}
          >
            {t().common.more}
          </Button>
        )}
      </CardContent>
      <ReminderDialog
        open={reminderRow != null}
        onOpenChange={(open) => {
          if (!open) setReminderRow(null);
        }}
        row={reminderRow}
        shopName={shop?.name ?? t().appName}
        currency={currency}
      />
    </Card>
  );
}
