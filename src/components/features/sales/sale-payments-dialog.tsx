"use client";

import { useQuery } from "convex/react";

import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { useCurrentUser } from "@/hooks/use-current-user";
import { useShop } from "@/hooks/use-shop";
import { cn, formatDateTime, formatMoney, getLang, t } from "@/lib/utils";
import { SaleStatusBadge } from "./sale-status-badge";

// "Show payment" from the sales list — the order's payment history,
// read-only: total / paid / remaining summary plus every payment row
// (refunds appear as negative amounts, in red). Mirrors the detail page's
// payment card so the owner gets the same picture without leaving the list.

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-2 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium tabular-nums">{value}</span>
    </div>
  );
}

export function SalePaymentsDialog({
  saleId,
  onClose,
}: {
  saleId: Id<"sales">;
  onClose: () => void;
}) {
  const user = useCurrentUser();
  const shop = useShop();
  const detail = useQuery(
    api.sales.getDetail,
    user == null ? "skip" : { saleId }
  );

  if (detail === undefined) {
    return (
      <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t().sales.paymentHistory}</DialogTitle>
          </DialogHeader>
          <Skeleton className="h-64 w-full" />
        </DialogContent>
      </Dialog>
    );
  }
  if (detail === null) {
    return (
      <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t().sales.notFoundTitle}</DialogTitle>
            <DialogDescription>{t().sales.notFoundBody}</DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button type="button" onClick={onClose}>
              {t().common.close}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  const currency = shop?.currency ?? "USD";
  const timezone = shop?.timezone ?? "Asia/Phnom_Penh";
  const payments = [...detail.payments].sort(
    (a, b) => b.receivedAt - a.receivedAt
  );

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex flex-wrap items-center gap-2">
            {t().sales.paymentHistory}
            <SaleStatusBadge status={detail.sale.status} />
          </DialogTitle>
          <DialogDescription>{detail.sale.code}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-1 rounded-md border p-3">
          <SummaryRow
            label={t().sales.total}
            value={formatMoney(detail.total, currency, getLang())}
          />
          <SummaryRow
            label={t().sales.paid}
            value={formatMoney(detail.paid, currency, getLang())}
          />
          <SummaryRow
            label={t().sales.remaining}
            value={formatMoney(detail.remaining, currency, getLang())}
          />
        </div>
        {payments.length === 0 ? (
          <p className="py-2 text-center text-sm text-muted-foreground">
            {t().sales.emptyHistory}
          </p>
        ) : (
          <ul className="flex flex-col divide-y">
            {payments.map((p) => (
              <li
                key={p._id}
                className="flex flex-wrap items-center gap-2 py-2 text-sm"
              >
                <span className="text-muted-foreground">
                  {formatDateTime(p.receivedAt, timezone, getLang())}
                </span>
                <Badge variant="secondary">
                  {t().sales.methods[p.method]}
                </Badge>
                <span
                  className={cn(
                    "ml-auto tabular-nums",
                    p.amount < 0 && "text-destructive"
                  )}
                >
                  {p.amount < 0
                    ? `−${formatMoney(-p.amount, currency, getLang())}`
                    : formatMoney(p.amount, currency, getLang())}
                </span>
                {p.note ? (
                  <span className="w-full text-xs text-muted-foreground">
                    {p.note}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        <DialogFooter className="gap-2">
          <Button type="button" onClick={onClose}>
            {t().common.close}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
