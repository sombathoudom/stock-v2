"use client";

import {
  Cancel01Icon,
  Cash01Icon,
  Coins01Icon,
  ShoppingCart01Icon,
  StickyNote01Icon,
  Tick02Icon,
  UserIcon,
  Wallet02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useState } from "react";

import type { Doc } from "@convex/_generated/dataModel";

import { inputToMs, msToInput } from "@/components/features/forms/form-date";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { type CartLine } from "@/hooks/use-checkout-cart";
import { formatMoney, getLang, t } from "@/lib/utils";

// POS v4 — the "Payment Checkout" popup (2xl Dialog on desktop, bottom Sheet
// on phone). Three columns on desktop:
//   LEFT  — Transaction Summary (read-only cart lines, scrollable) + Total Amount
//   MIDDLE — payment type select, paid amount under it, sale channel,
//            delivery company (picked from a GRID of cards), sale date, payment date
//   RIGHT — customer info + payment note + sale note
// Footer: ONLY Cancel + Complete payment. Amount empty = order saved as
// unpaid (remaining shown as "Still owed"). `completing` disables the
// Complete button so double-clicks can never submit twice. The server
// re-validates every value and re-derives every total.

export type CheckoutMethod = "cash" | "bank_transfer" | "other";

/** Sentinel for "Self / pickup" — no company, no fees. */
export const SELF = "self";

/** What the cashier can adjust here before completing. The server
 *  re-validates every value; the payment amount itself is not editable. */
export type PaymentCheckoutPayload = {
  /** Backdated sale moment (epoch ms) — sent only when the date was changed. */
  createdAt?: number;
  /** Backdated payment moment (epoch ms) — sent only when paid. */
  receivedAt?: number;
  paymentNote?: string;
  saleNote?: string;
};

