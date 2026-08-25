"use client";

import {
  AdjustPositionIcon,
  BoxIcon,
  Calculator01Icon,
  ClipboardCheckIcon,
  PackageReceive01Icon,
  ShoppingBag01Icon,
  WarehouseIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import Link from "next/link";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn, t } from "@/lib/utils";

// Quick actions — the shop's everyday entry points, one tap each. Each
// action is a real Next.js Link styled like a mini card with its own
// colorful icon tile (semantic CSS tokens — never hardcoded colors, so the
// theme preset restyles everything). The delivery action only appears when
// the shop has the delivery module on.

export function QuickActionsCard({ deliveryEnabled }: { deliveryEnabled: boolean }) {
  const quickActions = [
    {
      href: "/sales/new",
      icon: ShoppingBag01Icon,
      label: t().dashboard.qaNewSale,
      tile: "bg-success/15 text-success group-hover:bg-success/25",
    },
    {
      href: "/purchases/new",
      icon: BoxIcon,
      label: t().dashboard.qaNewPurchase,
      tile: "bg-info/15 text-info group-hover:bg-info/25",
    },
    {
      href: "/expenses/new",
      icon: Calculator01Icon,
      label: t().dashboard.qaNewExpense,
      tile: "bg-warning/15 text-warning group-hover:bg-warning/25",
    },
    ...(deliveryEnabled
      ? [
          {
            href: "/delivery",
            icon: PackageReceive01Icon,
            label: t().dashboard.qaDelivery,
            tile: "bg-violet/15 text-violet group-hover:bg-violet/25",
          },
        ]
      : []),
    {
      href: "/stock",
      icon: WarehouseIcon,
      label: t().dashboard.qaStock,
      tile: "bg-primary/15 text-primary group-hover:bg-primary/25",
    },
    {
      href: "/adjustments?tab=quick",
      icon: AdjustPositionIcon,
      label: t().dashboard.qaAdjustment,
      tile: "bg-destructive/15 text-destructive group-hover:bg-destructive/25",
    },
    {
      href: "/adjustments?tab=stocktake",
      icon: ClipboardCheckIcon,
      label: t().dashboard.qaStocktake,
      tile: "bg-success/15 text-success group-hover:bg-success/25",
    },
  ];

  return (
    <Card className="h-full">
      <CardHeader>
        <CardTitle className="text-base font-medium">{t().dashboard.quickActions}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {quickActions.map((action) => (
            <Link
              key={action.href}
              href={action.href}
              className="group flex min-h-[4.5rem] flex-col justify-center gap-2 rounded-lg border bg-background p-3 transition-colors hover:border-primary/40 hover:bg-muted/60 focus-visible:outline-ring"
            >
              <span
                className={cn(
                  "flex size-9 shrink-0 items-center justify-center rounded-lg transition-colors",
                  action.tile,
                )}
              >
                <HugeiconsIcon icon={action.icon} strokeWidth={2} className="size-5" />
              </span>
              <span className="break-words text-xs font-medium leading-snug sm:text-sm">
                {action.label}
              </span>
            </Link>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
