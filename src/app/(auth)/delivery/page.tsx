"use client";

import {
  Camera01Icon,
  CheckmarkCircle02Icon,
  PackageAdd01Icon,
  PackageReceive01Icon,
  PackageRemove01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import Link from "next/link";
import { useRef, useState } from "react";
import { toast } from "sonner";

import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { PageToolbar } from "@/components/features/shell/page-toolbar";
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
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useShop } from "@/hooks/use-shop";
import { compressImage } from "@/lib/image-compress";
import {
  centsToInput,
  formatDateTime,
  formatMoney,
  getLang,
  inputToCents,
  t,
  toastError,
} from "@/lib/utils";

// T17 — the evening delivery ritual (AGENTS.md). Today's orders out for
// delivery are grouped by delivery company; the owner marks each order's
// outcome from whatever confirmation they got — a photo, a call, a paper
// list. The app assumes no report format. Outcomes drive stock flow-back
// and the fee payable per company; a packaging photo can be attached to
// any order. Owners without the delivery module never see this screen.

type DeliveryReport = NonNullable<
  FunctionReturnType<typeof api.delivery.listToday>
>;
type Group = DeliveryReport["groups"][number];
type OrderRow = Group["open"][number];
type Outcome = NonNullable<OrderRow["sale"]["deliveryOutcome"]>;

/** Packaging photo: current one (if any) + upload button. Upload goes
 * through the server-generated upload URL (no credentials in the browser)
 * and the storage id is saved on the order. */