/** Local midnight for `now` (browser-local calendar day). */
function localMidnight(now: number): number {
  const d = new Date(now);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

type Props = {
  open: boolean;
  currency: string;
  customer: Doc<"customers"> | null;
  cart: CartLine[];
  total: number;
  channels: Doc<"salesChannels">[];
  channelId: string | null;
  onChannelIdChange: (channelId: string | null) => void;
  deliveryEnabled: boolean;
  companies: Doc<"deliveryCompanies">[];
  companyId: string | null;
  onCompanyChange: (value: string | null) => void;
  method: CheckoutMethod;
  onMethodChange: (method: CheckoutMethod) => void;
  amount: string;
  onAmountChange: (value: string) => void;
  amountCents: number;
  remaining: number;
  changeDue: number;
  canComplete: boolean;
  completing: boolean;
  onCancel: () => void;
  onConfirm: (payload: PaymentCheckoutPayload) => void;
};

export function PosPaymentDialog({
  open,
  currency,
  customer,
  cart,
  total,
  channels,
  channelId,
  onChannelIdChange,
  deliveryEnabled,
  companies,
  companyId,
  onCompanyChange,
  method,
  onMethodChange,
  amount,
  onAmountChange,
  amountCents,
  remaining,
  changeDue,
  canComplete,
  completing,
  onCancel,
  onConfirm,
}: Props) {
  const paid = amountCents > 0;

  // Editable review fields — reset to defaults every time the popup opens.
  // The sale date is sent only when the cashier actually changes it (so a
  // normal same-day sale keeps the exact `now` timestamp server-side).
  const [saleDate, setSaleDate] = useState<number>(() => localMidnight(Date.now()));
  const [saleDateDirty, setSaleDateDirty] = useState(false);
  const [paymentDate, setPaymentDate] = useState<number>(() =>
    localMidnight(Date.now())
  );
  const [paymentNote, setPaymentNote] = useState("");
  const [saleNote, setSaleNote] = useState("");

  useEffect(() => {
    if (open) {
      setSaleDate(localMidnight(Date.now()));
      setSaleDateDirty(false);
      setPaymentDate(localMidnight(Date.now()));
      setPaymentNote("");
      setSaleNote("");
    }
  }, [open]);

  // Line total shown in the summary: price × qty − per-item discount.
  const lineTotal = (line: CartLine) => {
    const d = parseFloat(line.discount);
    const discountCents = Number.isFinite(d) && d > 0 ? Math.round(d * 100) : 0;
    return line.price * line.qty - discountCents;
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Body — the middle scrolls (the summary items additionally scroll on
          their own); the footer below stays pinned. */}
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
        {/* Three columns on desktop, stacked on phone. */}
        <div className="grid items-start gap-3 sm:grid-cols-3">
          {/* LEFT — Transaction Summary + Total Amount */}
          <div className="flex flex-col rounded-md border">
            <p className="flex items-center gap-1.5 border-b px-3 py-2 text-sm font-semibold">
              <HugeiconsIcon
                icon={ShoppingCart01Icon}
                strokeWidth={2}
                className="size-4 text-muted-foreground"
              />
              {t().sales.transactionSummary}
            </p>
            <div className="max-h-[40dvh] overflow-y-auto p-3">
              {cart.map((line) => (
                <div
                  key={line.key ?? line.variantId}
                  className="flex items-start justify-between gap-2 border-b py-1.5 last:border-b-0"
                >
                  <span className="min-w-0">
                    <span className="block truncate text-sm">{line.label}</span>
                    <span className="text-xs tabular-nums text-muted-foreground">
                      {line.qty} × {formatMoney(line.price, currency, getLang())}
                    </span>
                  </span>
                  <span className="shrink-0 text-sm font-semibold tabular-nums">
                    {formatMoney(lineTotal(line), currency, getLang())}
                  </span>
                </div>
              ))}
              {cart.length === 0 && (
                <p className="py-2 text-sm text-muted-foreground">
                  {t().sales.cartEmpty}
                </p>
              )}
            </div>
            <div className="flex items-center justify-between border-t px-3 py-2">
              <span className="text-sm font-semibold">{t().sales.totalAmount}</span>
              <span className="text-lg font-bold tabular-nums">
                {formatMoney(total, currency, getLang())}
              </span>
            </div>
          </div>

          {/* MIDDLE — payment method, paid amount, channel, delivery, dates */}
          <div className="flex flex-col gap-3">
            <div className="grid gap-1.5">
              <Label className="flex items-center gap-1.5 text-xs">
                <HugeiconsIcon
                  icon={Wallet02Icon}
                  strokeWidth={2}
                  className="size-3.5 text-muted-foreground"
                />
                {t().sales.paymentType}
              </Label>
              <Select
                value={method}
                // Base UI shows the RAW value in the trigger without this map.
                items={{
                  cash: t().sales.methods.cash,
                  bank_transfer: t().sales.methods.bank_transfer,
                  other: t().sales.methods.other,
                }}
                onValueChange={(v) => onMethodChange(v as CheckoutMethod)}
              >
                <SelectTrigger className="w-full">
                  <HugeiconsIcon
                    icon={Cash01Icon}
                    strokeWidth={2}
                    className="size-4 text-muted-foreground"
                  />
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
              {/* Paid amount sits directly under the payment type box.
                  Empty = order saved as unpaid. */}
              <Label className="mt-1 flex items-center gap-1.5 text-xs">
                <HugeiconsIcon
                  icon={Coins01Icon}
                  strokeWidth={2}
                  className="size-3.5 text-muted-foreground"
                />
                {t().sales.paidAmount}
              </Label>
              <InputGroup>
                <InputGroupAddon>
                  <HugeiconsIcon icon={Coins01Icon} strokeWidth={2} className="size-4" />
                  {currency}
                </InputGroupAddon>
                <InputGroupInput
                  inputMode="decimal"
                  value={amount}
                  onChange={(e) => onAmountChange(e.target.value)}
                  placeholder="0.00"
                  aria-label={t().sales.paidAmount}
                />
              </InputGroup>
              {paid ? (
                <p className="text-xs tabular-nums text-muted-foreground">
                  {changeDue > 0
                    ? `${t().sales.changeDue}: ${formatMoney(changeDue, currency, getLang())}`
                    : `${t().sales.remaining}: ${formatMoney(remaining, currency, getLang())}`}
                </p>
              ) : (
                <p className="text-xs text-muted-foreground">
                  {t().sales.notPaid}
                </p>
              )}

              {/* ③ sale channel — required */}
              <Label className="mt-2 flex items-center gap-1.5 text-xs">
                <HugeiconsIcon
                  icon={ShoppingCart01Icon}
                  strokeWidth={2}
                  className="size-3.5 text-muted-foreground"
                />
                {t().sales.channel}
              </Label>
              <Select
                value={channelId ?? null}
                // Base UI shows the RAW value in the trigger without this map.
                items={Object.fromEntries(channels.map((c) => [c._id, c.name]))}
                onValueChange={(v) => onChannelIdChange(v)}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder={t().sales.channelHint} />
                </SelectTrigger>
                <SelectContent>
                  {channels.map((c) => (
                    <SelectItem key={c._id} value={c._id}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              {/* ④ delivery company — a GRID of pickable cards */}
              {deliveryEnabled && (
                <>
                  <Label className="mt-2 flex items-center gap-1.5 text-xs">
                    <HugeiconsIcon
                      icon={UserIcon}
                      strokeWidth={2}
                      className="size-3.5 text-muted-foreground"
                    />
                    {t().sales.delivery}
                  </Label>
                  <div className="grid grid-cols-2 gap-2">
                    <CompanyCard
                      selected={companyId === null}
                      name={t().sales.noCompany}
                      fee={null}
                      currency={currency}
                      onClick={() => onCompanyChange(null)}
                    />
                    {companies.map((c) => (
                      <CompanyCard
                        key={c._id}
                        selected={companyId === c._id}
                        name={c.name}
                        fee={c.defaultFee}
                        currency={currency}
                        onClick={() => onCompanyChange(c._id)}
                      />
                    ))}
                  </div>
                </>
              )}

              {/* Sale date + payment date (past days only, never the future). */}
              <div className="mt-2 grid grid-cols-2 gap-2">
                <div className="grid gap-1.5">
                  <Label htmlFor="pos-payment-sale-date" className="text-xs">
                    {t().sales.saleDate}
                  </Label>
                  <Input
                    id="pos-payment-sale-date"
                    type="date"
                    value={msToInput(saleDate)}
                    max={msToInput(Date.now())}
                    onChange={(e) => {
                      const ms = inputToMs(e.target.value);
                      if (ms != null) {
                        setSaleDate(ms);
                        setSaleDateDirty(true);
                      }
                    }}
                  />
                </div>
                {paid && (
                  <div className="grid gap-1.5">
                    <Label htmlFor="pos-payment-date" className="text-xs">
                      {t().sales.paymentDate}
                    </Label>
                    <Input
                      id="pos-payment-date"
                      type="date"
                      value={msToInput(paymentDate)}
                      max={msToInput(Date.now())}
                      onChange={(e) => {
                        const ms = inputToMs(e.target.value);
                        if (ms != null) setPaymentDate(ms);
                      }}
                    />
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* RIGHT — customer info + notes */}
          <div className="flex flex-col gap-3 rounded-md border p-3">
            <p className="flex items-center gap-1.5 text-sm font-semibold">
              <HugeiconsIcon
                icon={UserIcon}
                strokeWidth={2}
                className="size-4 text-muted-foreground"
              />
              {t().sales.customerInfo}
            </p>
            {customer ? (
              <div className="grid gap-1 text-sm">
                <span className="font-medium">{customer.name}</span>
                {customer.phone ? (
                  <span className="text-muted-foreground">{customer.phone}</span>
                ) : null}
                {customer.address ? (
                  <span className="text-muted-foreground">{customer.address}</span>
                ) : null}
                {customer.notes ? (
                  <span className="text-xs text-muted-foreground">
                    {customer.notes}
                  </span>
                ) : null}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                {t().sales.selectCustomer}
              </p>
            )}

            {paid && (
              <div className="grid gap-1.5">
                <Label
                  htmlFor="pos-payment-note"
                  className="flex items-center gap-1.5 text-xs"
                >
                  <HugeiconsIcon
                    icon={StickyNote01Icon}
                    strokeWidth={2}
                    className="size-3.5 text-muted-foreground"
                  />
                  {t().sales.paymentNote}
                </Label>
                <Input
                  id="pos-payment-note"
                  value={paymentNote}
                  onChange={(e) => setPaymentNote(e.target.value)}
                  maxLength={500}
                />
                <p className="text-xs text-muted-foreground">
                  {t().sales.paymentNoteHint}
                </p>
              </div>
            )}

            <div className="grid gap-1.5">
              <Label
                htmlFor="pos-sale-note"
                className="flex items-center gap-1.5 text-xs"
              >
                <HugeiconsIcon
                  icon={StickyNote01Icon}
                  strokeWidth={2}
                  className="size-3.5 text-muted-foreground"
                />
                {t().sales.saleNote}
              </Label>
              <Input
                id="pos-sale-note"
                value={saleNote}
                onChange={(e) => setSaleNote(e.target.value)}
                maxLength={500}
              />
              <p className="text-xs text-muted-foreground">
                {t().sales.saleNoteHint}
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Footer — ONLY Cancel + Complete payment. */}
      <div className="flex shrink-0 items-center gap-3 border-t pt-3">
        <Button
          type="button"
          variant="destructive"
          size="lg"
          className="h-11"
          onClick={onCancel}
        >
          <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} className="size-4" />
          {t().common.cancel}
        </Button>
        <Button
          type="button"
          size="lg"
          className="ml-auto h-11"
          // Completing disables the button — no duplicate submissions.
          disabled={!canComplete || completing}
          onClick={() =>
            onConfirm({
              ...(saleDateDirty ? { createdAt: saleDate } : {}),
              ...(paid ? { receivedAt: paymentDate } : {}),
              ...(paymentNote.trim() ? { paymentNote: paymentNote.trim() } : {}),
              ...(saleNote.trim() ? { saleNote: saleNote.trim() } : {}),
            })
          }
        >
          <HugeiconsIcon icon={Tick02Icon} strokeWidth={2} className="size-4" />
          {t().sales.completePayment}
        </Button>
      </div>
    </div>
  );
}

/** One pickable delivery company card in the grid. */
function CompanyCard({
  selected,
  name,
  fee,
  currency,
  onClick,
}: {
  selected: boolean;
  name: string;
  /** Default fee in cents, shown on the card; null = the Self / pickup card. */
  fee: number | null;
  currency: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      className={`flex flex-col gap-0.5 rounded-md border p-2 text-left transition-colors ${
        selected ? "border-primary bg-primary/5" : "hover:border-primary/60"
      }`}
    >
      <span className="line-clamp-2 text-xs font-medium">{name}</span>
      {fee !== null && (
        <span className="text-[11px] tabular-nums text-muted-foreground">
          {t().sales.deliveryFee}: {formatMoney(fee, currency, getLang())}
        </span>
      )}
    </button>
  );
}
