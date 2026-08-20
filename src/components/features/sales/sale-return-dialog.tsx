"use client";

import { Cancel01Icon, PackageReceive01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation, useQuery } from "convex/react";
import { useState } from "react";
import { toast } from "sonner";

import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { useCurrentUser } from "@/hooks/use-current-user";
import { cn, inputToCents, t, toastError } from "@/lib/utils";
import type { SaleDetail } from "./invoice-dialog";

// "Sale return" from the sales list — several lines at once. Stock flows back
// via `return` ledger rows; the optional refund records the money given back
// (a negative payment row) in the same flow, capped at what the customer paid.
// Quantities start at 0 — a line only returns when the staff says so.

type SaleItemDetail = SaleDetail["items"][number];

/** "Basic Tee — M · Black" — the same plain-language label the server uses. */
function lineLabel({ product, variant }: SaleItemDetail): string {
  return `${product.name} — ${variant.size}${variant.color ? ` · ${variant.color}` : ""}`;
}

export function SaleReturnDialog({
  saleId,
  currency,
  onClose,
}: {
  saleId: Id<"sales">;
  currency: string;
  onClose: () => void;
}) {
  const user = useCurrentUser();
  const detail = useQuery(
    api.sales.getDetail,
    user == null ? "skip" : { saleId }
  );

  if (detail === undefined) {
    return (
      <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t().sales.returnItemTitle}</DialogTitle>
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

  return <ReturnForm detail={detail} currency={currency} onClose={onClose} />;
}

function ReturnForm({
  detail,
  currency,
  onClose,
}: {
  detail: SaleDetail;
  currency: string;
  onClose: () => void;
}) {
  const returnItems = useMutation(api.sales.returnItems);
  const refund = useMutation(api.payments.refund);

  // Pieces currently in the customer's hands are the only ones that can come
  // back — the server enforces the same bound. `withCustomer` is the derived
  // qtyDelivered − qtyReturned; the historical delivered count (invariant 5)
  // is never the bound.
  const returnable = detail.items.filter(({ withCustomer }) => withCustomer > 0);

  // Mounted fresh on each open — quantities start at 0 so nothing returns
  // unless the staff explicitly picks it.
  const [qtys, setQtys] = useState<Record<string, number>>(() =>
    Object.fromEntries(returnable.map(({ item }) => [item._id, 0]))
  );
  const [refundInput, setRefundInput] = useState("");
  const [saving, setSaving] = useState(false);
  const refundCents = inputToCents(refundInput) ?? 0;

  const picks = returnable
    .map((line) => ({ line, qty: qtys[line.item._id] ?? 0 }))
    .filter(({ qty }) => qty > 0);

  async function save() {
    if (picks.length === 0) return;
    setSaving(true);
    try {
      await returnItems({
        saleId: detail.sale._id,
        returns: picks.map(({ line, qty }) => ({
          saleItemId: line.item._id,
          qty,
        })),
      });
      if (refundCents > 0) {
        await refund({
          saleId: detail.sale._id,
          amount: refundCents,
          note: `Return — ${picks
            .map(({ line, qty }) => `${lineLabel(line)} ×${qty}`)
            .join(", ")}`.slice(0, 200),
        });
      }
      toast.success(t().sales.itemsReturned);
      onClose();
    } catch (err) {
      toastError(err);
    } finally {
      setSaving(false);
    }
  }

  if (returnable.length === 0) {
    return (
      <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t().sales.returnItemTitle}</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            {t().sales.nothingToReturn}
          </p>
          <DialogFooter className="gap-2">
            <Button type="button" onClick={onClose}>
              {t().common.close}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t().sales.returnItemTitle}</DialogTitle>
          <DialogDescription>{t().sales.returnItemHint}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2">
          {returnable.map((line) => {
            const { item, withCustomer } = line;
            const qty = qtys[item._id] ?? 0;
            const max = withCustomer;
            const picked = qty > 0;
            const label = lineLabel(line);
            return (
              <div
                key={item._id}
                className={cn(
                  "rounded-md border p-3",
                  picked && "border-primary bg-primary/5"
                )}
              >
                <p className="text-sm font-medium">{label}</p>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    className="size-11 shrink-0"
                    disabled={qty <= 0}
                    onClick={() =>
                      setQtys((q) => ({
                        ...q,
                        [item._id]: Math.max(0, qty - 1),
                      }))
                    }
                    aria-label={`- ${label}`}
                  >
                    −
                  </Button>
                  <span
                    className={cn(
                      "min-w-8 text-center text-lg tabular-nums",
                      picked && "font-semibold"
                    )}
                  >
                    {qty}
                  </span>
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    className="size-11 shrink-0"
                    disabled={qty >= max}
                    onClick={() =>
                      setQtys((q) => ({
                        ...q,
                        [item._id]: Math.min(max, qty + 1),
                      }))
                    }
                    aria-label={`+ ${label}`}
                  >
                    +
                  </Button>
                  <span className="text-xs text-muted-foreground">
                    {t().sales.returnQty} / {max}
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="ml-auto"
                    disabled={qty === max}
                    onClick={() =>
                      setQtys((q) => ({ ...q, [item._id]: max }))
                    }
                  >
                    {t().sales.returnAll}
                  </Button>
                </div>
              </div>
            );
          })}
          <div className="grid gap-1">
            <Label>{t().sales.refundAmount}</Label>
            <Input
              inputMode="decimal"
              value={refundInput}
              onChange={(e) => setRefundInput(e.target.value)}
              placeholder="0.00"
            />
            <p className="text-xs text-muted-foreground">
              {t().sales.returnRefundHint} · {currency}
            </p>
          </div>
        </div>
        <DialogFooter className="gap-2">
          <Button
            type="button"
            disabled={saving || picks.length === 0 || refundCents > detail.paid}
            onClick={() => void save()}
          >
            <HugeiconsIcon
              icon={PackageReceive01Icon}
              strokeWidth={2}
              className="size-4"
            />
            {t().sales.returnItem}
          </Button>
          <Button type="button" variant="destructive" onClick={onClose}>
            <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} className="size-4" />
            {t().common.cancel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
