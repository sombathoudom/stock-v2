"use client";

import {
  HourglassIcon,
  Money01Icon,
  MoneyReceive01Icon,
  ShoppingCart01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useQuery } from "convex/react";

import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useCurrentUser } from "@/hooks/use-current-user";
import { useShop } from "@/hooks/use-shop";
import { formatMoney, getLang, t } from "@/lib/utils";
import type { SaleStatus } from "./sale-status-flow";

// Summary cards above the sales list — Sales / Total / Paid / Due. They
// follow the filters (same args as the list), so the numbers always match
// the rows below. Each card's icon has its own tinted color.

export type SalesFilters = {
  search?: string | undefined;
  status?: SaleStatus | undefined;
  channelId?: Id<"salesChannels"> | undefined;
  day?: string | undefined;
  customerId?: Id<"customers"> | undefined;
  fromDay?: string | undefined;
  toDay?: string | undefined;
  paymentStatus?: "paid" | "partly_paid" | "unpaid" | undefined;
};

function SummaryCard({
  icon,
  tint,
  label,
  value,
}: {
  icon: typeof Money01Icon;
  tint: string;
  label: string;
  value: string;
}) {
  return (
    <Card className="gap-0 p-3">
      <CardContent className="flex-row items-center gap-2.5">
        <span
          className={`flex size-9 shrink-0 items-center justify-center rounded-full ${tint}`}
        >
          <HugeiconsIcon icon={icon} strokeWidth={2} className="size-5" />
        </span>
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-xs text-muted-foreground">{label}</span>
          <span className="truncate text-sm font-semibold tabular-nums">
            {value}
          </span>
        </span>
      </CardContent>
    </Card>
  );
}

export function SalesSummaryCards({ filters }: { filters: SalesFilters }) {
  const user = useCurrentUser();
  const shop = useShop();

  const summary = useQuery(
    api.sales.summary,
    user == null ? "skip" : { ...filters }
  );

  if (summary === undefined || shop == null) {
    return (
      <div className="grid grid-cols-2 gap-2 px-4 pt-4 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-16 w-full" />
        ))}
      </div>
    );
  }

  const lang = getLang();
  const money = (cents: number) => formatMoney(cents, shop.currency, lang);

  return (
    <div className="grid grid-cols-2 gap-2 px-4 pt-4 lg:grid-cols-4">
      <SummaryCard
        icon={ShoppingCart01Icon}
        tint="bg-info/10 text-info"
        label={t().nav.sales}
        value={String(summary.count)}
      />
      <SummaryCard
        icon={Money01Icon}
        tint="bg-violet/10 text-violet"
        label={t().sales.total}
        value={money(summary.total)}
      />
      <SummaryCard
        icon={MoneyReceive01Icon}
        tint="bg-success/10 text-success"
        label={t().sales.paid}
        value={money(summary.paid)}
      />
      <SummaryCard
        icon={HourglassIcon}
        tint="bg-warning/10 text-warning"
        label={t().sales.due}
        value={money(summary.due)}
      />
    </div>
  );
}
