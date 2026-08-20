"use client";

import { useState } from "react";

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
import { cn, centsToInput, formatMoney, inputToCents, t } from "@/lib/utils";

import type { EditLine } from "./sale-edit-items-table";

// The physical-outcome picker inside Edit Sale. When staff remove or reduce
// a line whose pieces are with the customer, THIS dialog asks what actually
// happened — the answer is a "resolution" that the page's ONE save call
// applies atomically with the rest of the edit (the server re-derives and
// re-validates everything; these intents are just the facts on the ground).

export type ResolutionOutcome =
  | "returned_sellable"
  | "returned_damaged"
  | "still_with_customer"
  | "delivery_incorrect";

export type PendingResolution = {
  /** Local id for React list identity — never sent to the server. */
  key: string;
  saleItemId: string;
  outcome: ResolutionOutcome;
  qty: number;
  reason?: string;
};

const OUTCOMES: {
  value: ResolutionOutcome;
  label: string;
  hint: string;
  ownerOnly?: boolean;
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
    ownerOnly: true,
  },
];

export function ResolutionDialog({
  line,
  held,
  resolvedQty,
  refundCents,
  onRefundChange,
  paidCents,
  currency,
  userIsOwner,
  onConfirm,
  onClose,
}: {
  line: EditLine;
  /** Pieces the customer currently holds (delivered − returned). */
  held: number;
  /** Pieces of this line already covered by earlier pending resolutions. */
  resolvedQty: number;
  refundCents: number;
  onRefundChange: (cents: number) => void;
  paidCents: number;
  currency: string;
  userIsOwner: boolean;
  onConfirm: (resolution: PendingResolution) => void;
  onClose: () => void;
}) {
  const labels = t().sales;
  const remaining = held - resolvedQty;
  // Start on the quantity the staff asked to drop — the amount still to be
  // resolved on this line.
  const [outcome, setOutcome] = useState<ResolutionOutcome>("returned_sellable");
  const [qty, setQty] = useState(Math.max(1, remaining));
  const [reason, setReason] = useState("");
  const [refundInput, setRefundInput] = useState(centsToInput(refundCents));
  const enteredRefund = inputToCents(refundInput) ?? 0;

  const lineLabel = `${line.productName} — ${line.variantLabel}`;
  const refundTooBig = enteredRefund > paidCents;
  const reasonMissing = outcome === "delivery_incorrect" && reason.trim() === "";
  const canConfirm = qty >= 1 && qty <= remaining && !reasonMissing && !refundTooBig;

  function confirm() {
    if (!canConfirm) return;
    onRefundChange(enteredRefund);
    onConfirm({
      key: `res-${crypto.randomUUID()}`,
      saleItemId: line.saleItemId ?? line.key,
      outcome,
      qty,
      ...(reason.trim() ? { reason: reason.trim() } : {}),
    });
    onClose();
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{labels.resolutionTitle}</DialogTitle>
          <DialogDescription>
            {labels.resolutionHint.replace("{qty}", String(held))}
          </DialogDescription>
        </DialogHeader>

        <p className="text-sm font-medium">{lineLabel}</p>

        {/* Outcome picker — selectable rows, same pattern as the status
            dialog (the app has no radio primitive). */}
        <div className="flex flex-col gap-2">
          {OUTCOMES.map((option) => {
            const disabled = option.ownerOnly && !userIsOwner;
            const active = outcome === option.value;
            return (
              <button
                key={option.value}
                type="button"
                disabled={disabled}
                onClick={() => setOutcome(option.value)}
                className={cn(
                  "rounded-md border p-3 text-left transition-colors",
                  active && "border-primary bg-primary/5",
                  disabled && "cursor-not-allowed opacity-50"
                )}
              >
                <span className="flex items-center gap-2 text-sm font-medium">
                  <span
                    className={cn(
                      "flex size-4 shrink-0 items-center justify-center rounded-full border",
                      active && "border-primary"
                    )}
                    aria-hidden
                  >
                    {active ? <span className="size-2 rounded-full bg-primary" /> : null}
                  </span>
                  {option.label}
                </span>
                <span className="mt-1 block pl-6 text-xs text-muted-foreground">
                  {option.hint}
                </span>
              </button>
            );
          })}
        </div>

        {/* Quantity + reason + refund. */}
        <div className="grid gap-4">
          <div className="grid gap-1.5">
            <Label>{labels.resolutionQty}</Label>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="icon"
                className="size-11 shrink-0"
                disabled={qty <= 1}
                onClick={() => setQty((q) => Math.max(1, q - 1))}
                aria-label={`- ${lineLabel}`}
              >
                −
              </Button>
              <span className="min-w-10 text-center text-lg tabular-nums">{qty}</span>
              <Button
                type="button"
                variant="outline"
                size="icon"
                className="size-11 shrink-0"
                disabled={qty >= remaining}
                onClick={() => setQty((q) => Math.min(remaining, q + 1))}
                aria-label={`+ ${lineLabel}`}
              >
                +
              </Button>
              <span className="text-xs text-muted-foreground">
                {t().sales.itemQtys.withCustomer}: {remaining}
              </span>
            </div>
          </div>

          {outcome === "delivery_incorrect" ? (
            <div className="grid gap-1.5">
              <Label htmlFor="resolution-reason">{labels.resolutionReason}</Label>
              <Input
                id="resolution-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder={labels.resolutionReasonPlaceholder}
                aria-invalid={reasonMissing}
                className="h-11"
              />
              {reasonMissing ? (
                <p className="text-xs text-destructive">
                  {labels.resolutionReasonRequired}
                </p>
              ) : null}
            </div>
          ) : null}

          <div className="grid gap-1.5">
            <Label htmlFor="resolution-refund">{labels.resolutionRefund}</Label>
            <Input
              id="resolution-refund"
              value={refundInput}
              onChange={(e) => setRefundInput(e.target.value)}
              inputMode="decimal"
              placeholder="0.00"
              className="h-11 text-right tabular-nums"
              aria-invalid={refundTooBig}
            />
            <p className="text-xs text-muted-foreground">{labels.resolutionRefundHint}</p>
            {refundTooBig ? (
              <p className="text-xs text-destructive">
                {formatMoney(paidCents, currency)} {t().sales.refund}
              </p>
            ) : null}
          </div>
        </div>

        <DialogFooter className="gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            {labels.resolutionCancel}
          </Button>
          <Button type="button" onClick={confirm} disabled={!canConfirm}>
            {labels.resolutionConfirm}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
