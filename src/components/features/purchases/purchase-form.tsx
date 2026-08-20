"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import {
  Cancel01Icon,
  Delete02Icon,
  Image01Icon,
  PackageAddIcon,
  PencilEdit01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation, useQuery } from "convex/react";
import { useRouter } from "next/navigation";
import { Fragment, useMemo, useState } from "react";
import { FormProvider, useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";

import { api } from "@convex/_generated/api";
import type { Doc, Id } from "@convex/_generated/dataModel";
import { FormCombobox } from "@/components/features/forms/form-combobox";
import { FormDate, inputToMs, msToInput } from "@/components/features/forms/form-date";
import { FormMoney, optionalMoneySchema } from "@/components/features/forms/form-money";
import { FormTextarea } from "@/components/features/forms/form-textarea";
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
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useCurrentUser } from "@/hooks/use-current-user";
import { centsToInput, formatMoney, imageUrl, inputToCents, t, toastError } from "@/lib/utils";
import {
  BulkLineEntry,
  type LineDraft,
  type PurchaseLine,
} from "./bulk-line-entry";

// One shared form for create + edit (AGENTS.md T5): supplier combobox at the
// top (search + quick-add), BULK item entry (every active variant of a
// picked product becomes an editable row — one tap fills qty/cost/sale price
// across all sizes), a summary that merges each product into ONE row (image
// + name) with its variants nested inside, and an Order Summary block
// (pieces, delivery cost, other cost, grand total). Dates drive the status:
// purchase date (business date) + arrival date — filled = arrived, stock
// goes in ON THAT DATE; empty = not yet arrived. Lines live in local state
// and are sent as one full set on save — the server reconciles and
// re-validates everything, never trusting the client.

export type InitialPurchase = {
  purchase: Doc<"purchases">;
  supplier: Doc<"suppliers">;
  items: {
    item: Doc<"purchaseItems">;
    variant: Doc<"productVariants">;
    product: Doc<"products">;
  }[];
};

/** One product's lines in the summary, with group totals. */
type ProductGroup = {
  product: Doc<"products">;
  lines: PurchaseLine[];
  pieces: number;
  cost: number;
};

const purchaseSchema = z
  .object({
    supplierId: z.string().min(1),
    // FormDate stores epoch ms or null; the refine below makes the
    // purchase date required while the arrival date stays optional.
    purchasedDate: z.number().nullable(),
    arrivalDate: z.number().nullable(),
    notes: z.string().max(2000),
    // Optional money as strings ("12.50", "" = none) — converted to cents
    // on save; the server re-validates.
    deliveryCost: optionalMoneySchema,
    otherCost: optionalMoneySchema,
  })
  .refine((v) => v.purchasedDate != null, {
    message: t().common.required,
    path: ["purchasedDate"],
  })
  .refine(
    (v) =>
      v.purchasedDate == null ||
      v.arrivalDate == null ||
      v.arrivalDate >= v.purchasedDate,
    { message: t().purchases.arrivalBeforePurchase, path: ["arrivalDate"] }
  );

type PurchaseValues = z.infer<typeof purchaseSchema>;

