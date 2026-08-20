"use client";

import {
  CashbackIcon,
  Edit01Icon,
  HistoryIcon,
  MoneyAdd01Icon,
  PackageReceive01Icon,
  PrinterIcon,
  ShoppingBag01Icon,
  SlidersHorizontalIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation, useQuery } from "convex/react";
import { useRouter } from "next/navigation";
import { use, useState } from "react";
import { toast } from "sonner";

import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import {
  InvoiceDialog,
  type SaleDetail,
} from "@/components/features/sales/invoice-dialog";
import {
  AdjustDeliveryDialog,
  ReturnItemDialog,
} from "@/components/features/sales/order-adjustments";
import { SaleStatusBadge } from "@/components/features/sales/sale-status-badge";
import {
  CAN_CANCEL,
  NEXT_STEPS,
  markLabel,
  type SaleStatus,
} from "@/components/features/sales/sale-status-flow";
import { PageToolbar } from "@/components/features/shell/page-toolbar";
import { QueryErrorBoundary } from "@/components/features/shell/query-error-boundary";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useCurrentUser } from "@/hooks/use-current-user";
import {
  formatDateTime,
  formatMoney,
  getLang,
  inputToCents,
  isConvexId,
  t,
  toastError,
} from "@/lib/utils";

// T12 order detail + T11 payments (AGENTS.md). One screen for everything
// about an order: who/what/where (customer, channel, company, staff), the
// line items, its computed profit and paid/unpaid state, receive-payment +
// refund (money in/out in the one payments table), status transitions with
// a cancel that flows stock back, the full event history, and invoice
// re-printing. The URL carries only the Convex UUID — never an enumerable
// id (data privacy).

// SaleStatus, NEXT_STEPS, CAN_CANCEL and markLabel live in the shared
// sale-status-flow module (also used by the sales-list "Update status").

/** Event amounts arrive as strings (saleEvents payload is string-valued):
 * current events store integer cents ("1400"), older payment_received events
 * stored a display string ("$14.00"). Parse either back into cents. */
function eventAmountCents(amount: string): number {
  if (amount.includes("$")) {
    const dollars = Number(amount.replace(/[^0-9.-]/g, ""));
    return Number.isFinite(dollars) ? Math.round(dollars * 100) : 0;
  }
  const cents = Number(amount);
  return Number.isFinite(cents) ? cents : 0;
}

/** Friendly label for an event type — wording lives in the labels module. */
function eventLabel(type: string): string {
  switch (type) {
    case "created":
      return t().sales.events.created;
    case "status_changed":
      return t().sales.events.statusChanged;
    case "payment_received":
      return t().sales.events.paymentReceived;
    case "refund":
      return t().sales.events.refundGiven;
    case "lines_adjusted":
      return t().sales.events.linesAdjusted;
    case "item_swapped":
      return t().sales.events.itemSwapped;
    case "item_added":
      return t().sales.events.itemAdded;
    case "item_removed":
      return t().sales.events.itemRemoved;
    case "item_qty_changed":
      return t().sales.events.itemQtyChanged;
    case "items_returned":
      return t().sales.events.itemsReturned;
    case "delivery_outcome":
      return t().sales.events.deliveryOutcome;
    case "delivery_cost_changed":
      return t().sales.events.deliveryCostChanged;
    case "sale_edited":
      return t().sales.events.saleEdited;
    default:
      return type;
  }
}

/** Plain-language name for a field changed via "Edit sale" — the payload
 *  stores technical keys; the owner never sees them. */
function saleEditedFieldLabel(field: string | undefined): string {
  if (!field) return "";
  const map = t().sales.events.saleEditedFields as Record<string, string>;
  return map[field] ?? field;
}

/** Per-line plain-language state. `qtyDelivered` is HISTORICAL (invariant 5 —
 * returning never erases it), so "Delivered 1 / Returned 1" shows here as
 * "Returned", never "with customer 0 pieces". The held count is the derived
 * difference (invariant 6) and never a stored field. */
