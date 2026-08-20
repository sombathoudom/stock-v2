"use client";

import { BoxIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";

import type { Language } from "@/config/labels";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatMoney, t } from "@/lib/utils";

// Stock Value — the money currently sitting on the shelf: Σ in-stock pieces ×
// their current weighted-average cost (server-derived, never stored).

export function StockValueCard({
  totalValue,
  totalUnits,
  currency,
  lang,
}: {
  totalValue: number;
  totalUnits: number;
  currency: string;
  lang: Language;
}) {
  const dash = t().dashboard;

  return (
    <Card className="h-full">
      <CardHeader className="flex-row items-center gap-3">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-violet/15 text-violet">
          <HugeiconsIcon icon={BoxIcon} strokeWidth={2} className="size-5" />
        </div>
        <CardTitle className="text-base font-medium">{dash.stockValueTitle}</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="font-heading text-2xl font-semibold">
          {formatMoney(totalValue, currency, lang)}
        </p>
        <p className="mt-1 text-sm text-muted-foreground">
          {dash.stockUnits.replace("{n}", String(totalUnits))}
        </p>
      </CardContent>
    </Card>
  );
}
