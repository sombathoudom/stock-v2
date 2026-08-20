"use client";

import {
  Cancel01Icon,
  Edit01Icon,
  EllipsisVerticalIcon,
  HistoryIcon,
  MoneyAdd01Icon,
  PackageReceive01Icon,
  PrinterIcon,
  Task01Icon,
  ViewIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { useRouter } from "next/navigation";
import { useState } from "react";

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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { useCurrentUser } from "@/hooks/use-current-user";
import { useShop } from "@/hooks/use-shop";
import { t } from "@/lib/utils";
import { CancelSaleReviewDialog } from "./cancel-sale-review-dialog";
import { InvoiceDialog } from "./invoice-dialog";
import { SalePaymentDialog } from "./sale-payment-dialog";
import { SalePaymentsDialog } from "./sale-payments-dialog";
import { SaleReturnDialog } from "./sale-return-dialog";
import { SaleStatusDialog } from "./sale-status-dialog";
import { CAN_CANCEL } from "./sale-status-flow";

// One shared row shape for the sales list (server-side computed total /
// paid / remaining ride along with the full `sale` doc).
export type SaleListRow = NonNullable<
  FunctionReturnType<typeof api.sales.list>
>["page"][number];

type Active =
  | null
  | "status"
  | "return"
  | "payments"
  | "payment"
  | "invoice";

export function SaleRowActions({ row }: { row: SaleListRow }) {
  const router = useRouter();
  const shop = useShop();

  const [active, setActive] = useState<Active>(null);
  const [cancelOpen, setCancelOpen] = useState(false);

  const sale = row.sale;
  const status = sale.status;
  const locked = status === "cancelled" || status === "draft";
  const canCancel = CAN_CANCEL.includes(status);
  const currency = shop?.currency ?? "USD";

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              size="icon"
              className="size-11 sm:size-8"
              aria-label={t().common.actions}
            />
          }
        >
          <HugeiconsIcon
            icon={EllipsisVerticalIcon}
            strokeWidth={2}
            className="size-5"
          />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" sideOffset={4} className="w-56">
          {!locked ? (
            <DropdownMenuItem
              className="min-h-11 sm:min-h-8"
              // Items, order fields and status are edited together on their
              // own page and saved as ONE transaction — too much for a modal.
              onClick={() => router.push(`/sales/${sale._id}/edit`)}
            >
              <HugeiconsIcon icon={Edit01Icon} strokeWidth={2} className="size-4" />
              {t().sales.editSale}
            </DropdownMenuItem>
          ) : null}
          {!locked ? (
            <DropdownMenuItem
              className="min-h-11 sm:min-h-8"
              onClick={() => setActive("status")}
            >
              <HugeiconsIcon icon={Task01Icon} strokeWidth={2} className="size-4" />
              {t().sales.updateStatus}
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem
            className="min-h-11 sm:min-h-8"
            onClick={() => router.push(`/sales/${sale._id}`)}
          >
            <HugeiconsIcon icon={ViewIcon} strokeWidth={2} className="size-4" />
            {t().sales.saleDetail}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {!locked ? (
            <DropdownMenuItem
              className="min-h-11 sm:min-h-8"
              onClick={() => setActive("return")}
            >
              <HugeiconsIcon
                icon={PackageReceive01Icon}
                strokeWidth={2}
                className="size-4"
              />
              {t().sales.saleReturn}
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem
            className="min-h-11 sm:min-h-8"
            onClick={() => setActive("payments")}
          >
            <HugeiconsIcon icon={HistoryIcon} strokeWidth={2} className="size-4" />
            {t().sales.showPayments}
          </DropdownMenuItem>
          {/* Follows the money, not the status: a cancelled order normally
              owes nothing, but one cancelled with the trip still billed owes
              the shipping fee and has to be collectable. */}
          {row.remaining > 0 ? (
            <DropdownMenuItem
              className="min-h-11 sm:min-h-8"
              onClick={() => setActive("payment")}
            >
              <HugeiconsIcon
                icon={MoneyAdd01Icon}
                strokeWidth={2}
                className="size-4"
              />
              {t().sales.createPayment}
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem
            className="min-h-11 sm:min-h-8"
            onClick={() => setActive("invoice")}
          >
            <HugeiconsIcon icon={PrinterIcon} strokeWidth={2} className="size-4" />
            {t().sales.invoice}
          </DropdownMenuItem>
          {canCancel ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                className="min-h-11 sm:min-h-8"
                onClick={() => setCancelOpen(true)}
              >
                <HugeiconsIcon
                  icon={Cancel01Icon}
                  strokeWidth={2}
                  className="size-4"
                />
                {t().sales.cancelSale}
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>

      {/* One dialog at a time — each mounts fresh on open so its state
          starts from the current server values. */}
      {active === "status" ? (
        <SaleStatusDialog
          saleId={sale._id}
          currentStatus={status}
          onClose={() => setActive(null)}
        />
      ) : null}
      {active === "return" ? (
        <SaleReturnDialog
          saleId={sale._id}
          currency={currency}
          onClose={() => setActive(null)}
        />
      ) : null}
      {active === "payments" ? (
        <SalePaymentsDialog
          saleId={sale._id}
          onClose={() => setActive(null)}
        />
      ) : null}
      {active === "payment" ? (
        <SalePaymentDialog
          saleId={sale._id}
          total={row.total}
          paid={row.paid}
          remaining={row.remaining}
          currency={currency}
          onClose={() => setActive(null)}
        />
      ) : null}
      {active === "invoice" ? (
        <InvoiceBranch saleId={sale._id} onClose={() => setActive(null)} />
      ) : null}

      {/* Guided cancellation — cancel is forever (rule 10: sales are never
          deletable). Every held piece needs a physical outcome first; the
          review dialog also handles refunds and the charged trip fee. */}
      {cancelOpen ? (
        <CancelSaleReviewDialog
          saleId={sale._id}
          currency={currency}
          onClose={() => setCancelOpen(false)}
        />
      ) : null}
    </>
  );
}

/** Fetches the full order detail for the invoice (the list row doesn't
 *  carry items), then hands it to the shared invoice dialog. */
function InvoiceBranch({
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
            <DialogTitle>{t().sales.invoice}</DialogTitle>
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

  return (
    <InvoiceDialog
      detail={detail}
      shopName={shop?.name ?? ""}
      shopAddress={shop?.address}
      currency={shop?.currency ?? "USD"}
      timezone={shop?.timezone ?? "Asia/Phnom_Penh"}
      printerConfig={shop?.printerConfig}
      onClose={onClose}
    />
  );
}