function PhotoUpload({
  saleId,
  imageStorageId,
}: {
  saleId: Id<"sales">;
  imageStorageId?: Id<"_storage">;
}) {
  const generateUploadUrl = useMutation(api.delivery.generateUploadUrl);
  const setPackagingPhoto = useMutation(api.delivery.setPackagingPhoto);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  async function onPick(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    try {
      // Downscale before upload — packaging shots come from the phone camera.
      const compressed = await compressImage(file);
      const uploadUrl = await generateUploadUrl();
      const res = await fetch(uploadUrl, {
        method: "POST",
        headers: { "Content-Type": compressed.type },
        body: compressed,
      });
      if (!res.ok) throw new Error("Upload failed");
      const { storageId } = (await res.json()) as { storageId: Id<"_storage"> };
      await setPackagingPhoto({ saleId, imageStorageId: storageId });
      toast.success(t().deliveryReport.photoUploaded);
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  return (
    <div className="flex items-center gap-2">
      {imageStorageId ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={`/api/getImage?storageId=${imageStorageId}`}
          alt={t().deliveryReport.packagingPhoto}
          className="size-12 rounded-md border object-cover"
        />
      ) : null}
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        className="hidden"
        aria-label={t().deliveryReport.uploadPhoto}
        onChange={(e) => onPick(e.target.files?.[0])}
      />
      <Button
        type="button"
        variant="outline"
        size="icon-sm"
        disabled={busy}
        aria-label={t().deliveryReport.uploadPhoto}
        title={t().deliveryReport.uploadPhoto}
        onClick={() => inputRef.current?.click()}
      >
        <HugeiconsIcon icon={Camera01Icon} strokeWidth={2} className="size-4" />
      </Button>
    </div>
  );
}

/** The fee the shop pays the company for this order — editable per order,
 * commits on blur (before it becomes an expense). */
function FeeInput({
  saleId,
  deliveryCost,
  currency,
}: {
  saleId: Id<"sales">;
  deliveryCost: number;
  currency: string;
}) {
  const setDeliveryCost = useMutation(api.delivery.setDeliveryCost);
  const [text, setText] = useState(centsToInput(deliveryCost));
  const [busy, setBusy] = useState(false);

  // Adjust state during render when the saved value changes (the React
  // "you might not need an effect" pattern — an effect here would cascade
  // renders and can clobber what the owner is typing).
  const [prevCost, setPrevCost] = useState(deliveryCost);
  if (deliveryCost !== prevCost) {
    setPrevCost(deliveryCost);
    setText(centsToInput(deliveryCost));
  }

  async function commit() {
    const cents = inputToCents(text);
    if (cents === null || cents === deliveryCost) {
      setText(centsToInput(deliveryCost));
      return;
    }
    setBusy(true);
    try {
      await setDeliveryCost({ saleId, amount: cents });
      toast.success(t().deliveryReport.feeUpdated);
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <label className="flex items-center gap-1.5 text-xs">
      <span className="text-muted-foreground">{t().sales.companyCost}</span>
      <Input
        type="number"
        inputMode="decimal"
        min="0"
        step="0.01"
        disabled={busy}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
        className="h-8 w-24 px-2 text-xs"
        aria-label={`${t().sales.companyCost} (${currency})`}
      />
    </label>
  );
}

/** Delivered / Partial / Returned / Cancelled for one open order. Delivered
 * is instant; Partial opens the per-line dialog; Returned and Cancelled
 * flow everything back to stock, so they confirm first. */
function OutcomeActions({
  row,
  currency,
  onPartial,
}: {
  row: OrderRow;
  currency: string;
  onPartial: (row: OrderRow) => void;
}) {
  const markOutcome = useMutation(api.delivery.markOutcome);
  const [confirming, setConfirming] = useState<"returned" | "cancelled" | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  // Returned / cancelled: the delivery man made the trip and brought the
  // goods back, so the customer can still be charged for the shipping.
  const [keepShipping, setKeepShipping] = useState(false);

  async function mark(outcome: Outcome) {
    setBusy(true);
    try {
      await markOutcome({
        saleId: row.sale._id,
        outcome,
        ...(keepShipping ? { chargeDeliveryFee: true } : {}),
      });
      toast.success(t().deliveryReport.outcomeMarked);
      setConfirming(null);
      setKeepShipping(false);
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Button
        size="sm"
        disabled={busy}
        onClick={() => mark("delivered")}
        className="min-h-11"
      >
        {t().deliveryReport.outcome.delivered}
      </Button>
      <Button
        size="sm"
        variant="outline"
        disabled={busy}
        onClick={() => onPartial(row)}
        className="min-h-11"
      >
        {t().deliveryReport.outcome.partial}
      </Button>
      <Button
        size="sm"
        variant="outline"
        disabled={busy}
        onClick={() => setConfirming("returned")}
        className="min-h-11"
      >
        {t().deliveryReport.outcome.returned}
      </Button>
      <Button
        size="sm"
        variant="destructive"
        disabled={busy}
        onClick={() => setConfirming("cancelled")}
        className="min-h-11"
      >
        {t().deliveryReport.outcome.cancelled}
      </Button>

      <AlertDialog
        open={confirming !== null}
        onOpenChange={(open) => {
          if (!open) setConfirming(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirming === "returned"
                ? t().deliveryReport.returnedConfirmTitle
                : t().deliveryReport.cancelledConfirmTitle}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirming === "returned"
                ? t().deliveryReport.returnedConfirmBody
                : t().deliveryReport.cancelledConfirmBody}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {row.sale.deliveryFee > 0 ? (
            <label className="flex items-start gap-3 rounded-md border p-3 text-sm">
              <Checkbox
                checked={keepShipping}
                onCheckedChange={(checked) => setKeepShipping(checked === true)}
                className="mt-0.5"
              />
              <span>
                <span className="font-medium">
                  {t().sales.keepShippingFee} (
                  {formatMoney(row.sale.deliveryFee, currency, getLang())})
                </span>
                <span className="mt-1 block text-xs text-muted-foreground">
                  {t().sales.keepShippingFeeHint}
                </span>
              </span>
            </label>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogAction
              disabled={busy || confirming === null}
              onClick={() => confirming !== null && mark(confirming)}
            >
              {t().common.confirm}
            </AlertDialogAction>
            <AlertDialogCancel variant="destructive">
              <HugeiconsIcon
                icon={PackageRemove01Icon}
                strokeWidth={2}
                className="size-4"
              />
              {t().common.cancel}
            </AlertDialogCancel>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/** "Mark partially delivered": per line, how many pieces did the customer
 * actually take? The rest flows back to stock (server-side, ledger rows). */
function PartialDialog({
  row,
  onClose,
}: {
  row: OrderRow;
  onClose: () => void;
}) {
  const detail = useQuery(api.sales.getDetail, { saleId: row.sale._id });
  const markOutcome = useMutation(api.delivery.markOutcome);
  const [qtys, setQtys] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState(false);

  // Initialize the steppers once the detail lands (0 for fresh deliveries).
  // Render-adjust instead of an effect — the dialog unmounts on close, so
  // this runs once per opened sale.
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  if (detail && loadedFor !== detail.sale._id) {
    setLoadedFor(detail.sale._id);
    setQtys(
      Object.fromEntries(
        detail.items.map(({ item }) => [item._id, item.qtyDelivered]),
      ),
    );
  }

  function setQty(saleItemId: Id<"saleItems">, qty: number) {
    setQtys((prev) => ({ ...prev, [saleItemId]: qty }));
  }

  async function save() {
    if (!detail) return;
    setBusy(true);
    try {
      await markOutcome({
        saleId: row.sale._id,
        outcome: "partial",
        adjustments: detail.items.map(({ item }) => ({
          saleItemId: item._id,
          qtyDelivered: qtys[item._id] ?? item.qtyDelivered,
        })),
      });
      toast.success(t().deliveryReport.outcomeMarked);
      onClose();
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[85dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t().deliveryReport.partialTitle}</DialogTitle>
          <DialogDescription>{t().deliveryReport.partialHint}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          {(detail?.items ?? []).map(({ item, variant, product }) => {
            // Delivered is historical (invariant 5): the ceiling stays the
            // full ordered qty and the floor is what was returned — the
            // server applies the same bounds.
            const max = item.qtyOrdered;
            const min = item.qtyReturned;
            const qty = qtys[item._id] ?? item.qtyDelivered;
            return (
              <div
                key={item._id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-2.5"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">
                    {product.name} — {variant.size}
                    {variant.color ? ` · ${variant.color}` : ""}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {t().sales.itemQtys.ordered} {item.qtyOrdered}
                    {item.qtyReturned > 0
                      ? ` · ${t().sales.itemQtys.returned} ${item.qtyReturned}`
                      : ""}
                  </p>
                </div>
                <div className="flex items-center gap-1">
                  <Button
                    type="button"
                    variant="outline"
                    size="icon-sm"
                    className="size-11"
                    disabled={busy || qty <= min}
                    aria-label="−"
                    onClick={() => setQty(item._id, Math.max(min, qty - 1))}
                  >
                    <HugeiconsIcon
                      icon={PackageRemove01Icon}
                      strokeWidth={2}
                      className="size-4"
                    />
                  </Button>
                  <span className="w-10 text-center text-sm font-semibold tabular-nums">
                    {qty}
                  </span>
                  <Button
                    type="button"
                    variant="outline"
                    size="icon-sm"
                    className="size-11"
                    disabled={busy || qty >= max}
                    aria-label="+"
                    onClick={() => setQty(item._id, Math.min(max, qty + 1))}
                  >
                    <HugeiconsIcon
                      icon={PackageAdd01Icon}
                      strokeWidth={2}
                      className="size-4"
                    />
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
        <DialogFooter>
          <Button disabled={busy || !detail} onClick={save}>
            <HugeiconsIcon
              icon={CheckmarkCircle02Icon}
              strokeWidth={2}
              className="size-4"
            />
            {t().deliveryReport.mark}
          </Button>
          <Button variant="destructive" disabled={busy} onClick={onClose}>
            <HugeiconsIcon
              icon={PackageRemove01Icon}
              strokeWidth={2}
              className="size-4"
            />
            {t().common.cancel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function OutcomeBadge({ outcome }: { outcome: Outcome }) {
  const label = t().deliveryReport.outcome[outcome];
  return (
    <Badge
      variant={
        outcome === "delivered"
          ? "default"
          : outcome === "partial"
            ? "secondary"
            : "destructive"
      }
    >
      {label}
    </Badge>
  );
}

/** One open order card: who, what, money, photo, fee, and the outcome
 * buttons. On phone everything stacks; on desktop it wraps comfortably. */
function OpenOrderCard({
  row,
  currency,
  onPartial,
}: {
  row: OrderRow;
  currency: string;
  onPartial: (row: OrderRow) => void;
}) {
  const lang = getLang();
  return (
    <div className="flex flex-col gap-2 rounded-lg border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Link
          href={`/sales/${row.sale._id}`}
          className="min-w-0 truncate text-sm font-semibold hover:underline"
        >
          {row.sale.code}
        </Link>
        <Badge variant="outline">{t().status[row.sale.status]}</Badge>
      </div>
      <div className="min-w-0">
        <p className="truncate text-sm">
          {row.customerName} · {row.customerPhone}
        </p>
        {row.customerAddress ? (
          <p className="truncate text-xs text-muted-foreground">
            {row.customerAddress}
          </p>
        ) : null}
        <p className="truncate text-xs text-muted-foreground">
          {row.itemSummary}
        </p>
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span>
          {t().sales.total} {formatMoney(row.total, currency, lang)}
        </span>
        <span>
          {t().sales.paid} {formatMoney(row.paid, currency, lang)}
        </span>
        <span className={row.remaining > 0 ? "text-destructive" : undefined}>
          {t().sales.remaining} {formatMoney(row.remaining, currency, lang)}
        </span>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-3">
          <FeeInput
            saleId={row.sale._id}
            deliveryCost={row.sale.deliveryCost}
            currency={currency}
          />
          <PhotoUpload
            saleId={row.sale._id}
            imageStorageId={row.sale.imageStorageId}
          />
        </div>
        <OutcomeActions row={row} currency={currency} onPartial={onPartial} />
      </div>
    </div>
  );
}

/** One marked order: outcome badge + when it was marked. */
function MarkedOrderCard({
  row,
  timezone,
}: {
  row: OrderRow;
  timezone: string;
}) {
  const lang = getLang();
  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-dashed p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Link
          href={`/sales/${row.sale._id}`}
          className="min-w-0 truncate text-sm font-medium hover:underline"
        >
          {row.sale.code}
        </Link>
        <OutcomeBadge outcome={row.sale.deliveryOutcome ?? "cancelled"} />
      </div>
      <p className="truncate text-xs text-muted-foreground">
        {row.customerName} · {row.itemSummary}
      </p>
      <p className="text-xs text-muted-foreground">
        {row.sale.outcomeMarkedAt
          ? formatDateTime(row.sale.outcomeMarkedAt, timezone, lang)
          : ""}
      </p>
    </div>
  );
}

/** One company's whole evening: summary + open packages + today's marked. */
function CompanyGroup({
  group,
  currency,
  timezone,
  onPartial,
}: {
  group: Group;
  currency: string;
  timezone: string;
  onPartial: (row: OrderRow) => void;
}) {
  const lang = getLang();
  const s = t().deliveryReport.summary;
  const summaryParts = [
    `${s.handled} ${group.handledCount}`,
    `${s.delivered} ${group.deliveredCount}`,
    `${s.partial} ${group.partialCount}`,
    `${s.returns} ${group.returnsCount}`,
    `${s.cancellations} ${group.cancellationsCount}`,
  ];
  return (
    <Card>
      <CardHeader className="gap-2 pb-3">
        <CardTitle className="text-base">
          {group.company?.name ?? t().deliveryReport.selfDelivery}
        </CardTitle>
        <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
          {summaryParts.map((part) => (
            <Badge key={part} variant="outline">
              {part}
            </Badge>
          ))}
          <Badge variant="secondary">
            {s.feePayable} {formatMoney(group.feeTotal, currency, lang)}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {group.open.length > 0 ? (
          <div>
            <h3 className="mb-2 text-sm font-semibold text-muted-foreground">
              {t().deliveryReport.openOrders} ({group.open.length})
            </h3>
            <div className="flex flex-col gap-2">
              {group.open.map((row) => (
                <OpenOrderCard
                  key={row.sale._id}
                  row={row}
                  currency={currency}
                  onPartial={onPartial}
                />
              ))}
            </div>
          </div>
        ) : null}
        {group.marked.length > 0 ? (
          <div>
            <h3 className="mb-2 text-sm font-semibold text-muted-foreground">
              {t().deliveryReport.markedToday} ({group.marked.length})
            </h3>
            <div className="flex flex-col gap-2">
              {group.marked.map((row) => (
                <MarkedOrderCard
                  key={row.sale._id}
                  row={row}
                  timezone={timezone}
                />
              ))}
            </div>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

export default function DeliveryPage() {
  const report = useQuery(api.delivery.listToday);
  const shop = useShop();
  const [partialFor, setPartialFor] = useState<OrderRow | null>(null);

  const currency = shop?.currency ?? "USD";
  const timezone = shop?.timezone ?? "Asia/Phnom_Penh";

  return (
    <div className="flex flex-col">
      <PageToolbar
        icon={PackageReceive01Icon}
        title={t().deliveryReport.title}
      />
      <div className="flex flex-col gap-4 p-4">
        {report === undefined || shop === undefined ? (
          <p className="text-sm text-muted-foreground">{t().common.loading}</p>
        ) : !report.deliveryEnabled ? (
          <Card>
            <CardContent className="pt-6 text-sm text-muted-foreground">
              {t().deliveryReport.deliveryOff}
            </CardContent>
          </Card>
        ) : report.groups.length === 0 ? (
          <Card>
            <CardContent className="pt-6 text-sm text-muted-foreground">
              {t().deliveryReport.noOrders}
            </CardContent>
          </Card>
        ) : (
          <>
            <p className="text-sm text-muted-foreground">
              {t().deliveryReport.hint}
            </p>
            {report.groups.map((group) => (
              <CompanyGroup
                key={group.company?._id ?? "self"}
                group={group}
                currency={currency}
                timezone={timezone}
                onPartial={setPartialFor}
              />
            ))}
          </>
        )}
      </div>
      {partialFor ? (
        <PartialDialog row={partialFor} onClose={() => setPartialFor(null)} />
      ) : null}
    </div>
  );
}
