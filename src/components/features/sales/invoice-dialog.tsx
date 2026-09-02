"use client";

import { Cancel01Icon, PrinterIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { FunctionReturnType } from "convex/server";
import { useState } from "react";
import { toast } from "sonner";

import { api } from "@convex/_generated/api";
import type { Doc } from "@convex/_generated/dataModel";
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  printLabelDoc,
  printReceiptDoc,
  toastPrintError,
  type PrintSale,
} from "@/lib/printing";
import { formatDateTime, formatMoney, getLang, t } from "@/lib/utils";

// T10 step ⑦ / T25 — invoice preview + print, three ways:
//   • Receipt (thermal)  — 80mm ESC/POS to the shop's configured printer
//   • Package label      — 80mm ESC/POS label with customer + items + barcode
//   • A5 invoice         — the browser print dialog (any OS printer; the
//     @media print rules in globals.css pin the A5 page size and hide the
//     rest of the page).
// The same payload shape the checkout mutation returns and the T12 detail
// page reads (all money already re-derived server-side, integer cents).

/** Checkout/detail payload — one shared shape for T10 and T12. */
export type SaleDetail = NonNullable<
  FunctionReturnType<typeof api.sales.getDetail>
>;

/** The quantity a line actually bills: ordered − cancelled − returned. The
 * invoice shows only billed pieces — returned and cancelled ones are not on
 * the customer's bill (the server's detail.total already excludes them). */
function billedQty(item: SaleDetail["items"][number]["item"]): number {
  return item.qtyOrdered - item.qtyCancelled - item.qtyReturned;
}