function lineStateText(
  item: {
    qtyOrdered: number;
    qtyCancelled: number;
    qtyReturned: number;
  },
  withCustomer: number,
  itemQtys: {
    cancelled: string;
    returned: string;
    withCustomer: string;
    notDeliveredYet: string;
  }
): string {
  const billed = item.qtyOrdered - item.qtyCancelled - item.qtyReturned;
  if (billed <= 0) {
    return item.qtyReturned > 0 ? itemQtys.returned : itemQtys.cancelled;
  }
  return withCustomer > 0 ? itemQtys.withCustomer : itemQtys.notDeliveredYet;
}

export default function SaleDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);

  return (
    <div className="flex w-full flex-col">
      {/* key={id} remounts a fresh boundary when navigating between orders */}
      <QueryErrorBoundary
        key={id}
        fallbackTitle={t().sales.notFoundTitle}
        fallbackBody={t().sales.notFoundBody}
      >
        <SaleLoader id={id} />
      </QueryErrorBoundary>
    </div>
  );
}

function SaleLoader({ id }: { id: string }) {
  const user = useCurrentUser();
  const validId = isConvexId(id);
  const detail = useQuery(
    api.sales.getDetail,
    user == null || !validId ? "skip" : { saleId: id as Id<"sales"> }
  );

  if (!validId || detail === null) {
    return (
      <Card className="m-4">
        <CardHeader>
          <CardTitle>{t().sales.notFoundTitle}</CardTitle>
          <CardDescription>{t().sales.notFoundBody}</CardDescription>
        </CardHeader>
      </Card>
    );
  }
  if (detail === undefined) {
    return (
      <div className="p-4">
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  return <SaleDetailView detail={detail} />;
}

function SaleDetailView({ detail }: { detail: SaleDetail }) {
  const router = useRouter();
  const user = useCurrentUser();
  const shop = useQuery(api.shop.get, user == null ? "skip" : {});

  const currency = shop?.currency ?? "USD";
  const timezone = shop?.timezone ?? "Asia/Phnom_Penh";

  const setStatus = useMutation(api.sales.setStatus);
  const receive = useMutation(api.payments.receive);
  const refund = useMutation(api.payments.refund);

  // --- Receive payment form ---
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState<"cash" | "bank_transfer" | "other">("cash");
  const [note, setNote] = useState("");
  const [receiving, setReceiving] = useState(false);
  const amountCents = inputToCents(amount) ?? 0;

  // --- Refund form ---
  const [refundAmount, setRefundAmount] = useState("");
  const [refundNote, setRefundNote] = useState("");
  const [refunding, setRefunding] = useState(false);
  const refundCents = inputToCents(refundAmount) ?? 0;

  const [changing, setChanging] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  // Cancel with the trip still billed — the package went out and came back.
  const [keepShipping, setKeepShipping] = useState(false);
  const [invoiceOpen, setInvoiceOpen] = useState(false);

  // T13/T15 — order adjustments (hidden on drafts and cancelled orders,
  // mirroring the server lock). Adding / removing / swapping undelivered
  // pieces happens on the Edit Sale page (the one adjustment workflow).
  const [adjustOpen, setAdjustOpen] = useState(false);
  const [returnLine, setReturnLine] = useState<
    SaleDetail["items"][number] | null
  >(null);
  const adjustable =
    detail.sale.status !== "draft" && detail.sale.status !== "cancelled";

  async function doSetStatus(status: SaleStatus) {
    setChanging(true);
    try {
      await setStatus({
        saleId: detail.sale._id,
        status,
        // Only a cancel can bill the trip; the server ignores it otherwise.
        ...(status === "cancelled" && keepShipping
          ? { chargeDeliveryFee: true }
          : {}),
      });
      toast.success(t().sales.statusUpdated);
      setCancelOpen(false);
      setKeepShipping(false);
    } catch (err) {
      toastError(err);
    } finally {
      setChanging(false);
    }
  }

  async function doReceive() {
    if (amountCents <= 0 || amountCents > detail.remaining) return;
    setReceiving(true);
    try {
      await receive({
        saleId: detail.sale._id,
        amount: amountCents,
        method,
        note: note.trim() || undefined,
      });
      toast.success(t().sales.paymentAdded);
      setAmount("");
      setNote("");
    } catch (err) {
      toastError(err);
    } finally {
      setReceiving(false);
    }
  }

  async function doRefund() {
    if (refundCents <= 0 || refundCents > detail.paid) return;
    setRefunding(true);
    try {
      await refund({
        saleId: detail.sale._id,
        amount: refundCents,
        note: refundNote.trim() || undefined,
      });
      toast.success(t().sales.refundAdded);
      setRefundAmount("");
      setRefundNote("");
    } catch (err) {
      toastError(err);
    } finally {
      setRefunding(false);
    }
  }

  const payments = [...detail.payments].sort((a, b) => b.receivedAt - a.receivedAt);
  const subtotal =
    detail.total + detail.sale.discount - detail.sale.deliveryFee;

  return (
    <div className="flex flex-col">
      <PageToolbar icon={ShoppingBag01Icon} title={detail.sale.code}>
        <SaleStatusBadge status={detail.sale.status} />
        {/* A cancelled or draft order has nothing editable — the server
            refuses the save either way. */}
        {detail.sale.status !== "cancelled" && detail.sale.status !== "draft" ? (
          <Button
            type="button"
            variant="outline"
            onClick={() => router.push(`/sales/${detail.sale._id}/edit`)}
          >
            <HugeiconsIcon icon={Edit01Icon} strokeWidth={2} className="size-4" />
            {t().sales.editSale}
          </Button>
        ) : null}
        <Button
          type="button"
          variant="outline"
          onClick={() => setInvoiceOpen(true)}
        >
          <HugeiconsIcon icon={PrinterIcon} strokeWidth={2} className="size-4" />
          {t().sales.invoice}
        </Button>
      </PageToolbar>

      <div className="grid gap-4 p-4 lg:grid-cols-[1fr_340px]">
        {/* Left column: items, payments, history */}
        <div className="flex min-w-0 flex-col gap-4">
          {/* Line items */}
          <Card>
            <CardHeader>
              <CardTitle>{t().sales.order}</CardTitle>
            </CardHeader>
            <CardContent className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t().common.name}</TableHead>
                    <TableHead className="text-right">{t().sales.itemQtys.ordered}</TableHead>
                    <TableHead className="text-right">{t().sales.itemQtys.delivered}</TableHead>
                    <TableHead className="text-right">{t().sales.itemQtys.cancelled}</TableHead>
                    <TableHead className="text-right">{t().sales.itemQtys.returned}</TableHead>
                    <TableHead className="text-right">{t().sales.itemQtys.withCustomer}</TableHead>
                    <TableHead className="text-right">{t().sales.price}</TableHead>
                    <TableHead className="text-right">{t().sales.total}</TableHead>
                    {adjustable ? (
                      <TableHead className="text-right">
                        {t().common.actions}
                      </TableHead>
                    ) : null}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {detail.items.map(({ item, variant, product, withCustomer }) => (
                    <TableRow key={item._id}>
                      <TableCell>
                        {product.name}
                        <span className="block text-xs text-muted-foreground">
                          {variant.size}
                          {variant.color ? ` · ${variant.color}` : ""}
                        </span>
                        <span className="block text-xs text-muted-foreground">
                          {lineStateText(item, withCustomer, t().sales.itemQtys)}
                        </span>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{item.qtyOrdered}</TableCell>
                      <TableCell className="text-right tabular-nums">{item.qtyDelivered}</TableCell>
                      <TableCell className="text-right tabular-nums">{item.qtyCancelled}</TableCell>
                      <TableCell className="text-right tabular-nums">{item.qtyReturned}</TableCell>
                      <TableCell className="text-right tabular-nums">{withCustomer}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatMoney(item.unitPrice, currency, getLang())}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatMoney(
                          item.unitPrice *
                            (item.qtyOrdered -
                              item.qtyCancelled -
                              item.qtyReturned) -
                            (item.discount ?? 0),
                          currency,
                          getLang()
                        )}
                      </TableCell>
                      {adjustable ? (
                        <TableCell className="text-right">
                          <div className="flex justify-end gap-1">
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              className="size-11"
                              onClick={() => setAdjustOpen(true)}
                              aria-label={`${t().sales.adjust} — ${product.name}`}
                            >
                              <HugeiconsIcon
                                icon={SlidersHorizontalIcon}
                                strokeWidth={2}
                                className="size-4"
                              />
                            </Button>
                            {withCustomer > 0 ? (
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                className="size-11"
                                onClick={() =>
                                  setReturnLine({ item, variant, product, withCustomer })
                                }
                                aria-label={`${t().sales.returnItem} — ${product.name}`}
                              >
                                <HugeiconsIcon
                                  icon={PackageReceive01Icon}
                                  strokeWidth={2}
                                  className="size-4"
                                />
                              </Button>
                            ) : null}
                          </div>
                        </TableCell>
                      ) : null}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          {/* Payments: receive + refund + history */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <HugeiconsIcon icon={MoneyAdd01Icon} strokeWidth={2} className="size-4" />
                {t().sales.paymentHistory}
              </CardTitle>
              {detail.remaining > 0 ? (
                <CardDescription>
                  {t().sales.remaining}:{" "}
                  <span className="font-medium tabular-nums">
                    {formatMoney(detail.remaining, currency, getLang())}
                  </span>
                </CardDescription>
              ) : (
                <CardDescription>{t().sales.paid}</CardDescription>
              )}
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              {/* Receive */}
              <div className="grid gap-2 rounded-md border p-3 sm:grid-cols-[1fr_140px_1fr_auto] sm:items-end">
                <div className="grid gap-1">
                  <Label>{t().sales.amountReceived}</Label>
                  <Input
                    inputMode="decimal"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    placeholder="0.00"
                  />
                </div>
                <div className="grid gap-1">
                  <Label>{t().sales.method}</Label>
                  <Select
                    value={method}
                    // Base UI shows the RAW value in the trigger without this map.
                    items={{
                      cash: t().sales.methods.cash,
                      bank_transfer: t().sales.methods.bank_transfer,
                      other: t().sales.methods.other,
                    }}
                    onValueChange={(v) =>
                      setMethod(v as "cash" | "bank_transfer" | "other")
                    }
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="cash">{t().sales.methods.cash}</SelectItem>
                      <SelectItem value="bank_transfer">
                        {t().sales.methods.bank_transfer}
                      </SelectItem>
                      <SelectItem value="other">{t().sales.methods.other}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid gap-1">
                  <Label>{t().common.note}</Label>
                  <Input
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    maxLength={200}
                  />
                </div>
                <Button
                  type="button"
                  disabled={
                    receiving || amountCents <= 0 || amountCents > detail.remaining
                  }
                  onClick={() => void doReceive()}
                >
                  {t().sales.receivePayment}
                </Button>
              </div>

              {/* Refund */}
              <div className="grid gap-2 rounded-md border p-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
                <div className="grid gap-1">
                  <Label>{t().sales.refund}</Label>
                  <Input
                    inputMode="decimal"
                    value={refundAmount}
                    onChange={(e) => setRefundAmount(e.target.value)}
                    placeholder="0.00"
                  />
                </div>
                <div className="grid gap-1">
                  <Label>{t().common.note}</Label>
                  <Input
                    value={refundNote}
                    onChange={(e) => setRefundNote(e.target.value)}
                    maxLength={200}
                  />
                </div>
                <Button
                  type="button"
                  variant="outline"
                  disabled={
                    refunding || refundCents <= 0 || refundCents > detail.paid
                  }
                  onClick={() => void doRefund()}
                >
                  <HugeiconsIcon icon={CashbackIcon} strokeWidth={2} className="size-4" />
                  {t().sales.refund}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                {t().sales.refundHint}
              </p>

              {/* History */}
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
                      <Badge variant="secondary">{t().sales.methods[p.method]}</Badge>
                      <span className="ml-auto tabular-nums">
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
            </CardContent>
          </Card>

          {/* Event history (audit trail, rule #8) */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <HugeiconsIcon icon={HistoryIcon} strokeWidth={2} className="size-4" />
                {t().sales.orderHistory}
              </CardTitle>
            </CardHeader>
            <CardContent>
              {detail.events.length === 0 ? (
                <p className="py-2 text-center text-sm text-muted-foreground">
                  {t().sales.emptyHistory}
                </p>
              ) : (
                <ul className="flex flex-col divide-y">
                  {detail.events.map(({ event, userName }) => (
                    <li key={event._id} className="flex flex-col gap-0.5 py-2">
                      <div className="flex flex-wrap items-center gap-2 text-sm">
                        <span className="font-medium">
                          {eventLabel(event.type)}
                        </span>
                        {event.payload?.from !== undefined &&
                        event.payload.to !== undefined ? (
                          <Badge variant="outline">
                            {event.type === "status_changed"
                              ? `${t().status[event.payload.from as SaleStatus]} → ${t().status[event.payload.to as SaleStatus]}`
                              : event.type === "sale_edited"
                                ? `${saleEditedFieldLabel(event.payload.field)}: ${event.payload.from || "—"} → ${event.payload.to || "—"}`
                                : `${event.payload.from} → ${event.payload.to}`}
                          </Badge>
                        ) : null}
                        {event.payload?.item ? (
                          <span className="text-muted-foreground">
                            {event.payload.item}
                            {event.payload.qty ? ` ×${event.payload.qty}` : ""}
                          </span>
                        ) : null}
                        {event.payload?.amount ? (
                          <span className="tabular-nums">
                            {formatMoney(eventAmountCents(event.payload.amount), currency, getLang())}
                          </span>
                        ) : null}
                      </div>
                      <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
                        <span>
                          {formatDateTime(event.ts, timezone, getLang())}
                        </span>
                        <span>
                          {t().sales.by} {userName}
                        </span>
                        {event.payload?.note ? <span>· {event.payload.note}</span> : null}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Right column: info, money, actions */}
        <div className="flex min-w-0 flex-col gap-4">
          <Card>
            <CardHeader>
              <CardTitle>{t().common.name}</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-2 text-sm">
              <InfoRow label={t().sales.date} value={formatDateTime(detail.sale.createdAt, timezone, getLang())} />
              <InfoRow
                label={t().sales.customer}
                value={`${detail.customer.name}${detail.customer.phone ? ` · ${detail.customer.phone}` : ""}`}
              />
              <InfoRow label={t().sales.channel} value={detail.channel.name} />
              <InfoRow label={t().sales.createdBy} value={detail.createdByName} />
              {detail.company !== undefined ? (
                <InfoRow label={t().sales.company} value={detail.company.name} />
              ) : null}
            </CardContent>
          </Card>

          {/* Computed money — every value re-derived server-side */}
          <Card>
            <CardHeader>
              <CardTitle>{t().sales.total}</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-1 text-sm">
              <MoneyRow label={t().sales.subtotal} value={formatMoney(subtotal, currency, getLang())} />
              {detail.sale.discount > 0 ? (
                <MoneyRow
                  label={t().sales.discount}
                  value={`−${formatMoney(detail.sale.discount, currency, getLang())}`}
                  muted
                />
              ) : null}
              {detail.sale.deliveryFee > 0 ? (
                <MoneyRow
                  label={t().sales.deliveryFee}
                  value={formatMoney(detail.sale.deliveryFee, currency, getLang())}
                  muted
                />
              ) : null}
              {detail.sale.deliveryCost > 0 ? (
                <MoneyRow
                  label={t().sales.companyCost}
                  value={`−${formatMoney(detail.sale.deliveryCost, currency, getLang())}`}
                  muted
                />
              ) : null}
              <MoneyRow label={t().sales.total} value={formatMoney(detail.total, currency, getLang())} bold />
              <MoneyRow label={t().sales.paid} value={formatMoney(detail.paid, currency, getLang())} />
              {detail.remaining > 0 ? (
                <MoneyRow label={t().sales.remaining} value={formatMoney(detail.remaining, currency, getLang())} bold />
              ) : null}
              <div className="mt-1 flex items-center justify-between border-t pt-2">
                <span className="font-medium">{t().sales.profit}</span>
                <Badge variant="outline" className="tabular-nums">
                  {formatMoney(detail.profit, currency, getLang())}
                </Badge>
              </div>
            </CardContent>
          </Card>

          {/* Order adjustments (T13/T15) — every change writes ledger rows
              + an event, never a silent edit. Adding / removing / swapping
              undelivered pieces lives on the Edit Sale page. */}
          {adjustable ? (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <HugeiconsIcon
                    icon={SlidersHorizontalIcon}
                    strokeWidth={2}
                    className="size-4"
                  />
                  {t().sales.adjustments}
                </CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-2">
                <Button
                  type="button"
                  variant="outline"
                  className="justify-start"
                  onClick={() => setAdjustOpen(true)}
                >
                  <HugeiconsIcon
                    icon={SlidersHorizontalIcon}
                    strokeWidth={2}
                    className="size-4"
                  />
                  {t().sales.adjustDeliveredTitle}
                </Button>
              </CardContent>
            </Card>
          ) : null}

          {/* Status actions */}
          {NEXT_STEPS[detail.sale.status].length > 0 ||
          CAN_CANCEL.includes(detail.sale.status) ? (
            <Card>
              <CardHeader>
                <CardTitle>{t().status[detail.sale.status]}</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-2">
                {NEXT_STEPS[detail.sale.status].map((status) => (
                  <Button
                    key={status}
                    type="button"
                    disabled={changing}
                    onClick={() => void doSetStatus(status)}
                  >
                    {markLabel(status)}
                  </Button>
                ))}
                {CAN_CANCEL.includes(detail.sale.status) ? (
                  <Button
                    type="button"
                    variant="destructive"
                    disabled={changing}
                    onClick={() => setCancelOpen(true)}
                  >
                    {t().sales.cancelOrder}
                  </Button>
                ) : null}
              </CardContent>
            </Card>
          ) : null}

          <Button
            type="button"
            variant="outline"
            onClick={() => router.push("/sales")}
          >
            {t().common.back}
          </Button>
        </div>
      </div>

      {/* Cancel confirm — flows unsold pieces back to stock */}
      <AlertDialog open={cancelOpen} onOpenChange={setCancelOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t().sales.cancelConfirmTitle}</AlertDialogTitle>
            <AlertDialogDescription>
              {t().sales.cancelConfirmBody}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {detail.sale.deliveryFee > 0 ? (
            <label className="flex items-start gap-3 rounded-md border p-3 text-sm">
              <Checkbox
                checked={keepShipping}
                onCheckedChange={(checked) => setKeepShipping(checked === true)}
                className="mt-0.5"
              />
              <span>
                <span className="font-medium">
                  {t().sales.keepShippingFee} (
                  {formatMoney(detail.sale.deliveryFee, currency, getLang())})
                </span>
                <span className="mt-1 block text-xs text-muted-foreground">
                  {t().sales.keepShippingFeeHint}
                </span>
              </span>
            </label>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel>{t().common.cancel}</AlertDialogCancel>
            <AlertDialogAction
              disabled={changing}
              onClick={() => void doSetStatus("cancelled")}
            >
              {t().sales.cancelOrder}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Invoice re-print (T25 reuses the T10 dialog) */}
      {invoiceOpen ? (
        <InvoiceDialog
          detail={detail}
          shopName={shop?.name ?? ""}
          shopAddress={shop?.address}
          currency={currency}
          timezone={timezone}
          printerConfig={shop?.printerConfig}
          onClose={() => setInvoiceOpen(false)}
        />
      ) : null}

      {/* T13/T15 adjustment dialogs — mounted fresh on each open, so their
          state always starts from the current server values. */}
      {adjustOpen ? (
        <AdjustDeliveryDialog
          saleId={detail.sale._id}
          items={detail.items}
          onClose={() => setAdjustOpen(false)}
        />
      ) : null}
      {returnLine ? (
        <ReturnItemDialog
          saleId={detail.sale._id}
          currency={currency}
          line={returnLine}
          paidCents={detail.paid}
          onClose={() => setReturnLine(null)}
        />
      ) : null}
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-muted-foreground">{label}</span>
      <span className="truncate text-right">{value}</span>
    </div>
  );
}

function MoneyRow({
  label,
  value,
  muted,
  bold,
}: {
  label: string;
  value: string;
  muted?: boolean;
  bold?: boolean;
}) {
  return (
    <div
      className={`flex justify-between ${muted ? "text-muted-foreground" : ""} ${bold ? "border-t pt-1 font-bold" : ""}`}
    >
      <span>{label}</span>
      <span className="tabular-nums">{value}</span>
    </div>
  );
}