export function PurchaseForm({
  initial,
  onDone,
}: {
  /** Present = edit mode; undefined = create mode. */
  initial?: InitialPurchase;
  /** Called after save or cancel — the page navigates back to the list. */
  onDone: () => void;
}) {
  const router = useRouter();
  const user = useCurrentUser();
  const shop = useQuery(api.shop.get, user == null ? "skip" : {});
  const currency = shop?.currency ?? "USD";

  const create = useMutation(api.purchases.create);
  const update = useMutation(api.purchases.update);

  const [lines, setLines] = useState<PurchaseLine[]>(
    () =>
      initial?.items.map(({ item, variant, product }) => ({
        key: item._id,
        purchaseItemId: item._id,
        product,
        variantId: variant._id,
        size: variant.size,
        color: variant.color,
        qty: item.qty,
        unitCost: item.unitCost,
        currentPrice: variant.price ?? product.defaultPrice,
      })) ?? []
  );
  const [editLine, setEditLine] = useState<PurchaseLine | null>(null);
  const [saving, setSaving] = useState(false);
  // Set when the owner clears the arrival date of a received purchase —
  // needs one confirm before the stock is taken back off the shelves.
  const [pendingUnarrive, setPendingUnarrive] = useState<PurchaseValues | null>(
    null
  );

  const form = useForm<PurchaseValues>({
    resolver: zodResolver(purchaseSchema),
    defaultValues: {
      supplierId: initial?.supplier._id ?? "",
      // Create defaults to TODAY's midnight (the picker shows today; the
      // stored value must be that DAY, not the current instant). Edit
      // keeps the stored business date as-is.
      purchasedDate: initial
        ? initial.purchase.purchasedAt
        : inputToMs(msToInput(Date.now())),
      arrivalDate: initial?.purchase.receivedAt ?? null,
      notes: initial?.purchase.notes ?? "",
      deliveryCost: centsToInput(initial?.purchase.deliveryCost),
      otherCost: centsToInput(initial?.purchase.otherCost),
    },
  });

  // Arrival state is DERIVED from the arrival date (AGENTS.md: no stored
  // status to drift) — filled = arrived, empty = not yet arrived.
  const arrivalDate = form.watch("arrivalDate");
  const purchasedDate = form.watch("purchasedDate");
  const arrived = arrivalDate != null;

  // Combobox options: active suppliers + the purchase's current supplier
  // (it may have been deactivated — editing must still show it).
  const suppliers = useQuery(api.suppliers.listActive, user == null ? "skip" : {});
  const supplierOptions = useMemo(() => {
    const list = (suppliers ?? []).map((s) => ({ value: s._id, label: s.name }));
    if (initial && !list.some((o) => o.value === initial.supplier._id)) {
      list.unshift({ value: initial.supplier._id, label: initial.supplier.name });
    }
    return list;
  }, [suppliers, initial]);

  // Live totals (AGENTS.md): items = Σ qty, total cost = Σ qty × unitCost.
  const totalPieces = lines.reduce((n, l) => n + l.qty, 0);
  const totalCost = lines.reduce((n, l) => n + l.qty * l.unitCost, 0);
  // Order Summary: delivery/other costs are optional form strings; the
  // grand total is display-only (the server re-derives everything).
  const deliveryCost = inputToCents(form.watch("deliveryCost")) ?? 0;
  const otherCost = inputToCents(form.watch("otherCost")) ?? 0;
  const grandTotal = totalCost + deliveryCost + otherCost;

  // Summary groups: ONE row per product, its lines sorted by the product's
  // size / color order and nested inside the row.
  const groups = useMemo<ProductGroup[]>(() => {
    const byProduct = new Map<Id<"products">, PurchaseLine[]>();
    for (const l of lines) {
      const list = byProduct.get(l.product._id);
      if (list) list.push(l);
      else byProduct.set(l.product._id, [l]);
    }
    return [...byProduct.entries()].map(([, ls]) => {
      const product = ls[0].product;
      const sizeOrder = new Map(product.sizes.map((s, i) => [s, i]));
      const colorOrder = new Map(product.colors.map((c, i) => [c, i]));
      const sorted = [...ls].sort((a, b) => {
        const sa = sizeOrder.get(a.size) ?? 0;
        const sb = sizeOrder.get(b.size) ?? 0;
        if (sa !== sb) return sa - sb;
        return (
          (colorOrder.get(a.color ?? "") ?? 0) - (colorOrder.get(b.color ?? "") ?? 0)
        );
      });
      return {
        product,
        lines: sorted,
        pieces: sorted.reduce((n, l) => n + l.qty, 0),
        cost: sorted.reduce((n, l) => n + l.qty * l.unitCost, 0),
      };
    });
  }, [lines]);

  /** Upsert the bulk grid's drafts into the line set (one line per variant). */
  function handleBulkSave(drafts: LineDraft[]) {
    setLines((ls) => {
      if (editLine) {
        // Group-replace: the grid showed ONE product's sizes — replace all
        // of that product's lines with the drafts. Lines the drafts still
        // cover keep their key + purchaseItemId (the server patches them,
        // no stock churn); cleared sizes drop; new sizes join.
        const productId = editLine.product._id;
        const oldByVariant = new Map(
          ls
            .filter((l) => l.product._id === productId)
            .map((l) => [l.variantId, l])
        );
        const rest = ls.filter((l) => l.product._id !== productId);
        const replaced = drafts.map((d) => {
          const old = oldByVariant.get(d.variantId);
          return old ? { ...old, ...d } : { key: `new-${crypto.randomUUID()}`, ...d };
        });
        return [...rest, ...replaced];
      }
      // Add mode: upsert by variantId (one line per variant).
      let next = ls;
      for (const d of drafts) {
        const existing = next.find((l) => l.variantId === d.variantId);
        if (existing) {
          next = next.map((l) => (l.variantId === d.variantId ? { ...l, ...d } : l));
        } else {
          next = [...next, { key: `new-${crypto.randomUUID()}`, ...d }];
        }
      }
      return next;
    });
    setEditLine(null);
  }

  function removeGroup(productId: Id<"products">) {
    setLines((ls) => ls.filter((l) => l.product._id !== productId));
    setEditLine((current) => (current?.product._id === productId ? null : current));
  }

  /** Create or update with the full line set. Returns on error. */
  async function doSave(values: PurchaseValues) {
    if (!values.supplierId) {
      toast.error(t().purchases.needSupplier);
      return;
    }
    if (lines.length === 0) {
      toast.error(t().purchases.needLines);
      return;
    }
    setSaving(true);
    try {
      // Optional costs: "" → null (none); the schema guarantees parseable
      // strings otherwise.
      const deliveryCost = inputToCents(values.deliveryCost);
      const otherCost = inputToCents(values.otherCost);
      const linePayload = lines.map((l) => ({
        purchaseItemId: l.purchaseItemId,
        variantId: l.variantId,
        qty: l.qty,
        unitCost: l.unitCost,
        // Only lines with a price change carry `price` — omitted = keep
        // the variant's current sale price.
        ...(l.price !== undefined ? { price: l.price } : {}),
      }));
      if (initial) {
        await update({
          purchaseId: initial.purchase._id,
          supplierId: values.supplierId as Id<"suppliers">,
          notes: values.notes.trim() || undefined,
          purchasedAt: values.purchasedDate ?? undefined,
          // null = un-arrive (clears the ledger); a number = arrive/keep.
          receivedAt: values.arrivalDate,
          // null clears a cost on the server.
          deliveryCost,
          otherCost,
          lines: linePayload,
        });
        toast.success(t().purchases.saved);
        onDone();
      } else {
        const created = await create({
          supplierId: values.supplierId as Id<"suppliers">,
          notes: values.notes.trim() || undefined,
          purchasedAt: values.purchasedDate ?? Date.now(),
          // Create accepts a number only — an empty arrival date is simply
          // omitted (the purchase starts as "not yet arrived"); the same
          // goes for empty delivery / other costs.
          ...(values.arrivalDate != null ? { receivedAt: values.arrivalDate } : {}),
          ...(deliveryCost != null ? { deliveryCost } : {}),
          ...(otherCost != null ? { otherCost } : {}),
          lines: linePayload,
        });
        toast.success(t().purchases.created);
        router.push(`/purchases/${created._id}`);
      }
    } catch (err) {
      toastError(err);
    } finally {
      setSaving(false);
    }
  }

  function onSubmit(values: PurchaseValues) {
    // Clearing the arrival date takes received stock back off the shelves —
    // confirm once before doing it.
    if (initial && initial.purchase.receivedAt != null && values.arrivalDate == null) {
      setPendingUnarrive(values);
      return;
    }
    void doSave(values);
  }

  return (
    <FormProvider {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="flex flex-col gap-4">
        <Card>
          <CardHeader>
            <div className="flex items-start justify-between gap-2">
              <div>
                <CardTitle>
                  {initial ? t().purchases.editTitle : t().purchases.newTitle}
                </CardTitle>
                <CardDescription>
                  {arrived
                    ? t().purchases.stockInOn.replace("{value}", msToInput(arrivalDate))
                    : t().purchases.arrivalDateHint}
                </CardDescription>
              </div>
              <Badge variant={arrived ? "default" : "secondary"}>
                {arrived ? t().purchases.arrived : t().purchases.notArrived}
              </Badge>
            </div>
          </CardHeader>
          <CardContent className="grid gap-4">
            <FormCombobox
              name="supplierId"
              label={t().purchases.supplier}
              required
              hint={t().purchases.supplierHint}
              options={supplierOptions}
              placeholder={t().purchases.supplier}
            />
            <QuickAddSupplier
              onCreate={(supplier) => {
                form.setValue("supplierId", supplier._id);
                toast.success(t().suppliers.created);
              }}
            />
            <div className="grid gap-4 sm:grid-cols-2">
              <FormDate
                name="purchasedDate"
                label={t().purchases.purchasedDate}
                required
                max={Date.now()}
              />
              <FormDate
                name="arrivalDate"
                label={t().purchases.arrivalDate}
                hint={t().purchases.arrivalDateHint}
                min={purchasedDate ?? undefined}
              />
            </div>
            <FormTextarea
              name="notes"
              label={t().common.note}
              hint={t().purchases.notesHint}
              placeholder={t().purchases.notesHint}
            />
          </CardContent>
        </Card>

        <BulkLineEntry
          key={editLine ? `group-${editLine.product._id}` : "add"}
          lines={lines}
          currency={currency}
          editLine={editLine ?? undefined}
          onCancelEdit={() => setEditLine(null)}
          onSubmitLines={handleBulkSave}
        />

        <Card>
          <CardHeader>
            <CardTitle>{t().purchases.linesTitle}</CardTitle>
          </CardHeader>
          <CardContent>
            {/* Desktop summary table — mobile cards below (same pattern as
                the shared DataTable). */}
            {/* Desktop summary: ONE row per product (image + name), the
                variants nested inside as a compact grid. */}
            <div className="hidden rounded-md border md:block">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t().purchases.product}</TableHead>
                    <TableHead className="text-right">{t().purchases.totalPieces}</TableHead>
                    <TableHead className="text-right">{t().common.total}</TableHead>
                    <TableHead className="text-right">{t().common.actions}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {groups.length === 0 ? (
                    <TableRow>
                      <TableCell
                        colSpan={4}
                        className="text-center text-muted-foreground"
                      >
                        {t().purchases.emptyLines}
                      </TableCell>
                    </TableRow>
                  ) : (
                    groups.map((g) => (
                      <Fragment key={g.product._id}>
                        <TableRow>
                          <TableCell className="font-medium">
                            <div className="flex items-center gap-2">
                              {g.product.imageStorageId ? (
                                // eslint-disable-next-line @next/next/no-img-element
                                <img
                                  src={imageUrl(g.product.imageStorageId)}
                                  alt=""
                                  className="size-9 shrink-0 rounded border object-cover"
                                />
                              ) : (
                                <span className="flex size-9 shrink-0 items-center justify-center rounded border bg-muted text-muted-foreground">
                                  <HugeiconsIcon
                                    icon={Image01Icon}
                                    strokeWidth={2}
                                    className="size-4"
                                  />
                                </span>
                              )}
                              <span className="min-w-0 truncate">{g.product.name}</span>
                            </div>
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {g.pieces}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {formatMoney(g.cost, currency)}
                          </TableCell>
                          <TableCell className="text-right">
                            <div className="flex justify-end gap-1">
                              <Button
                                size="sm"
                                variant="ghost"
                                type="button"
                                onClick={() => setEditLine(g.lines[0])}
                                aria-label={t().common.edit}
                              >
                                <HugeiconsIcon
                                  icon={PencilEdit01Icon}
                                  strokeWidth={2}
                                  className="size-4"
                                />
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                type="button"
                                onClick={() => removeGroup(g.product._id)}
                                aria-label={t().common.delete}
                              >
                                <HugeiconsIcon
                                  icon={Delete02Icon}
                                  strokeWidth={2}
                                  className="size-4"
                                />
                              </Button>
                            </div>
                          </TableCell>
                        </TableRow>
                        {/* Nested variant listing — a plain grid, not a nested
                            <table> (row hover/border styles would clash). */}
                        <TableRow className="hover:bg-transparent">
                          <TableCell colSpan={4} className="px-4 pb-3 pt-0">
                            <div className="overflow-hidden rounded-md border">
                              <div className="grid grid-cols-[minmax(0,1fr)_4rem_6rem_6rem_6rem] items-center gap-2 border-b bg-muted/50 px-3 py-1.5 text-sm font-medium">
                                <span>{t().purchases.size}</span>
                                <span className="text-right">{t().purchases.qty}</span>
                                <span className="text-right">{t().purchases.unitCost}</span>
                                <span className="text-right">{t().purchases.salePrice}</span>
                                <span className="text-right">{t().common.total}</span>
                              </div>
                              {g.lines.map((l, i) => (
                                <div
                                  key={l.key}
                                  className={`grid grid-cols-[minmax(0,1fr)_4rem_6rem_6rem_6rem] items-center gap-2 px-3 py-2 text-sm ${
                                    i < g.lines.length - 1 ? "border-b" : ""
                                  }`}
                                >
                                  <span className="truncate text-muted-foreground">
                                    {l.color ? `${l.size} · ${l.color}` : l.size}
                                  </span>
                                  <span className="text-right tabular-nums">{l.qty}</span>
                                  <span className="text-right tabular-nums">
                                    {formatMoney(l.unitCost, currency)}
                                  </span>
                                  {/* Only a CHANGED price shows — "—" means
                                      the current sale price is kept. */}
                                  <span className="text-right tabular-nums">
                                    {l.price !== undefined && l.price !== l.currentPrice
                                      ? `→ ${formatMoney(l.price, currency)}`
                                      : "—"}
                                  </span>
                                  <span className="text-right tabular-nums">
                                    {formatMoney(l.qty * l.unitCost, currency)}
                                  </span>
                                </div>
                              ))}
                            </div>
                          </TableCell>
                        </TableRow>
                      </Fragment>
                    ))
                  )}
                </TableBody>
              </Table>
            </div>

            {/* Mobile summary: one card per product. */}
            <div className="flex flex-col gap-2 md:hidden">
              {groups.length === 0 ? (
                <p className="py-2 text-center text-sm text-muted-foreground">
                  {t().purchases.emptyLines}
                </p>
              ) : (
                groups.map((g) => (
                  <Card key={g.product._id}>
                    <CardContent className="grid gap-2 p-3">
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex min-w-0 items-center gap-2">
                          {g.product.imageStorageId ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img
                              src={imageUrl(g.product.imageStorageId)}
                              alt=""
                              className="size-9 shrink-0 rounded border object-cover"
                            />
                          ) : (
                            <span className="flex size-9 shrink-0 items-center justify-center rounded border bg-muted text-muted-foreground">
                              <HugeiconsIcon
                                icon={Image01Icon}
                                strokeWidth={2}
                                className="size-4"
                              />
                            </span>
                          )}
                          <div className="min-w-0">
                            <p className="truncate font-medium">{g.product.name}</p>
                            <p className="text-sm text-muted-foreground">
                              {t().purchases.totalPieces}: {g.pieces}
                            </p>
                          </div>
                        </div>
                        <div className="flex shrink-0 items-center gap-1">
                          <span className="text-sm font-semibold tabular-nums">
                            {formatMoney(g.cost, currency)}
                          </span>
                          <Button
                            size="sm"
                            variant="ghost"
                            type="button"
                            onClick={() => setEditLine(g.lines[0])}
                            aria-label={t().common.edit}
                          >
                            <HugeiconsIcon
                              icon={PencilEdit01Icon}
                              strokeWidth={2}
                              className="size-4"
                            />
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            type="button"
                            onClick={() => removeGroup(g.product._id)}
                            aria-label={t().common.delete}
                          >
                            <HugeiconsIcon
                              icon={Delete02Icon}
                              strokeWidth={2}
                              className="size-4"
                            />
                          </Button>
                        </div>
                      </div>
                      <div className="flex flex-col border-t pt-1">
                        {g.lines.map((l) => (
                          <div
                            key={l.key}
                            className="flex items-baseline justify-between gap-2 py-1 text-sm"
                          >
                            <span className="truncate text-muted-foreground">
                              {l.color ? `${l.size} · ${l.color}` : l.size}{" "}
                              <span className="text-foreground">× {l.qty}</span>
                            </span>
                            <span className="shrink-0 text-right tabular-nums">
                              {formatMoney(l.qty * l.unitCost, currency)}
                              {l.price !== undefined && l.price !== l.currentPrice && (
                                <span className="block text-[11px] text-muted-foreground">
                                  → {formatMoney(l.price, currency)}
                                </span>
                              )}
                            </span>
                          </div>
                        ))}
                      </div>
                    </CardContent>
                  </Card>
                ))
              )}
            </div>
          </CardContent>
        </Card>

        {/* Order summary — one totals block: pieces, costs and the grand
            total the owner actually pays. */}
        <Card>
          <CardHeader>
            <CardTitle>{t().purchases.orderSummary}</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <FormMoney
                name="deliveryCost"
                label={`${t().purchases.deliveryCost} (${currency})`}
                placeholder="0.00"
              />
              <FormMoney
                name="otherCost"
                label={`${t().purchases.otherCost} (${currency})`}
                placeholder="0.00"
              />
            </div>
            <dl className="flex flex-col gap-1 border-t pt-3 text-sm">
              <div className="flex items-center justify-between">
                <dt className="text-muted-foreground">{t().purchases.totalPieces}</dt>
                <dd className="tabular-nums">{totalPieces}</dd>
              </div>
              <div className="flex items-center justify-between">
                <dt className="text-muted-foreground">{t().purchases.itemsCost}</dt>
                <dd className="tabular-nums">{formatMoney(totalCost, currency)}</dd>
              </div>
              <div className="flex items-center justify-between">
                <dt className="text-muted-foreground">{t().purchases.deliveryCost}</dt>
                <dd className="tabular-nums">{formatMoney(deliveryCost, currency)}</dd>
              </div>
              <div className="flex items-center justify-between">
                <dt className="text-muted-foreground">{t().purchases.otherCost}</dt>
                <dd className="tabular-nums">{formatMoney(otherCost, currency)}</dd>
              </div>
              <div className="flex items-center justify-between border-t pt-2 font-semibold">
                <dt>{t().purchases.grandTotal}</dt>
                <dd className="tabular-nums">{formatMoney(grandTotal, currency)}</dd>
              </div>
            </dl>
          </CardContent>
        </Card>

        <Card>
          <CardFooter className="border-t">
            {/* Submit bottom-left, cancel next to it (AGENTS.md layout). */}
            <div className="flex items-center gap-2">
              <Button type="submit" disabled={saving}>
                {t().common.save}
              </Button>
              <Button
                type="button"
                variant="destructive"
                onClick={onDone}
                disabled={saving}
              >
                <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} className="size-4" />
                {t().common.cancel}
              </Button>
            </div>
          </CardFooter>
        </Card>

        {/* Un-arrive confirm: clearing the arrival date takes the received
            stock back off the shelves. */}
        <AlertDialog
          open={pendingUnarrive != null}
          onOpenChange={(open) => {
            if (!open) setPendingUnarrive(null);
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{t().purchases.unarriveTitle}</AlertDialogTitle>
              <AlertDialogDescription>
                {t().purchases.unarriveBody}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{t().common.cancel}</AlertDialogCancel>
              <AlertDialogAction
                onClick={() => {
                  const values = pendingUnarrive;
                  setPendingUnarrive(null);
                  if (values) void doSave(values);
                }}
              >
                {t().common.confirm}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </form>
    </FormProvider>
  );
}

