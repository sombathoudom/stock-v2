"use client";

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
import { cn, centsToInput, inputToCents, t, toastError } from "@/lib/utils";

import type { SaleDetail } from "./invoice-dialog";
import type { ResolutionOutcome } from "./resolution-dialog";

// Guided cancellation ("Cancel order" from the Edit Sale page, the sales list
// and the order detail page). Cancelling drops pieces off the bill — so every
// piece the customer is holding needs a physical outcome first, resolved in
// the SAME setStatus call (one transaction). No held pieces → the plain
// confirm, exactly as before. "Still with customer" leaves the order
// cancellable only if no line still holds pieces — the confirm stays
// disabled until every held piece is resolved.

type SaleItemDetail = SaleDetail["items"][number];

/** "Basic Tee — M · Black" — the same plain-language label the server uses. */
function lineLabel({ product, variant }: SaleItemDetail): string {
  return `${product.name} — ${variant.size}${variant.color ? ` · ${variant.color}` : ""}`;
}

const OUTCOMES: {
  value: ResolutionOutcome;
  label: string;
  hint: string;
}[] = [
  {
    value: "returned_sellable",
    label: t().sales.outcomeReturnedSellable,
    hint: t().sales.outcomeReturnedSellableHint,
  },
  {
    value: "returned_damaged",
    label: t().sales.outcomeReturnedDamaged,
    hint: t().sales.outcomeReturnedDamagedHint,
  },
  {
    value: "still_with_customer",
    label: t().sales.outcomeStillWithCustomer,
    hint: t().sales.outcomeStillWithCustomerHint,
  },
  {
    value: "delivery_incorrect",
    label: t().sales.outcomeDeliveryIncorrect,
    hint: t().sales.outcomeDeliveryIncorrectHint,
  },
];