export function InvoiceDialog({
  detail,
  shopName,
  shopAddress,
  shopPhone,
  currency,
  timezone,
  printerConfig,
  onClose,
}: {
  /** Null = dialog closed. */
  detail: SaleDetail | null;
  shopName: string;
  shopAddress?: string;
  /** Shop phone — printed as the invoice sender. */
  shopPhone?: string;
  currency: string;
  timezone: string;
  /** The shop's saved thermal printer setup (undefined = not configured). */
  printerConfig?: Doc<"shop">["printerConfig"];
  onClose: () => void;
}) {
  const [printing, setPrinting] = useState<"receipt" | "label" | null>(null);

  function handlePrintA5() {
    document.body.classList.add("printing-invoice");
    window.addEventListener(
      "afterprint",
      () => document.body.classList.remove("printing-invoice"),
      { once: true }
    );
    window.print();
  }

  const printDoc = detail
    ? toPrintSale(detail, { shopName, shopAddress, shopPhone, currency, timezone })
    : null;

  async function doThermal(kind: "receipt" | "label") {
    if (!printDoc) return;
    setPrinting(kind);
    try {
      if (kind === "receipt") await printReceiptDoc(printDoc, printerConfig);
      else await printLabelDoc(printDoc, printerConfig);
      toast.success(
        kind === "receipt" ? t().sales.receiptSent : t().sales.labelSent
      );
    } catch (err) {
      toastPrintError(err);
    } finally {
      setPrinting(null);
    }
  }

  // Subtotal is total + discount − deliveryFee (recomputed here for display;
  // every money value in the payload is already server-derived).
  const subtotal = detail
    ? detail.total + detail.sale.discount - detail.sale.deliveryFee
    : 0;

  return (
    <Dialog
      open={detail !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-md">
        {detail && (
          <div className="invoice-print-area flex flex-col gap-3">
            <DialogHeader className="hidden">
              <DialogTitle>{t().sales.invoice}</DialogTitle>
              <DialogDescription>{detail.sale.code}</DialogDescription>
            </DialogHeader>

            <div className="text-center">
              <p className="text-lg font-bold">{shopName}</p>
              {shopAddress ? (
                <p className="text-sm text-muted-foreground">{shopAddress}</p>
              ) : null}
            </div>

            <div className="flex items-center justify-between gap-2 text-sm">
              <span className="font-semibold">{detail.sale.code}</span>
              <span>{formatDateTime(detail.sale.createdAt, timezone, getLang())}</span>
            </div>

            {/* Customer + order info — plain "Label: value" lines, no box.
                Phone/address/delivery-by print only when present (self-pickup
                orders have no company). The sender is the shop. */}
            <div className="flex flex-col gap-0.5 text-sm">
              <p>
                <span className="text-muted-foreground">{t().sales.customer}:</span>{" "}
                <span className="font-medium">{detail.customer.name}</span>
              </p>
              {detail.customer.phone ? (
                <p>
                  <span className="text-muted-foreground">{t().common.phone}:</span>{" "}
                  <span className="tabular-nums">{detail.customer.phone}</span>
                </p>
              ) : null}
              {detail.customer.address ? (
                <p>
                  <span className="text-muted-foreground">{t().sales.location}:</span>{" "}
                  {detail.customer.address}
                </p>
              ) : null}
              {detail.company ? (
                <p>
                  <span className="text-muted-foreground">
                    {t().sales.deliveryBy}:
                  </span>{" "}
                  {detail.company.name}
                </p>
              ) : null}
              <p>
                <span className="text-muted-foreground">{t().sales.sender}:</span>{" "}
                {shopPhone ? shopPhone : shopName}
              </p>
            </div>

            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="py-1.5">{t().common.name}</TableHead>
                  <TableHead className="py-1.5 text-right">{t().sales.qty}</TableHead>
                  <TableHead className="py-1.5 text-right">{t().sales.price}</TableHead>
                  <TableHead className="py-1.5 text-right">{t().sales.total}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {detail.items
                  .map(({ item, variant, product }) => ({
                    item,
                    variant,
                    product,
                    billed: billedQty(item),
                  }))
                  .filter(({ billed }) => billed > 0)
                  .map(({ item, variant, product, billed }) => (
                    <TableRow key={item._id}>
                      <TableCell className="py-1.5">
                        {product.name}
                        <span className="block text-xs text-muted-foreground">
                          {variant.size}
                          {variant.color ? ` · ${variant.color}` : ""}
                        </span>
                      </TableCell>
                      <TableCell className="py-1.5 text-right tabular-nums">
                        {billed}
                      </TableCell>
                      <TableCell className="py-1.5 text-right tabular-nums">
                        {formatMoney(item.unitPrice, currency, getLang())}
                      </TableCell>
                      <TableCell className="py-1.5 text-right tabular-nums">
                        {formatMoney(
                          item.unitPrice * billed - (item.discount ?? 0),
                          currency,
                          getLang()
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
              </TableBody>
            </Table>

            <div className="flex flex-col gap-1 text-sm">
              <div className="flex justify-between">
                <span>{t().sales.subtotal}</span>
                <span className="tabular-nums">
                  {formatMoney(subtotal, currency, getLang())}
                </span>
              </div>
              {detail.sale.discount > 0 && (
                <div className="flex justify-between text-muted-foreground">
                  <span>{t().sales.discount}</span>
                  <span className="tabular-nums">
                    −{formatMoney(detail.sale.discount, currency, getLang())}
                  </span>
                </div>
              )}
              {detail.sale.deliveryFee > 0 && (
                <div className="flex justify-between text-muted-foreground">
                  <span>{t().sales.deliveryFee}</span>
                  <span className="tabular-nums">
                    {formatMoney(detail.sale.deliveryFee, currency, getLang())}
                  </span>
                </div>
              )}
              <div className="flex justify-between border-t pt-1 font-bold">
                <span>{t().sales.total}</span>
                <span className="tabular-nums">
                  {formatMoney(detail.total, currency, getLang())}
                </span>
              </div>
              <div className="flex justify-between">
                <span>{t().sales.paid}</span>
                <span className="tabular-nums">
                  {formatMoney(detail.paid, currency, getLang())}
                </span>
              </div>
              {detail.remaining > 0 && (
                <div className="flex justify-between font-semibold">
                  <span>{t().sales.remaining}</span>
                  <span className="tabular-nums">
                    {formatMoney(detail.remaining, currency, getLang())}
                  </span>
                </div>
              )}
            </div>

            <div className="mt-8 flex justify-end">
              <div className="w-40 border-t border-dashed pt-1 text-center text-xs text-muted-foreground">
                {t().sales.signature}
              </div>
            </div>

            <p className="text-center text-xs text-muted-foreground">
              {t().sales.thankyou}
            </p>
          </div>
        )}

        <DialogFooter className="sm:justify-end">
          {!printerConfig ? (
            <p className="w-full text-xs text-muted-foreground">
              {t().sales.printHint}
            </p>
          ) : null}
          <div className="flex w-full flex-col gap-2">
            {printerConfig ? (
              <>
                <Button
                  type="button"
                  variant="outline"
                  disabled={printing !== null}
                  onClick={() => void doThermal("receipt")}
                >
                  <HugeiconsIcon icon={PrinterIcon} strokeWidth={2} className="size-4" />
                  {t().sales.printReceipt}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  disabled={printing !== null}
                  onClick={() => void doThermal("label")}
                >
                  <HugeiconsIcon icon={PrinterIcon} strokeWidth={2} className="size-4" />
                  {t().sales.printLabel}
                </Button>
              </>
            ) : null}
            <Button type="button" onClick={handlePrintA5}>
              <HugeiconsIcon icon={PrinterIcon} strokeWidth={2} className="size-4" />
              {t().sales.printA5}
            </Button>
          </div>
          <Button type="button" variant="destructive" onClick={onClose}>
            <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} className="size-4" />
            {t().sales.close}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Flatten a SaleDetail into the print document shape (printing.ts). Exported
 * so the checkout auto-print (sales/new) reuses the exact same mapping. */
export function toPrintSale(
  detail: SaleDetail,
  ctx: {
    shopName: string;
    shopAddress?: string;
    shopPhone?: string;
    currency: string;
    timezone: string;
  }
): PrintSale {
  return {
    code: detail.sale.code,
    createdAt: detail.sale.createdAt,
    timezone: ctx.timezone,
    currency: ctx.currency,
    shopName: ctx.shopName,
    shopAddress: ctx.shopAddress,
    shopPhone: ctx.shopPhone,
    customerName: detail.customer.name,
    customerPhone: detail.customer.phone,
    customerAddress: detail.customer.address,
    channelName: detail.channel.name,
    companyName: detail.company?.name,
    subtotal: detail.total + detail.sale.discount - detail.sale.deliveryFee,
    discount: detail.sale.discount,
    deliveryFee: detail.sale.deliveryFee,
    total: detail.total,
    paid: detail.paid,
    remaining: detail.remaining,
    items: detail.items
      .map(({ item, variant, product }) => ({
        name: product.name,
        size: variant.size,
        color: variant.color,
        qty: billedQty(item),
        unitPrice: item.unitPrice,
        discount: item.discount,
      }))
      // The invoice bills only what the customer actually owes — returned and
      // cancelled pieces are not on the bill (detail.total already excludes them).
      .filter(({ qty }) => qty > 0),
  };
}
