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
import { buttonVariants } from "@/components/ui/button";
import { t } from "@/lib/utils";

// Quick actions — the shop's everyday entry points, one tap each. The
// delivery action only appears when the shop has the delivery module on.

export function QuickActionsCard({ deliveryEnabled }: { deliveryEnabled: boolean }) {
  const quickActions = [
    { href: "/sales/new", icon: ShoppingBag01Icon, label: t().dashboard.qaNewSale },
    { href: "/purchases/new", icon: BoxIcon, label: t().dashboard.qaNewPurchase },
    { href: "/expenses/new", icon: Calculator01Icon, label: t().dashboard.qaNewExpense },
    ...(deliveryEnabled
      ? [{ href: "/delivery", icon: PackageReceive01Icon, label: t().dashboard.qaDelivery }]
      : []),
    { href: "/stock", icon: WarehouseIcon, label: t().dashboard.qaStock },
    {
      href: "/adjustments?tab=quick",
      icon: AdjustPositionIcon,
      label: t().dashboard.qaAdjustment,
    },
    {
      href: "/adjustments?tab=stocktake",
      icon: ClipboardCheckIcon,
      label: t().dashboard.qaStocktake,
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
              className={buttonVariants({ variant: "outline", size: "lg" })}
            >
              <HugeiconsIcon icon={action.icon} size={18} />
              <span className="truncate">{action.label}</span>
            </Link>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