export function CancelSaleReviewDialog({
  saleId,
  currency,
  onClose,
  onCancelled,
}: {
  saleId: Id<"sales">;
  currency: string;
  onClose: () => void;
  /** Called after the order is actually cancelled (parent navigates away). */
  onCancelled?: () => void;
}) {
  const user = useCurrentUser();
  const detail = useQuery(
    api.sales.getDetail,
    user == null ? "skip" : { saleId }
  );

  const setStatus = useMutation(api.sales.setStatus);
  const [saving, setSaving] = useState(false);

  // One outcome per held line, defaulting to "returned sellable" (the common
  // case). The steppers live in the Edit-Sale dialog; here each line's whole
  // held quantity takes one outcome.
  const heldLines =
    detail?.items.filter(({ withCustomer }) => withCustomer > 0) ?? [];
  const [choices, setChoices] = useState<Record<string, ResolutionOutcome>>(() =>
    Object.fromEntries(
      heldLines.map(({ item }) => [item._id, "returned_sellable" as ResolutionOutcome])
    )
  );
  const [refundInput, setRefundInput] = useState("");
  const [reason, setReason] = useState("");
  const [keepShipping, setKeepShipping] = useState(false);

  const refundCents = inputToCents(refundInput) ?? 0;

  if (detail === undefined) {
    return (
      <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t().sales.cancelReviewTitle}</DialogTitle>
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

  const sale = detail.sale;
  const paid = detail.paid;
  const anyHeld = heldLines.length > 0;
  // A line still marked "with customer" keeps pieces on the bill — the order
  // can't be cancelled until every held piece has a physical outcome.
  const unresolved = heldLines.some(
    ({ item }) => (choices[item._id] ?? "returned_sellable") === "still_with_customer"
  );
  const refundTooBig = refundCents > paid;
  const canConfirm = !saving && !unresolved && !refundTooBig;

  async function cancel() {
    if (!canConfirm) return;
    setSaving(true);
    try {
      const resolutions = heldLines.map(({ item }) => ({
        saleItemId: item._id,
        outcome: choices[item._id] ?? "returned_sellable",
        qty: item.qtyDelivered - item.qtyReturned,
        ...(choices[item._id] === "delivery_incorrect" && reason.trim()
          ? { reason: reason.trim() }
          : {}),
      }));
      await setStatus({
        saleId: sale._id,
        status: "cancelled",
        ...(resolutions.length > 0 ? { resolutions } : {}),
        ...(refundCents > 0 ? { refund: { amount: refundCents } } : {}),
        ...(reason.trim() ? { reason: reason.trim() } : {}),
        ...(sale.deliveryFee > 0 && keepShipping ? { chargeDeliveryFee: true } : {}),
      });
      toast.success(t().sales.cancelled);
      onClose();
      onCancelled?.();
    } catch (err) {
      toastError(err);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t().sales.cancelReviewTitle}</DialogTitle>
          <DialogDescription>
            {anyHeld ? t().sales.cancelReviewHint : t().sales.cancelConfirmBody}
          </DialogDescription>
        </DialogHeader>

        {anyHeld ? (
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() =>
                  setChoices(
                    Object.fromEntries(
                      heldLines.map(({ item }) => [item._id, "returned_sellable"])
                    )
                  )
                }
              >
                {t().sales.cancelReviewResolveAll}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() =>
                  setChoices(
                    Object.fromEntries(
                      heldLines.map(({ item }) => [item._id, "returned_damaged"])
                    )
                  )
                }
              >
                {t().sales.cancelReviewResolveAllDamaged}
              </Button>
            </div>

            {heldLines.map((line) => {
              const { item, withCustomer } = line;
              const chosen = choices[item._id] ?? "returned_sellable";
              const label = lineLabel(line);
              return (
                <div key={item._id} className="rounded-md border p-3">
                  <p className="text-sm font-medium">
                    {label}{" "}
                    <span className="text-muted-foreground">×{withCustomer}</span>
                  </p>
                  <div className="mt-2 flex flex-col gap-1.5">
                    {OUTCOMES.map((option) => {
                      const active = chosen === option.value;
                      return (
                        <button
                          key={option.value}
                          type="button"
                          onClick={() =>
                            setChoices((c) => ({ ...c, [item._id]: option.value }))
                          }
                          className={cn(
                            "flex items-center gap-2 rounded-md border px-3 py-2 text-left text-sm",
                            active && "border-primary bg-primary/5"
                          )}
                        >
                          <span
                            className={cn(
                              "flex size-4 shrink-0 items-center justify-center rounded-full border",
                              active && "border-primary"
                            )}
                            aria-hidden
                          >
                            {active ? (
                              <span className="size-2 rounded-full bg-primary" />
                            ) : null}
                          </span>
                          <span className="flex flex-col">
                            {option.label}
                            <span className="text-xs text-muted-foreground">
                              {option.hint}
                            </span>
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })}

            {unresolved ? (
              <p className="text-xs text-destructive">
                {t().sales.cancelReviewStillHeld.replace(
                  "{qty}",
                  String(
                    heldLines
                      .filter(
                        ({ item }) =>
                          (choices[item._id] ?? "returned_sellable") ===
                          "still_with_customer"
                      )
                      .reduce((sum, { withCustomer }) => sum + withCustomer, 0)
                  )
                )}
              </p>
            ) : null}
          </div>
        ) : null}

        <div className="grid gap-4">
          <div className="grid gap-1.5">
            <Label htmlFor="cancel-review-refund">{t().sales.refundAmount}</Label>
            <Input
              id="cancel-review-refund"
              value={refundInput}
              onChange={(e) => setRefundInput(e.target.value)}
              inputMode="decimal"
              placeholder="0.00"
              className="h-11 text-right tabular-nums"
              aria-invalid={refundTooBig}
            />
            <p className="text-xs text-muted-foreground">{t().sales.returnRefundHint}</p>
            {refundTooBig ? (
              <p className="text-xs text-destructive">
                {t().sales.refundAmount} ≤ {centsToInput(paid)} {currency}
              </p>
            ) : null}
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="cancel-review-reason">{t().sales.cancelReviewReason}</Label>
            <Input
              id="cancel-review-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={t().sales.cancelReviewReasonPlaceholder}
              className="h-11"
            />
          </div>

          {sale.deliveryFee > 0 ? (
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                checked={keepShipping}
                onChange={(e) => setKeepShipping(e.target.checked)}
                className="mt-0.5"
              />
              <span>
                {t().sales.keepShippingFee}
                <span className="block text-xs text-muted-foreground">
                  {t().sales.keepShippingFeeHint}
                </span>
              </span>
            </label>
          ) : null}
        </div>

        <DialogFooter className="gap-2">
          <Button type="button" variant="secondary" onClick={onClose} disabled={saving}>
            {t().common.cancel}
          </Button>
          <Button
            type="button"
            variant="destructive"
            onClick={() => void cancel()}
            disabled={!canConfirm}
          >
            {t().sales.cancelOrder}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
