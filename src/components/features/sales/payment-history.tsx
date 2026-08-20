"use client";

import {
  Alert02Icon,
  CheckmarkCircle02Icon,
  MoneyReceive01Icon,
  MoneySend01Icon,
  Wallet02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation } from "convex/react";
import { useState } from "react";
import { toast } from "sonner";

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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  cn,
  formatDateTime,
  formatMoney,
  getLang,
  inputToCents,
  t,
  toastError,
} from "@/lib/utils";
import {
  paymentsNewestFirst,
  summarizePayments,
  type PaymentRowSource,
} from "@/lib/payment-summary";

// The Sale Detail payment history: summary cards + receive/refund actions +
// a chronological transaction list. EVERY displayed number is derived from
// the existing server payment rows (src/lib/payment-summary.ts) — nothing is
// cached, nothing is written outside the existing receive/refund mutations,
// and the server remains the source of truth.

type PaymentEvent = {
  event: { ts: number; type: string; payload?: Record<string, string> };
  userName: string;
};

export function PaymentHistory({
  saleId,
  orderTotal,
  currency,
  timezone,
  payments,
  events,
}: {
  saleId: Id<"sales">;
  orderTotal: number;
  currency: string;
  timezone: string;
  payments: PaymentRowSource[];
  events: PaymentEvent[];
}) {
  const labels = t().sales;
  const receive = useMutation(api.payments.receive);
  const refund = useMutation(api.payments.refund);

  const [tab, setTab] = useState("receive");
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState<"cash" | "bank_transfer" | "other">("cash");
  const [note, setNote] = useState("");
  const [refundAmount, setRefundAmount] = useState("");
  const [refundNote, setRefundNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmRefund, setConfirmRefund] = useState(false);

  const amountCents = inputToCents(amount) ?? 0;
  const refundCents = inputToCents(refundAmount) ?? 0;
  const summary = summarizePayments(orderTotal, payments);
  const rows = paymentsNewestFirst(payments);

  // The recorded-by user rides on the matching audit event (same ts + type +
  // amount) — a pure client join, no backend change.
  const userNameOf = (p: PaymentRowSource): string | undefined => {
    const expectedType = p.amount < 0 ? "refund" : "payment_received";
    const match = events.find(
      (e) =>
        e.event.ts === p.receivedAt &&
        e.event.type === expectedType &&
        e.event.payload?.amount === String(Math.abs(p.amount))
    );
    return match?.userName;
  };

  async function doReceive() {
    if (busy || amountCents <= 0 || amountCents > summary.remaining) return;
    setBusy(true);
    try {
      await receive({
        saleId,
        amount: amountCents,
        method,
        note: note.trim() || undefined,
      });
      toast.success(labels.paymentAdded);
      setAmount("");
      setNote("");
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  }

  async function doRefund() {
    if (busy || refundCents <= 0 || refundCents > summary.refundable) return;
    setBusy(true);
    setConfirmRefund(false);
    try {
      await refund({
        saleId,
        amount: refundCents,
        note: refundNote.trim() || undefined,
      });
      toast.success(labels.refundAdded);
      setRefundAmount("");
      setRefundNote("");
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  }

  const statusChip = (() => {
    switch (summary.status) {
      case "paid":
        return {
          text: labels.paidInFull,
          cls: "border-success/40 bg-success/10 text-success",
        };
      case "overpaid":
        return {
          text: labels.refundDue,
          cls: "border-warning/40 bg-warning/10 text-warning",
        };
      case "partially_paid":
        return {
          text: labels.paymentStatuses.partlyPaid,
          cls: "border-warning/40 bg-warning/10 text-warning",
        };
      default:
        return {
          text: labels.paymentStatuses.unpaid,
          cls: "border-muted bg-muted/40 text-muted-foreground",
        };
    }
  })();

  return (
    <div className="flex flex-col gap-4">
      {/* Summary cards: 3 across on desktop, compact 2-col on phone. */}
      <div className="grid grid-cols-2 gap-2 md:grid-cols-3">
        <div className="rounded-md border p-3">
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <HugeiconsIcon icon={Wallet02Icon} strokeWidth={2} className="size-3.5" />
            {labels.paymentSummaryTotal}
          </p>
          <p className="mt-1 text-lg font-semibold tabular-nums">
            {formatMoney(orderTotal, currency, getLang())}
          </p>
        </div>
        <div
          className={cn(
            "rounded-md border p-3",
            summary.status === "paid" && "border-success/40 bg-success/10"
          )}
        >
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <HugeiconsIcon
              icon={
                summary.status === "paid" ? CheckmarkCircle02Icon : MoneyReceive01Icon
              }
              strokeWidth={2}
              className="size-3.5"
            />
            {labels.paymentSummaryNetPaid}
          </p>
          <p className="mt-1 text-lg font-semibold tabular-nums">
            {formatMoney(summary.netPaid, currency, getLang())}
          </p>
        </div>
        <div
          className={cn(
            "col-span-2 rounded-md border p-3 md:col-span-1",
            summary.remaining > 0 && "border-warning/40 bg-warning/10"
          )}
        >
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <HugeiconsIcon icon={Alert02Icon} strokeWidth={2} className="size-3.5" />
            {labels.remaining}
          </p>
          <p className="mt-1 text-lg font-semibold tabular-nums">
            {formatMoney(summary.remaining, currency, getLang())}
          </p>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Badge variant="outline" className={statusChip.cls}>
          {statusChip.text}
        </Badge>
        {summary.hasRefunds ? (
          <span className="text-xs text-muted-foreground">
            {labels.receivedRefunded
              .replace(
                "{received}",
                formatMoney(summary.grossReceived, currency, getLang())
              )
              .replace(
                "{refunded}",
                formatMoney(summary.totalRefunded, currency, getLang())
              )}
          </span>
        ) : null}
        {summary.overpaid > 0 ? (
          <span className="text-xs font-medium text-warning">
            {labels.refundDue} — {formatMoney(summary.overpaid, currency, getLang())}
          </span>
        ) : null}
      </div>

      {/* Actions: Receive payment primary, Refund behind a tab. */}
      <Tabs value={tab} onValueChange={(v) => setTab(v)}>
        <TabsList className="grid w-full grid-cols-2">
          <TabsTrigger value="receive">{labels.receivePayment}</TabsTrigger>
          <TabsTrigger value="refund">{labels.refund}</TabsTrigger>
        </TabsList>

        {tab === "receive" ? (
          <div className="mt-3 grid gap-2 rounded-md border p-3 sm:grid-cols-[1fr_140px_1fr_auto] sm:items-end">
            <div className="grid gap-1">
              <Label>{labels.amountReceived}</Label>
              <Input
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="0.00"
                className="h-11"
                aria-label={labels.amountReceived}
              />
            </div>
            <div className="grid gap-1">
              <Label>{labels.method}</Label>
              <Select
                value={method}
                items={{
                  cash: labels.methods.cash,
                  bank_transfer: labels.methods.bank_transfer,
                  other: labels.methods.other,
                }}
                onValueChange={(v) =>
                  setMethod(v as "cash" | "bank_transfer" | "other")
                }
              >
                <SelectTrigger className="h-11 w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="cash">{labels.methods.cash}</SelectItem>
                  <SelectItem value="bank_transfer">
                    {labels.methods.bank_transfer}
                  </SelectItem>
                  <SelectItem value="other">{labels.methods.other}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1">
              <Label>{t().common.note}</Label>
              <Input
                value={note}
                onChange={(e) => setNote(e.target.value)}
                maxLength={200}
                className="h-11"
                aria-label={t().common.note}
              />
            </div>
            <Button
              type="button"
              className="h-11"
              disabled={busy || amountCents <= 0 || amountCents > summary.remaining}
              onClick={() => void doReceive()}
            >
              <HugeiconsIcon
                icon={MoneyReceive01Icon}
                strokeWidth={2}
                className="size-4"
              />
              {labels.receivePayment}
            </Button>
          </div>
        ) : (
          <div className="mt-3 grid gap-2 rounded-md border p-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
            <div className="grid gap-1">
              <Label>{labels.refundAmount}</Label>
              <Input
                inputMode="decimal"
                value={refundAmount}
                onChange={(e) => setRefundAmount(e.target.value)}
                placeholder="0.00"
                className="h-11"
                aria-label={labels.refundAmount}
              />
            </div>
            <div className="grid gap-1">
              <Label>{t().common.note}</Label>
              <Input
                value={refundNote}
                onChange={(e) => setRefundNote(e.target.value)}
                maxLength={200}
                className="h-11"
                aria-label={t().common.note}
              />
            </div>
            <Button
              type="button"
              variant="destructive"
              className="h-11"
              disabled={busy || refundCents <= 0 || refundCents > summary.refundable}
              onClick={() => setConfirmRefund(true)}
            >
              <HugeiconsIcon icon={MoneySend01Icon} strokeWidth={2} className="size-4" />
              {labels.refund}
            </Button>
            <p className="text-xs text-muted-foreground sm:col-span-3">
              {labels.refundHint}
            </p>
          </div>
        )}
      </Tabs>

      {/* Refund confirmation with the after-numbers. */}
      <Dialog open={confirmRefund} onOpenChange={setConfirmRefund}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {labels.refundConfirmTitle.replace(
                "{amount}",
                formatMoney(refundCents, currency, getLang())
              )}
            </DialogTitle>
            <DialogDescription>
              {labels.refundConfirmNetAfter.replace(
                "{amount}",
                formatMoney(summary.netPaid - refundCents, currency, getLang())
              )}{" "}
              ·{" "}
              {labels.refundConfirmRemainingAfter.replace(
                "{amount}",
                formatMoney(summary.remaining + refundCents, currency, getLang())
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button
              type="button"
              variant="secondary"
              onClick={() => setConfirmRefund(false)}
              disabled={busy}
            >
              {t().common.cancel}
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => void doRefund()}
              disabled={busy}
            >
              {labels.refund}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Transaction list — newest first, never color alone. */}
      {rows.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-md border border-dashed py-8 text-center">
          <HugeiconsIcon
            icon={Wallet02Icon}
            strokeWidth={2}
            className="size-8 text-muted-foreground"
          />
          <p className="text-sm text-muted-foreground">{labels.noPaymentsYet}</p>
        </div>
      ) : (
        <ul className="flex flex-col divide-y">
          {rows.map((p) => {
            const isRefund = p.amount < 0;
            const userName = userNameOf(p);
            return (
              <li key={p._id} className="flex flex-col gap-1 py-2.5 text-sm">
                <div className="flex items-center gap-2">
                  <HugeiconsIcon
                    icon={isRefund ? MoneySend01Icon : MoneyReceive01Icon}
                    strokeWidth={2}
                    className={cn(
                      "size-4 shrink-0",
                      isRefund ? "text-destructive" : "text-success"
                    )}
                  />
                  <span className="font-medium">
                    {isRefund ? labels.refundIssued : labels.paymentReceived}
                  </span>
                  <span
                    className={cn(
                      "ml-auto font-semibold tabular-nums",
                      isRefund ? "text-destructive" : "text-success"
                    )}
                  >
                    {isRefund ? "−" : "+"}
                    {formatMoney(Math.abs(p.amount), currency, getLang())}
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <Badge variant="secondary">{labels.methods[p.method]}</Badge>
                  <span>{formatDateTime(p.receivedAt, timezone, getLang())}</span>
                  {userName ? (
                    <span>
                      {t().sales.by} {userName}
                    </span>
                  ) : null}
                </div>
                {p.note ? (
                  <p className="text-xs text-muted-foreground">{p.note}</p>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
