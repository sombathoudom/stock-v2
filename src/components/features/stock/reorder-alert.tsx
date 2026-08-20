"use client";

import Link from "next/link";
import type { FunctionReturnType } from "convex/server";
import { useState } from "react";

import { api } from "@convex/_generated/api";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { cn, t } from "@/lib/utils";

// T23 — compact reorder attention panel on the stock page (AGENTS.md T23 +
// redesign spec): low-stock variants grouped per product, every number
// labeled ("{n} remaining" / "Reorder level: {n}"), amber for low stock and
// red for out of stock. The title counts DISTINCT products ("1 product needs
// attention") even though the rows are per variant — don't "fix" that.
// The data query lives in the page; this component only renders it.

type LowStock = NonNullable<FunctionReturnType<typeof api.lowStock.lowStock>>;

const INITIAL_ROWS = 4;

export function ReorderAlert({
  items,
  threshold,
}: {
  items: LowStock["items"];
  threshold: number;
}) {
  const labels = t().stock;
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? items : items.slice(0, INITIAL_ROWS);
  const productCount = new Set(items.map((item) => item.productId)).size;

  return (
    <Card className="border-warning/40">
      <CardContent className="space-y-2 p-3 md:p-4">
        <p className="text-sm font-medium">
          {(productCount === 1
            ? labels.needsAttentionOne
            : labels.needsAttentionMany
          ).replace("{n}", String(productCount))}
        </p>
        <div className="flex flex-col gap-1.5">
          {visible.map((item) => (
            <div
              key={item.variantId}
              className={cn(
                "flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-md border-s-2 px-3 py-2",
                item.qty === 0
                  ? "border-destructive bg-destructive/5"
                  : "border-warning bg-warning/5"
              )}
            >
              <div className="min-w-0 flex-1 basis-44">
                <p className="truncate font-medium">{item.productName}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {item.label}
                </p>
              </div>
              <span
                className={cn(
                  "text-sm tabular-nums",
                  item.qty === 0
                    ? "font-semibold text-destructive"
                    : "font-medium text-warning"
                )}
              >
                {labels.remaining.replace("{n}", String(item.qty))}
              </span>
              <span className="text-xs text-muted-foreground">
                {labels.reorderLevel.replace("{n}", String(threshold))}
              </span>
              <div className="flex items-center gap-1.5">
                {/* Navigation links styled as buttons: a real anchor keeps link
                    semantics (Enter activates, middle-click opens a tab) and
                    avoids Base UI's nativeButton warning — no role="button"
                    on something that navigates. */}
                <Link
                  href="/purchases/new"
                  className={buttonVariants({ variant: "outline", size: "sm" })}
                >
                  {labels.createPurchaseOrder}
                </Link>
                <Link
                  href={`/stock/${item.productId}`}
                  className={buttonVariants({ variant: "ghost", size: "sm" })}
                >
                  {labels.viewProduct}
                </Link>
              </div>
            </div>
          ))}
        </div>
        {items.length > INITIAL_ROWS && (
          <Button
            variant="ghost"
            size="sm"
            aria-expanded={expanded}
            onClick={() => setExpanded((e) => !e)}
          >
            {labels.viewAll}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
