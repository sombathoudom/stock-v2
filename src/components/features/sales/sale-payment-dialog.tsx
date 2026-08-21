"use client";

import { Cancel01Icon, MoneyAdd01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation } from "convex/react";
import { useState } from "react";
import { FormProvider, useForm, useWatch } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";

import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FormDate } from "@/components/features/forms/form-date";
import { FormInput } from "@/components/features/forms/form-input";
import { FormMoney, moneyInputSchema } from "@/components/features/forms/form-money";
import { FormSelect } from "@/components/features/forms/form-select";
import {
  centsToInput,
  formatMoney,
  getLang,
  inputToCents,
  t,
  toastError,
} from "@/lib/utils";

// "Create a payment" from the sales list — records money received for an
// order that is not fully paid yet. The still-owed amount is prefilled;
// the date is backdatable (cash-basis reports count money on the day it
// was received); the change is shown live when the received amount exceeds
// the still-owed amount (the server clamps the stored row — change is never
// saved). Total/paid/remaining come from the Convex-live list row, so the
// dialog never shows stale numbers.

type CheckoutMethod = "cash" | "bank_transfer" | "other";

const schema = z.object({
  amount: moneyInputSchema,
  method: z.enum(["cash", "bank_transfer", "other"]),
  receivedAt: z.number(),
  note: z.string().max(500),
});

type FormValues = z.infer<typeof schema>;

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-2 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium tabular-nums">{value}</span>
    </div>
  );
}

export function SalePaymentDialog({
  saleId,
  total,
  paid,
  remaining,
  currency,
  onClose,
}: {
  saleId: Id<"sales">;
  total: number;
  paid: number;
  remaining: number;
  currency: string;
  onClose: () => void;
}) {
  const receive = useMutation(api.payments.receive);

  // Captured once on mount — the payment date defaults to NOW (the actual
  // receipt moment) and is capped at today (backdating allowed, future
  // not). Only an explicit earlier date changes the recorded day.
  const [maxDate] = useState(() => Date.now());
  const [initialReceivedAt] = useState(() => Date.now());

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      amount: centsToInput(remaining),
      method: "cash",
      receivedAt: initialReceivedAt,
      note: "",
    },
  });

  const amountValue = useWatch({ control: form.control, name: "amount" });
  const entered = inputToCents(amountValue ?? "") ?? 0;
  const [saving, setSaving] = useState(false);

  async function save(values: FormValues) {
    setSaving(true);
    try {
      await receive({
        saleId,
        amount: entered,
        method: values.method,
        receivedAt: values.receivedAt,
        note: values.note.trim() || undefined,
      });
      toast.success(
        entered > remaining
          ? t().sales.paymentAddedWithChange.replace(
              "{amount}",
              formatMoney(entered - remaining, currency, getLang())
            )
          : t().sales.paymentAdded
      );
      onClose();
    } catch (err) {
      toastError(err);
    } finally {
      setSaving(false);
    }
  }

  const methodOptions: { value: CheckoutMethod; label: string }[] = [
    { value: "cash", label: t().sales.methods.cash },
    { value: "bank_transfer", label: t().sales.methods.bank_transfer },
    { value: "other", label: t().sales.methods.other },
  ];

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t().sales.createPayment}</DialogTitle>
        </DialogHeader>
        <FormProvider {...form}>
          <form
            onSubmit={form.handleSubmit((values) => void save(values))}
            className="flex flex-col gap-4"
            noValidate
          >
            {/* Still owed — the pending amount this payment covers. */}
            <div className="flex flex-col gap-1 rounded-md border p-3">
              <SummaryRow
                label={t().sales.total}
                value={formatMoney(total, currency, getLang())}
              />
              <SummaryRow
                label={t().sales.paid}
                value={formatMoney(paid, currency, getLang())}
              />
              <SummaryRow
                label={t().sales.remaining}
                value={formatMoney(remaining, currency, getLang())}
              />
            </div>
            <FormMoney
              name="amount"
              label={`${t().sales.amountReceived} (${currency})`}
              placeholder="0.00"
            />
            {entered > 0 ? (
              <p className="text-sm tabular-nums text-muted-foreground">
                {entered > remaining
                  ? `${t().sales.changeDue}: ${formatMoney(entered - remaining, currency, getLang())}`
                  : `${t().sales.remaining}: ${formatMoney(remaining - entered, currency, getLang())}`}
              </p>
            ) : (
              <p className="text-sm text-muted-foreground">
                {t().sales.notPaid}
              </p>
            )}
            <FormSelect
              name="method"
              label={t().sales.method}
              options={methodOptions}
              required
            />
            <FormDate
              name="receivedAt"
              label={t().sales.paymentDate}
              max={maxDate}
              required
            />
            <FormInput
              name="note"
              label={t().sales.paymentNote}
              hint={t().sales.paymentNoteHint}
              maxLength={500}
            />
            <DialogFooter className="gap-2">
              <Button type="submit" disabled={saving || entered <= 0}>
                <HugeiconsIcon
                  icon={MoneyAdd01Icon}
                  strokeWidth={2}
                  className="size-4"
                />
                {t().common.save}
              </Button>
              <Button type="button" variant="destructive" onClick={onClose}>
                <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} className="size-4" />
                {t().common.cancel}
              </Button>
            </DialogFooter>
          </form>
        </FormProvider>
      </DialogContent>
    </Dialog>
  );
}
