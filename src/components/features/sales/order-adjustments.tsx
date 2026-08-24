"use client";

import { Cancel01Icon, PackageReceive01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation } from "convex/react";
import { useRef, useState } from "react";
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
import { useIdempotentSubmit } from "@/hooks/use-idempotent-submit";
import { cn, inputToCents, t, toastError } from "@/lib/utils";
import type { SaleDetail } from "./invoice-dialog";

// T13/T15 — order adjustment dialogs (AGENTS.md rule #4: flexible per line,
// never a silent edit). Every change below goes through a server mutation
// that writes ledger rows + a saleEvents entry in ONE transaction:
//   AdjustDeliveryDialog — per-line delivered qty ("adjust at the door");
//     fewer pieces → stock flows back, more pieces → re-deducted (oversell
//     is impossible, the server re-checks stock).
//   ReturnItemDialog    — pieces the customer brought back; stock flows
//     back via `return` rows and an optional refund (a negative payment
//     row) is recorded in the same flow.
// Adding, removing, swapping, or re-quantifying UNDELIVERED pieces now all
// happen on the Edit Sale page (the one adjustment workflow — AGENTS.md
// T12): sales.saveEdit applies the diff as ledger rows and appends
// saleEvents in ONE transaction.

type SaleItemDetail = SaleDetail["items"][number];

/** "Basic Tee — M · Black" — the same plain-language label the server uses. */
function lineLabel({ product, variant }: SaleItemDetail): string {
  return `${product.name} — ${variant.size}${variant.color ? ` · ${variant.color}` : ""}`;
}

/** Per-line delivered quantities — fewer pieces flow back to stock, more
 * pieces are re-deducted (oversell-checked server-side). Lines can be
 * adjusted together; only changed lines are sent. */
export function AdjustDeliveryDialog({
  saleId,
  items,
  onClose,
}: {
  saleId: Id<"sales">;
  items: SaleDetail["items"];
  onClose: () => void;
}) {
  const setLineDelivered = useMutation(api.sales.setLineDelivered);
  // Mounted fresh on each open — the initial state IS the current values.
  const [qtys, setQtys] = useState<Record<string, number>>(() =>
    Object.fromEntries(items.map(({ item }) => [item._id, item.qtyDelivered]))
  );
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);

  const changes = items.filter(
    ({ item }) => (qtys[item._id] ?? item.qtyDelivered) !== item.qtyDelivered
  );

  async function save() {
    if (savingRef.current || changes.length === 0) return;
    savingRef.current = true;
    setSaving(true);
    try {
      await setLineDelivered({
        saleId,
        adjustments: changes.map(({ item }) => ({
          saleItemId: item._id,
          qtyDelivered: qtys[item._id] ?? item.qtyDelivered,
        })),
      });
      toast.success(t().sales.linesAdjusted);
      onClose();
    } catch (err) {
      toastError(err);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t().sales.adjustDeliveredTitle}</DialogTitle>
          <DialogDescription>{t().sales.adjustDeliveredHint}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2">
          {items.map((line) => {
            const { item } = line;
            const qty = qtys[item._id] ?? item.qtyDelivered;
            // Delivered is historical — returned pieces were handed over once,
            // so the ceiling stays the full ordered qty (matches the server).
            const max = item.qtyOrdered;
            const changed = qty !== item.qtyDelivered;
            const label = lineLabel(line);
            return (
              <div
                key={item._id}
                className={cn(
                  "rounded-md border p-3",
                  changed && "border-primary bg-primary/5"
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
                      changed && "font-semibold"
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
                    {t().sales.deliveredQty} / {max}
                  </span>
                  <div className="ml-auto flex flex-wrap gap-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={qty === max}
                      onClick={() =>
                        setQtys((q) => ({ ...q, [item._id]: max }))
                      }
                    >
                      {t().sales.allDelivered}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={qty === 0}
                      onClick={() => setQtys((q) => ({ ...q, [item._id]: 0 }))}
                    >
                      {t().sales.noneDelivered}
                    </Button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
        <DialogFooter className="gap-2">
          <Button
            type="button"
            disabled={saving || changes.length === 0}
            onClick={() => void save()}
          >
            {t().common.save}
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

/** T15 — pieces the customer brought back. Stock flows back via a `return`
 * ledger row; an optional refund records the money given back (a negative
 * payment row) in the same flow. Only pieces CURRENTLY with the customer can
 * return — `qtyDelivered` is historical (invariant 5) and never the bound;
 * the server re-checks the same derived difference. */
export function ReturnItemDialog({
  saleId,
  currency,
  line,
  paidCents,
  onClose,
}: {
  saleId: Id<"sales">;
  currency: string;
  /** Line to return — null means the dialog is closed. */
  line: SaleItemDetail | null;
  /** What the customer has paid so far — the refund can't exceed it. */
  paidCents: number;
  onClose: () => void;
}) {
  const returnItems = useMutation(api.sales.returnItems);
  const refund = useMutation(api.payments.refund);
  const refundSubmit = useIdempotentSubmit({
    operation: "payments.refund",
    resource: saleId,
  });
  // Pieces currently in the customer's hands are the only ones that can come
  // back — the server enforces the same bound (withCustomer is the derived
  // qtyDelivered − qtyReturned, never the historical delivered count).
  const returnable = line ? line.withCustomer : 0;
  const [qty, setQty] = useState(1);
  const [refundInput, setRefundInput] = useState("");
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const refundCents = inputToCents(refundInput) ?? 0;

  async function save() {
    if (savingRef.current || !line || qty < 1) return;
    savingRef.current = true;
    setSaving(true);
    try {
      await returnItems({
        saleId,
        returns: [{ saleItemId: line.item._id, qty }],
      });
      if (refundCents > 0) {
        const refundPayload = {
          saleId,
          amount: refundCents,
          note: `Return — ${lineLabel(line)} ×${qty}`,
        };
        const idempotencyKey = refundSubmit.begin(refundPayload);
        await refund({ ...refundPayload, idempotencyKey });
        refundSubmit.complete(refundPayload, idempotencyKey);
      }
      toast.success(t().sales.itemsReturned);
      onClose();
    } catch (err) {
      toastError(err);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  // Defensive — the page only opens this for returnable lines.
  if (line === null || returnable <= 0) {
    return (
      <Dialog
        open={line !== null}
        onOpenChange={(open) => {
          if (!open) onClose();
        }}
      >
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
    <Dialog
      open={line !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t().sales.returnItemTitle}</DialogTitle>
          <DialogDescription>{t().sales.returnItemHint}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <p className="text-sm font-medium">{lineLabel(line)}</p>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="size-11 shrink-0"
              disabled={qty <= 1}
              onClick={() => setQty((q) => Math.max(1, q - 1))}
              aria-label="-"
            >
              −
            </Button>
            <span className="min-w-8 text-center text-lg tabular-nums">
              {qty}
            </span>
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="size-11 shrink-0"
              disabled={qty >= returnable}
              onClick={() => setQty((q) => Math.min(returnable, q + 1))}
              aria-label="+"
            >
              +
            </Button>
            <span className="text-xs text-muted-foreground">
              {t().sales.returnQty} / {returnable}
            </span>
          </div>
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
            disabled={saving || refundCents > paidCents}
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
