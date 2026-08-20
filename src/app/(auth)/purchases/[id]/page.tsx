"use client";

import { BoxIcon } from "@hugeicons/core-free-icons";
import { useQuery } from "convex/react";
import { useRouter } from "next/navigation";
import { use } from "react";

import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import {
  PurchaseForm,
  type InitialPurchase,
} from "@/components/features/purchases/purchase-form";
import { PageToolbar } from "@/components/features/shell/page-toolbar";
import { QueryErrorBoundary } from "@/components/features/shell/query-error-boundary";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useCurrentUser } from "@/hooks/use-current-user";
import { useShop } from "@/hooks/use-shop";
import { formatDateTime, getLang, isConvexId, t } from "@/lib/utils";

// Edit page. The id in the URL is the Convex UUID — never an enumerable
// number — and the server only returns the purchase that id points at.

export default function EditPurchasePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);

  return (
    <div className="flex w-full flex-col">
      <PageToolbar icon={BoxIcon} title={t().purchases.editTitle} />
      <div className="p-4">
        {/* key={id} remounts a fresh boundary when navigating between ids */}
        <QueryErrorBoundary
          key={id}
          fallbackTitle={t().purchases.notFoundTitle}
          fallbackBody={t().purchases.notFoundBody}
        >
          <PurchaseLoader id={id} />
        </QueryErrorBoundary>
      </div>
    </div>
  );
}

// The query-driven part — it must live BELOW the boundary so a render-phase
// throw (a checksum-invalid id the client can't verify) is caught here.
function PurchaseLoader({ id }: { id: string }) {
  const router = useRouter();
  const user = useCurrentUser();
  const shop = useShop();
  const lang = getLang();
  // Fast-path check for obviously malformed ids — avoids firing a doomed
  // request; the boundary above catches anything this misses.
  const validId = isConvexId(id);
  const detail = useQuery(
    api.purchases.get,
    user == null || !validId ? "skip" : { purchaseId: id as Id<"purchases"> }
  );
  // T21 — the stock this purchase brought in (its own ledger rows).
  const trace = useQuery(
    api.reports.purchaseTrace,
    user == null || !validId ? "skip" : { purchaseId: id as Id<"purchases"> }
  );

  if (!validId || detail === null) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{t().purchases.notFoundTitle}</CardTitle>
          <CardDescription>{t().purchases.notFoundBody}</CardDescription>
        </CardHeader>
      </Card>
    );
  }
  if (detail === undefined) {
    return <Skeleton className="h-96 w-full" />;
  }
  const initial: InitialPurchase = {
    purchase: detail.purchase,
    supplier: detail.supplier,
    items: detail.items,
  };
  return (
    <div className="flex flex-col gap-4">
      <PurchaseForm initial={initial} onDone={() => router.push("/purchases")} />
      {/* Per-purchase stock trace: the ledger rows this purchase wrote. */}
      <Card>
        <CardHeader>
          <CardTitle>{t().purchases.stockInTitle}</CardTitle>
          <CardDescription>{t().purchases.stockInHint}</CardDescription>
        </CardHeader>
        <CardContent>
          {trace === undefined ? (
            <Skeleton className="h-24 w-full" />
          ) : trace.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t().stock.emptyHistory}</p>
          ) : (
            <ul className="flex flex-col">
              {trace.map(({ row, userName }) => (
                <li
                  key={row._id}
                  className="flex items-center justify-between gap-2 border-b py-2 text-sm last:border-b-0"
                >
                  <div className="flex min-w-0 flex-col">
                    <span className="font-medium">
                      {t().stock.reasons[row.reason]}
                      {" · "}
                      {row.delta > 0 ? `+${row.delta}` : String(row.delta)}
                    </span>
                    <span className="truncate text-muted-foreground">
                      {formatDateTime(row.ts, shop?.timezone ?? "Asia/Phnom_Penh", lang)} ·{" "}
                      {t().stock.movedBy} {userName}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