/**
 * Quick-add supplier dialog (AGENTS.md T5): name + phone, saved server-side,
 * then picked for this form. Two plain fields — the server re-validates.
 */
function QuickAddSupplier({
  onCreate,
}: {
  onCreate: (supplier: Doc<"suppliers">) => void;
}) {
  const createSupplier = useMutation(api.suppliers.create);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);

  async function submit() {
    if (!name.trim()) return;
    setBusy(true);
    try {
      const supplier = await createSupplier({
        name: name.trim(),
        phone: phone.trim() || undefined,
      });
      onCreate(supplier);
      setName("");
      setPhone("");
      setOpen(false);
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button type="button" variant="outline" size="sm" className="w-fit">
            <HugeiconsIcon icon={PackageAddIcon} strokeWidth={2} className="size-4" />
            {t().purchases.quickAddSupplier}
          </Button>
        }
      />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t().purchases.quickAddSupplier}</DialogTitle>
          <DialogDescription>{t().purchases.quickAddSupplierHint}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="quick-supplier-name">
              {t().common.name} <span className="text-destructive">*</span>
            </Label>
            <Input
              id="quick-supplier-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={100}
              placeholder={t().suppliers.nameHint}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="quick-supplier-phone">{t().suppliers.phone}</Label>
            <Input
              id="quick-supplier-phone"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              maxLength={50}
              inputMode="tel"
              placeholder="012 345 678"
            />
          </div>
          <div className="flex justify-end gap-2">
            <DialogClose render={<Button variant="outline">{t().common.cancel}</Button>} />
            <Button onClick={() => void submit()} disabled={busy || !name.trim()}>
              {t().common.save}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
