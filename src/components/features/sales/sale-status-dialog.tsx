"use client";

import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation } from "convex/react";
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
import { SaleStatusBadge } from "@/components/features/sales/sale-status-badge";
import { t, toastError } from "@/lib/utils";
import {
  ALL_STATUSES,
  NEXT_STEPS,
  markLabel,
  type SaleStatus,
} from "./sale-status-flow";

// "Update status" from the sales list — lists EVERY delivery stage so the
// owner sees the whole journey and can jump straight to where the order really
// is; stages that can't follow the current one are shown greyed out (the same
// NEXT_STEPS map the order detail page uses, mirrored by the server's
// ALLOWED_TRANSITIONS). The server rejects anything not on the list.

export function SaleStatusDialog({
  saleId,
  currentStatus,
  onClose,
}: {
  saleId: Id<"sales">;
  currentStatus: SaleStatus;
  onClose: () => void;
}) {
  const setStatus = useMutation(api.sales.setStatus);
  const [changing, setChanging] = useState<SaleStatus | null>(null);

  const steps = NEXT_STEPS[currentStatus];

  async function doSetStatus(status: SaleStatus) {
    setChanging(status);
    try {
      await setStatus({ saleId, status });
      toast.success(t().sales.statusUpdated);
      onClose();
    } catch (err) {
      toastError(err);
    } finally {
      setChanging(null);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{t().sales.updateStatus}</DialogTitle>
          <DialogDescription className="flex items-center gap-2">
            {t().sales.currentStatus}
            <SaleStatusBadge status={currentStatus} />
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2">
          {steps.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {t().sales.noStatusSteps}
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">
              {t().sales.statusPickHint}
            </p>
          )}
          {ALL_STATUSES.map((status) => {
            const isCurrent = status === currentStatus;
            const canPick = steps.includes(status);
            return (
              <div key={status} className="flex flex-col gap-1">
                <Button
                  type="button"
                  variant={canPick ? "default" : "outline"}
                  className="min-h-11 w-full justify-between sm:min-h-9"
                  disabled={!canPick || changing !== null}
                  onClick={() => void doSetStatus(status)}
                >
                  <span>{markLabel(status)}</span>
                  {isCurrent ? (
                    <span className="text-xs font-normal">
                      {t().sales.statusNow}
                    </span>
                  ) : null}
                </Button>
                {status === "partially_delivered" ? (
                  // Plain-language answer to "what is partially delivered?"
                  // right where the owner has to choose it.
                  <p className="px-1 text-xs text-muted-foreground">
                    {t().sales.partiallyDeliveredHint}
                  </p>
                ) : null}
              </div>
            );
          })}
        </div>
        <DialogFooter className="gap-2">
          <Button type="button" variant="destructive" onClick={onClose}>
            <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} className="size-4" />
            {t().common.cancel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
