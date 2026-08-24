"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { Cancel01Icon, Tick02Icon, Undo02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FormProvider, useController, useForm, useFormContext } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";

import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { FormField } from "@/components/features/forms/form-field";
import {
  FormMoney,
  moneyInputSchema,
  optionalMoneySchema,
} from "@/components/features/forms/form-money";
import {
  FormSelect,
  type FormSelectOption,
} from "@/components/features/forms/form-select";
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
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "@/components/ui/combobox";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useCurrentUser } from "@/hooks/use-current-user";
import { useIdempotentSubmit } from "@/hooks/use-idempotent-submit";
import { useShop } from "@/hooks/use-shop";
import {
  centsToInput,
  formatDateTime,
  formatMoney,
  getLang,
  inputToCents,
  t,
  toastError,
} from "@/lib/utils";
import {
  SaleEditItemsTable,
  lineChanged,
  lineDiscount,
  lineError,
  linePrice,
  lineQty,
  lineSubtotal,
  projectAvailability,
  type EditLine,
} from "./sale-edit-items-table";
import { ALL_STATUSES, CAN_CANCEL, NEXT_STEPS, type SaleStatus } from "./sale-status-flow";
import { CancelSaleReviewDialog } from "./cancel-sale-review-dialog";
import { ResolutionDialog, type PendingResolution } from "./resolution-dialog";

// T12 — the full-page order editor. Items, order fields and status are edited
// together and saved in ONE mutation, which is ONE Convex transaction: either
// every stock movement lands or none does. Nothing on this page touches the
// database until Save.

export type SaleEditData = NonNullable<
  FunctionReturnType<typeof api.sales.getEditData>
>;

const schema = z.object({
  customerId: z.string().min(1),
  channelId: z.string().min(1),
  companyId: z.string(), // "" = Self / pickup
  status: z.string().min(1),
  deliveryFee: optionalMoneySchema,
  deliveryCost: optionalMoneySchema,
  discount: moneyInputSchema,
  note: z.string().max(500),
});

type FormValues = z.infer<typeof schema>;

/** Customer picker with SERVER-side search (name/phone, debounced). The
 * current customer's label is seeded so a deactivated one still shows its
 * name instead of a bare id. */
function CustomerField({ seedLabel }: { seedLabel: string }) {
  const { control } = useFormContext();
  const { field, fieldState } = useController({ control, name: "customerId" });
  const user = useCurrentUser();

  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query), 300);
    return () => clearTimeout(timer);
  }, [query]);

  const customers = useQuery(
    api.customers.listActive,
    user == null ? "skip" : { search: debouncedQuery.trim() || undefined }
  );

  const labelById = useMemo(
    () =>
      new Map<string, string>(
        (customers ?? []).map((c) => [
          c._id,
          `${c.name}${c.phone ? ` · ${c.phone}` : ""}`,
        ])
      ),
    [customers]
  );

  return (
    <FormField
      label={t().sales.customer}
      htmlFor="sale-edit-customer"
      required
      error={fieldState.error?.message}
    >
      <Combobox
        items={(customers ?? []).map((c) => c._id)}
        itemToStringLabel={(item) => {
          if (item == null) return "";
          const value =
            typeof item === "object" && "value" in item
              ? String((item as { value: unknown }).value)
              : String(item);
          if (value === field.value) return labelById.get(value) ?? seedLabel;
          return labelById.get(value) ?? value;
        }}
        value={(field.value as string | undefined) ?? null}
        onValueChange={(value) => field.onChange(value ?? "")}
        // Only user typing drives the server search — Base UI's programmatic
        // fills (selection sync) arrive with a different reason.
        onInputValueChange={(inputValue, eventDetails) => {
          if (eventDetails?.reason === "input-change") setQuery(inputValue);
        }}
      >
        <ComboboxInput
          id="sale-edit-customer"
          placeholder={t().sales.searchCustomers}
          showClear
          aria-invalid={fieldState.error != null}
          onFocus={(e) => (e.target as HTMLInputElement).select()}
        />
        <ComboboxContent>
          <ComboboxEmpty>{t().sales.noCustomers}</ComboboxEmpty>
          <ComboboxList>
            {(customers ?? []).map((c) => (
              <ComboboxItem key={c._id} value={c._id}>
                <span className="truncate">{c.name}</span>
                {c.phone ? (
                  <span className="text-xs text-muted-foreground">· {c.phone}</span>
                ) : null}
              </ComboboxItem>
            ))}
          </ComboboxList>
        </ComboboxContent>
      </Combobox>
    </FormField>
  );
}

/** The order's lines as editable rows. `maxQty` comes from the server: the
 * pieces this line already bills plus what's left on the shelf — the stock
 * column shows the real shelf. `inputMax` is the same ceiling on every line
 * (a delivered order is no exception — a raise there splits into its own
 * internal line, so the quantity box may grow exactly like anywhere else). */
function toEditLines(data: SaleEditData): EditLine[] {
  return data.items.map(
    ({
      item,
      variant,
      product,
      billedQty,
      maxQty,
      currentPrice,
      returnedOutcome,
      stock,
    }) => ({
    key: item._id,
    saleItemId: item._id,
    variantId: variant._id,
    productName: product.name,
    variantLabel: variant.color ? `${variant.size} · ${variant.color}` : variant.size,
    sku: variant.sku,
    imageStorageId: product.imageStorageId,
    qty: String(billedQty),
    price: centsToInput(item.unitPrice),
    discount: item.discount ? centsToInput(item.discount) : "",
    originalQty: billedQty,
    originalPrice: item.unitPrice,
    originalDiscount: item.discount ?? 0,
    qtyDelivered: item.qtyDelivered,
    qtyReturned: item.qtyReturned,
    maxQty,
    inputMax: maxQty,
    // What a raise's extra pieces are priced at — the variant's CURRENT
    // sell price (server-derived, matches saveEdit's split-line pricing).
    currentPrice,
    // A line that already bills nothing was cancelled or returned long ago.
    // It opens in the removed state — it is history, not a row to fix.
    removed: billedQty === 0,
    // What came back: the badge says "Returned · Sellable" (or Damaged)
    // instead of the generic "Removed" when the ledger proves a return.
    returnedOutcome,
    // Current database stock of this variant — the base of the shared
    // stock projection (same value on every line of the variant).
    stock,
  }));
}

export function SaleEditForm({
  data,
  onDone,
}: {
  data: SaleEditData;
  onDone: () => void;
}) {
  const shop = useShop();
  const lang = getLang();
  const labels = t().sales.edit;
  const currency = shop?.currency ?? "USD";
  const deliveryEnabled = shop?.deliveryEnabled === true;

  const saveEdit = useMutation(api.sales.saveEdit);
  const editSubmit = useIdempotentSubmit({
    operation: "sales.saveEdit",
    resource: data.sale._id,
  });
  const channels = useQuery(api.channels.listActive, {});
  const companies = useQuery(api.deliveryCompanies.listActive, {});

  const sale = data.sale;
  // The order itself may carry delivery data from when the module was on —
  // those fields must stay visible and editable even after the shop turned
  // the module off, or the shipping fee silently vanishes from the editor.
  const deliveryEditable =
    deliveryEnabled ||
    sale.deliveryFee > 0 ||
    sale.deliveryCost > 0 ||
    sale.deliveryCompanyId != null;
  const user = useCurrentUser();
  const [lines, setLines] = useState<EditLine[]>(() => toEditLines(data));
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [confirmLeave, setConfirmLeave] = useState(false);
  // Pending return/correction resolutions + refund — collected by the
  // resolution dialog and applied in the SAME save call (one transaction;
  // the server re-derives and re-validates every bound).
  const [pendingResolutions, setPendingResolutions] = useState<PendingResolution[]>([]);
  const [refundCents, setRefundCents] = useState(0);
  const [refundNote, setRefundNote] = useState("");
  const [resolveLine, setResolveLine] = useState<EditLine | null>(null);
  const [cancelReviewOpen, setCancelReviewOpen] = useState(false);
  // Extra items on a DELIVERED order: one choice for how the customer gets
  // them, and it decides the order's status (handed now → stays Delivered;
  // deliver later → Partially delivered). The server enforces the same rule.
  const [newFulfillment, setNewFulfillment] = useState<"handed_now" | "deliver_later">(
    "handed_now"
  );

  // Pieces per line already covered by pending resolutions (returnable
  // outcomes only — still_with_customer doesn't shrink the edit floor).
  const resolvedQtyByLine = useMemo(() => {
    const map: Record<string, number> = {};
    for (const r of pendingResolutions) {
      if (r.outcome === "still_with_customer") continue;
      map[r.saleItemId] = (map[r.saleItemId] ?? 0) + r.qty;
    }
    return map;
  }, [pendingResolutions]);

  // Pieces per line that flow back onto the shelf when this save runs:
  // sellable returns and wrong-delivery corrections. Persisted returns are
  // ALREADY in the database stock (the ledger row was written on their
  // save) — they never appear here again.
  const returnInByLine = useMemo(() => {
    const map = new Map<string, number>();
    for (const r of pendingResolutions) {
      if (
        r.outcome === "returned_sellable" ||
        r.outcome === "delivery_incorrect"
      ) {
        map.set(r.saleItemId, (map.get(r.saleItemId) ?? 0) + r.qty);
      }
    }
    return map;
  }, [pendingResolutions]);

  // Pieces per line that drop off the bill in this save (every return
  // outcome — damaged pieces leave the bill without adding stock).
  const billCutByLine = useMemo(() => {
    const map = new Map<string, number>();
    for (const r of pendingResolutions) {
      if (
        r.outcome === "returned_sellable" ||
        r.outcome === "returned_damaged" ||
        r.outcome === "delivery_incorrect"
      ) {
        map.set(r.saleItemId, (map.get(r.saleItemId) ?? 0) + r.qty);
      }
    }
    return map;
  }, [pendingResolutions]);

  // The shared shelf projection — ONE source feeding both the Available
  // stock column and the quantity validation, so the two can never show
  // contradictory numbers (the bug this projection replaces).
  const availabilityByVariant = useMemo(
    () => projectAvailability(lines, returnInByLine, billCutByLine),
    [lines, returnInByLine, billCutByLine]
  );

  // The latest pending return outcome per line — the table names a pending
  // return ("Pending return · Sellable") and shows its stock effect.
  const pendingOutcomeByLine = useMemo(() => {
    const map: Record<
      string,
      { outcome: "sellable" | "damaged" | "incorrect"; qty: number }
    > = {};
    for (const r of pendingResolutions) {
      if (r.outcome === "returned_sellable") {
        map[r.saleItemId] = { outcome: "sellable", qty: r.qty };
      } else if (r.outcome === "returned_damaged") {
        map[r.saleItemId] = { outcome: "damaged", qty: r.qty };
      } else if (r.outcome === "delivery_incorrect") {
        map[r.saleItemId] = { outcome: "incorrect", qty: r.qty };
      }
    }
    return map;
  }, [pendingResolutions]);

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      customerId: sale.customerId,
      channelId: sale.salesChannelId,
      companyId: sale.deliveryCompanyId ?? "",
      // The order opens on the status it already has (never a blank field).
      status: sale.status,
      deliveryFee: sale.deliveryFee > 0 ? centsToInput(sale.deliveryFee) : "",
      deliveryCost: sale.deliveryCost > 0 ? centsToInput(sale.deliveryCost) : "",
      discount: centsToInput(sale.discount),
      note: sale.note ?? "",
    },
  });

  // The current channel/company may be inactive and missing from the active
  // lists — keep a fallback option so the field still shows its name.
  const channelOptions = useMemo<FormSelectOption[]>(() => {
    const list = (channels ?? []).map((c) => ({ value: c._id, label: c.name }));
    if (!list.some((o) => o.value === sale.salesChannelId)) {
      list.unshift({ value: sale.salesChannelId, label: data.channel.name });
    }
    return list;
  }, [channels, sale.salesChannelId, data.channel.name]);

  const companyOptions = useMemo<FormSelectOption[]>(() => {
    const list: FormSelectOption[] = [
      { value: "", label: t().sales.noCompany },
      ...(companies ?? []).map((c) => ({ value: c._id, label: c.name })),
    ];
    if (
      sale.deliveryCompanyId &&
      !list.some((o) => o.value === sale.deliveryCompanyId) &&
      data.company
    ) {
      list.push({ value: sale.deliveryCompanyId, label: data.company.name });
    }
    return list;
  }, [companies, sale.deliveryCompanyId, data.company]);

  // Every delivery stage stays visible so the whole journey is legible; the
  // ones this order can't reach from here are greyed, exactly as the server's
  // ALLOWED_TRANSITIONS would refuse them.
  const statusOptions = useMemo<FormSelectOption[]>(() => {
    const allowed = NEXT_STEPS[sale.status] ?? [];
    const options: FormSelectOption[] = ALL_STATUSES.map((status) => ({
      value: status,
      label:
        status === sale.status
          ? `${t().status[status]} · ${t().sales.statusNow}`
          : t().status[status],
      disabled: status !== sale.status && !allowed.includes(status),
    }));
    // A status the list doesn't carry (a draft) must still show rather than
    // silently reset the field to something else.
    if (!options.some((o) => o.value === sale.status)) {
      options.unshift({
        value: sale.status,
        label: `${t().status[sale.status]} · ${t().sales.statusNow}`,
      });
    }
    return options;
  }, [sale.status]);

  const seedLabel = `${data.customer.name}${
    data.customer.phone ? ` · ${data.customer.phone}` : ""
  }`;

  // --- Live totals. Display only: the server recomputes every one of these
  // from its own rows on save and is the one that decides. ---
  const itemsSubtotal = lines.reduce(
    (sum, l) => sum + lineSubtotal(l, billCutByLine.get(l.key) ?? 0),
    0
  );
  const orderDiscount = inputToCents(form.watch("discount")) ?? 0;
  const shippingFee = deliveryEditable
    ? (inputToCents(form.watch("deliveryFee")) ?? 0)
    : sale.deliveryFee;
  const total = Math.max(0, itemsSubtotal - orderDiscount + shippingFee);
  const remaining = total - data.paid;

  // New lines (the Add-an-item search) — on a delivered order these carry
  // the fulfillment choice that drives the order's status.
  const newLines = lines.filter((l) => l.saleItemId === undefined);
  const fulfillmentActive = sale.status === "delivered" && newLines.length > 0;
  const derivedStatus: SaleStatus | null = fulfillmentActive
    ? newFulfillment === "deliver_later"
      ? "partially_delivered"
      : "delivered"
    : null;

  /** "Basic Tee — M · Black" for a pending resolution row (saleItemId is the
   * line key for saved lines). */
  const lineLabelOf = useCallback((saleItemId: string): string => {
    const line = lines.find((l) => l.key === saleItemId);
    return line ? `${line.productName} — ${line.variantLabel}` : saleItemId;
  }, [lines]);

  // What this save moves on the shelf, per line: pending returns and
  // wrong-delivery corrections flow back in; undelivered quantity cuts
  // return the difference; new/increased lines go out. Damaged returns
  // net to zero (the damage adjustment cancels the return row). This is
  // the SAME math the server's saveEdit writes — mirroring it here means
  // the summary always agrees with the ledger rows the save produces.
  const netStockRows = useMemo(() => {
    // Keyed by VARIANT, not by line: two lines of the same variant are
    // one shelf movement (and the server checks stock per variant). That
    // also keeps the rendered row keys unique — product names aren't.
    const byVariant = new Map<string, { key: string; label: string; net: number }>();
    const bump = (variantId: string, label: string, delta: number) => {
      const cur = byVariant.get(variantId);
      byVariant.set(variantId, {
        key: variantId,
        label,
        net: (cur?.net ?? 0) + delta,
      });
    };
    for (const line of lines) {
      const returnIn = returnInByLine.get(line.key) ?? 0;
      const billCut = billCutByLine.get(line.key) ?? 0;
      const billedAfter = Math.max(0, line.originalQty - billCut);
      const activeQty = line.removed ? 0 : (lineQty(line) ?? 0);
      const net = returnIn + billedAfter - activeQty;
      if (net !== 0) bump(line.variantId, lineLabelOf(line.key), net);
    }
    return [...byVariant.values()];
  }, [lines, returnInByLine, billCutByLine, lineLabelOf]);

  // Money in the change summary: what the order ends up at vs where it
  // started, and whether the shipping fee moved.
  const prevTotal = data.total;
  const totalDelta = total - prevTotal;
  const refundDue = total < data.paid ? data.paid - total : 0;
  const shippingChanged = shippingFee !== sale.deliveryFee;

  // While new lines decide the status, the dropdown mirrors the derived one
  // (it is disabled below) — the save can never send a conflicting status.
  // When the last new line is removed, the order's real status comes back.
  useEffect(() => {
    if (fulfillmentActive) {
      form.setValue("status", derivedStatus ?? sale.status);
    } else if (form.getValues("status") !== sale.status) {
      form.setValue("status", sale.status);
    }
  }, [fulfillmentActive, newFulfillment, form, derivedStatus, sale.status]);

  const rowErrors = lines.some(
    (l) =>
      lineError(
        l,
        resolvedQtyByLine[l.key] ?? 0,
        availabilityByVariant,
        billCutByLine.get(l.key) ?? 0
      ) != null
  );
  const liveLines = lines.filter((l) => !l.removed).length;
  const dirty =
    form.formState.isDirty ||
    lines.length !== data.items.length ||
    lines.some((l) => lineChanged(l)) ||
    pendingResolutions.length > 0 ||
    refundCents > 0;

  // Warn before a reload/close throws the edits away — the same promise the
  // Cancel button makes, enforced by the browser.
  useEffect(() => {
    if (!dirty || saving) return;
    function warn(event: BeforeUnloadEvent) {
      event.preventDefault();
      event.returnValue = "";
    }
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty, saving]);

  /** The resolution dialog confirmed what happened to held pieces: record it
   * and follow the new floor on the line (all resolved → removed). */
  function handleResolveConfirm(resolution: PendingResolution) {
    setPendingResolutions((prev) => [...prev, resolution]);
    if (resolution.outcome === "still_with_customer") return;
    const line = lines.find((l) => l.key === resolution.saleItemId);
    if (!line) return;
    const held = line.qtyDelivered - line.qtyReturned;
    const newFloor = held - (resolvedQtyByLine[line.key] ?? 0) - resolution.qty;
    setLines((prev) =>
      prev.map((l) =>
        l.key === line.key
          ? newFloor <= 0
            ? { ...l, removed: true }
            : {
                ...l,
                removed: false,
                qty: String(Math.max(lineQty(l) ?? 0, newFloor)),
              }
          : l
      )
    );
  }

  /** Undo a pending resolution: the floor rises again, so the line follows
   * it back (never below one piece — a fully-removed line is restored at
   * the new floor, which is ≥ 1 by construction when the floor is > 0). */
  function undoResolution(resolution: PendingResolution) {
    const line = lines.find((l) => l.key === resolution.saleItemId);
    setPendingResolutions((prev) => prev.filter((r) => r.key !== resolution.key));
    if (!line || resolution.outcome === "still_with_customer") return;
    const held = line.qtyDelivered - line.qtyReturned;
    const floorAfter =
      held - (resolvedQtyByLine[line.key] ?? 0) + resolution.qty;
    const qty = lineQty(line) ?? 0;
    setLines((prev) =>
      prev.map((l) =>
        l.key === line.key
          ? { ...l, removed: false, qty: String(Math.max(qty, Math.max(1, floorAfter))) }
          : l
      )
    );
  }

  /** Undo from the ITEMS TABLE: pops the line's most recent pending
   * resolution (the one whose badge the button sits under). Only pending
   * client-side resolutions are undoable — a persisted return has no Undo. */
  function handleUndoResolution(line: EditLine) {
    for (let i = pendingResolutions.length - 1; i >= 0; i--) {
      const r = pendingResolutions[i];
      if (r.saleItemId === line.key) {
        undoResolution(r);
        return;
      }
    }
  }

  async function save(values: FormValues) {
    // Guard against a double click before the disabled state re-renders —
    // the second save would land on a bumped version and look like a conflict.
    if (savingRef.current) return;
    if (rowErrors) {
      toast.error(labels.fixErrors);
      return;
    }
    savingRef.current = true;
    setSaving(true);
    try {
      // Only ids, quantities and intents cross the wire — the server re-derives
      // every price, cost and total from the database (AGENTS.md).
      const items = lines.map((line) => {
        const qty = line.removed ? 0 : (lineQty(line) ?? 0);
        const price = linePrice(line) ?? undefined;
        const discount = lineDiscount(line);
        if (line.saleItemId !== undefined) {
          return {
            saleItemId: line.saleItemId,
            qty,
            // null clears a discount the line used to carry.
            discount: discount != null && discount > 0 ? discount : null,
            ...(price !== undefined ? { price } : {}),
          };
        }
        return {
          variantId: line.variantId,
          qty,
          ...(discount != null && discount > 0 ? { discount } : {}),
          ...(price !== undefined ? { price } : {}),
          // Delivered orders: how the customer gets this extra item — the
          // server derives the order's status from it (and re-validates it).
          ...(fulfillmentActive ? { fulfillment: newFulfillment } : {}),
        };
      });

      const editPayload = {
        saleId: sale._id,
        // The version this page loaded — the server refuses the save when the
        // order changed in another window since (stale-edit guard).
        expectedVersion: data.version,
        items,
        customerId: values.customerId as Id<"customers">,
        salesChannelId: values.channelId as Id<"salesChannels">,
        // Delivery fields whenever the module is on OR the order already
        // carries delivery data (fee/company from when it was on) — the
        // server keeps current values otherwise and rejects new fees while
        // the module is off.
        ...(deliveryEditable
          ? {
              deliveryCompanyId: (values.companyId ||
                null) as Id<"deliveryCompanies"> | null,
              deliveryFee:
                values.deliveryFee === "" ? null : inputToCents(values.deliveryFee),
              deliveryCost:
                values.deliveryCost === "" ? null : inputToCents(values.deliveryCost),
            }
          : {}),
        discount: inputToCents(values.discount) ?? 0,
        note: values.note.trim() || null,
        ...(values.status !== sale.status
          ? { status: values.status as SaleStatus }
          : {}),
        // The approved physical outcomes + refund ride in the SAME save —
        // one transaction, so a failed edit can never leave a half-applied
        // return (the server validates every bound again).
        ...(pendingResolutions.length > 0
          ? {
              resolutions: pendingResolutions.map((r) => ({
                saleItemId: r.saleItemId as Id<"saleItems">,
                outcome: r.outcome,
                qty: r.qty,
                ...(r.reason ? { reason: r.reason } : {}),
              })),
            }
          : {}),
        ...(refundCents > 0
          ? { refund: { amount: refundCents, note: refundNote.trim() || undefined } }
          : {}),
      };
      const idempotencyKey = editSubmit.begin(editPayload);
      await saveEdit({ ...editPayload, idempotencyKey });
      editSubmit.complete(editPayload, idempotencyKey);
      toast.success(labels.saved);
      onDone();
    } catch (err) {
      toastError(err);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  function cancel() {
    if (dirty) {
      setConfirmLeave(true);
      return;
    }
    onDone();
  }

  return (
    <FormProvider {...form}>
      <form
        onSubmit={form.handleSubmit((values) => void save(values))}
        className="flex flex-col gap-4 pb-24 md:pb-0"
        noValidate
      >
        <Card>
          <CardHeader>
            <CardTitle>{labels.orderCard}</CardTitle>
            <CardDescription>
              {sale.code} ·{" "}
              {formatDateTime(
                sale.createdAt,
                shop?.timezone ?? "Asia/Phnom_Penh",
                lang
              )}
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <CustomerField seedLabel={seedLabel} />
              <FormSelect
                name="channelId"
                label={t().sales.channel}
                options={channelOptions}
                required
              />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <FormSelect
                name="status"
                label={t().sales.status}
                options={statusOptions}
                hint={
                  fulfillmentActive
                    ? labels.statusFollowsFulfillment
                    : t().sales.statusPickHint
                }
                disabled={fulfillmentActive}
                required
              />
              {deliveryEditable ? (
                <FormSelect
                  name="companyId"
                  label={t().sales.company}
                  options={companyOptions}
                />
              ) : null}
            </div>
            <FormTextarea
              name="note"
              label={t().sales.saleNote}
              hint={t().sales.saleNoteHint}
              rows={2}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{labels.itemsCard}</CardTitle>
            <CardDescription>{labels.itemsCardHint}</CardDescription>
          </CardHeader>
          <CardContent>
            <SaleEditItemsTable
              lines={lines}
              onChange={setLines}
              currency={currency}
              disabled={saving}
              resolvedQtyByLine={resolvedQtyByLine}
              onResolveLine={setResolveLine}
              availabilityByVariant={availabilityByVariant}
              billCutByLine={Object.fromEntries(billCutByLine)}
              pendingOutcomeByLine={pendingOutcomeByLine}
              onUndoResolution={handleUndoResolution}
            />
          </CardContent>
        </Card>

        {/* Pending return/correction resolutions — what this save will apply
            beyond the plain line edits. Shown before Save; each entry can be
            undone. */}
        <Card>
          <CardHeader>
            <CardTitle>{labels.changeSummaryTitle}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3 text-sm">
            {pendingResolutions.length === 0 &&
            refundCents === 0 &&
            newLines.length === 0 &&
            netStockRows.length === 0 ? (
              <p className="text-muted-foreground">{labels.changeSummaryEmpty}</p>
            ) : (
              <>
                {fulfillmentActive && (
                  <div className="grid gap-1.5">
                    <Label className="text-sm font-medium">
                      {labels.fulfillmentAsk}
                    </Label>
                    <Select
                      value={newFulfillment}
                      // Base UI shows the RAW value in the trigger without
                      // this map.
                      items={{
                        handed_now: labels.fulfillmentHandedNow,
                        deliver_later: labels.fulfillmentDeliverLater,
                      }}
                      onValueChange={(value) =>
                        setNewFulfillment(value as "handed_now" | "deliver_later")
                      }
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="handed_now">
                          {labels.fulfillmentHandedNow}
                        </SelectItem>
                        <SelectItem value="deliver_later">
                          {labels.fulfillmentDeliverLater}
                        </SelectItem>
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-muted-foreground">
                      {newFulfillment === "handed_now"
                        ? labels.fulfillmentHandedNowHint
                        : labels.fulfillmentDeliverLaterHint}
                    </p>
                  </div>
                )}
                {(
                  [
                    ["returned_sellable", labels.changeSummarySellable, ""],
                    ["returned_damaged", labels.changeSummaryDamaged, ""],
                    [
                      "still_with_customer",
                      labels.changeSummaryStill,
                      ` ${labels.changeSummaryStillSuffix}`,
                    ],
                    ["delivery_incorrect", labels.changeSummaryIncorrect, ""],
                  ] as const
                ).map(([outcome, heading, suffix]) => {
                  const group = pendingResolutions.filter((r) => r.outcome === outcome);
                  if (group.length === 0) return null;
                  return (
                    <div key={outcome} className="grid gap-1">
                      <p className="font-medium">{heading}</p>
                      {group.map((r) => (
                        <div
                          key={r.key}
                          className="flex items-center justify-between gap-2"
                        >
                          <span className="text-muted-foreground">
                            •{" "}
                            {lineLabelOf(r.saleItemId)}
                            {" ×"}
                            {r.qty}
                            {suffix}
                          </span>
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            onClick={() => undoResolution(r)}
                            disabled={saving}
                            aria-label={labels.changeSummaryUndo}
                          >
                            <HugeiconsIcon
                              icon={Undo02Icon}
                              strokeWidth={2}
                              className="size-4"
                            />
                          </Button>
                        </div>
                      ))}
                    </div>
                  );
                })}
                {newLines.length > 0 && (
                  <div className="grid gap-1 border-t pt-2">
                    <p className="font-medium">{labels.changeSummaryNewItems}</p>
                    {newLines.map((l) => (
                      <div
                        key={l.key}
                        className="flex items-center justify-between gap-2"
                      >
                        <span className="text-muted-foreground">
                          • {l.productName} — {l.variantLabel} ×{lineQty(l) ?? 0}
                        </span>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          onClick={() =>
                            setLines((prev) => prev.filter((x) => x.key !== l.key))
                          }
                          disabled={saving}
                          aria-label={labels.changeSummaryUndo}
                        >
                          <HugeiconsIcon
                            icon={Undo02Icon}
                            strokeWidth={2}
                            className="size-4"
                          />
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
                {netStockRows.length > 0 && (
                  <div className="grid gap-1 border-t pt-2">
                    <p className="font-medium">{labels.changeSummaryNetStock}</p>
                    {netStockRows.map((row) => (
                      <div
                        key={row.key}
                        className="flex items-center justify-between gap-2"
                      >
                        <span className="text-muted-foreground">• {row.label}</span>
                        <span className="tabular-nums">
                          {row.net > 0 ? `+${row.net}` : row.net}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
                {(totalDelta !== 0 || shippingChanged) && (
                  <div className="grid gap-1 border-t pt-2">
                    <p className="font-medium">{labels.changeSummaryMoney}</p>
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-muted-foreground">
                        {labels.changeSummaryPrevTotal}
                      </span>
                      <span className="tabular-nums">
                        {formatMoney(prevTotal, currency)}
                      </span>
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-muted-foreground">
                        {labels.changeSummaryNewTotal}
                      </span>
                      <span className="tabular-nums">
                        {formatMoney(total, currency)}
                      </span>
                    </div>
                    {totalDelta !== 0 && (
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-muted-foreground">
                          {totalDelta > 0
                            ? labels.changeSummaryAdditional
                            : refundDue > 0
                              ? labels.changeSummaryRefundDue
                              : labels.changeSummaryLessOwed}
                        </span>
                        <span className="tabular-nums">
                          {totalDelta > 0
                            ? `+${formatMoney(totalDelta, currency)}`
                            : refundDue > 0
                              ? formatMoney(refundDue, currency)
                              : `−${formatMoney(-totalDelta, currency)}`}
                        </span>
                      </div>
                    )}
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-muted-foreground">
                        {labels.changeSummaryShippingChange}
                      </span>
                      <span className="tabular-nums">
                        {shippingChanged
                          ? `${shippingFee > sale.deliveryFee ? "+" : "−"}${formatMoney(
                              Math.abs(shippingFee - sale.deliveryFee),
                              currency
                            )}`
                          : labels.changeSummaryShippingUnchanged}
                      </span>
                    </div>
                  </div>
                )}
                {refundCents > 0 ? (
                  <div className="flex items-center justify-between gap-2 border-t pt-2">
                    <span>
                      <span className="font-medium">{labels.changeSummaryRefund}</span>
                      <span className="text-muted-foreground">
                        {" "}
                        • {formatMoney(refundCents, currency)}
                      </span>
                    </span>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setRefundCents(0);
                        setRefundNote("");
                      }}
                      disabled={saving}
                      aria-label={labels.changeSummaryUndo}
                    >
                      <HugeiconsIcon icon={Undo02Icon} strokeWidth={2} className="size-4" />
                    </Button>
                  </div>
                ) : null}
              </>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{labels.summaryCard}</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <FormMoney
                name="discount"
                label={`${t().sales.orderDiscount} (${currency})`}
                placeholder="0.00"
                hint={t().sales.orderDiscountHint}
              />
              {deliveryEditable ? (
                <FormMoney
                  name="deliveryFee"
                  label={`${t().sales.deliveryFee} (${currency})`}
                  placeholder="0.00"
                  hint={t().sales.deliveryFeeHint}
                />
              ) : null}
            </div>
            {deliveryEditable ? (
              <FormMoney
                name="deliveryCost"
                label={`${t().sales.companyCost} (${currency})`}
                placeholder="0.00"
                hint={t().sales.companyCostHint}
              />
            ) : null}
            <dl className="flex flex-col gap-1 border-t pt-3 text-sm">
              <div className="flex items-center justify-between">
                <dt className="text-muted-foreground">{labels.itemsSubtotal}</dt>
                <dd className="tabular-nums">{formatMoney(itemsSubtotal, currency)}</dd>
              </div>
              <div className="flex items-center justify-between">
                <dt className="text-muted-foreground">{t().sales.orderDiscount}</dt>
                <dd className="tabular-nums">−{formatMoney(orderDiscount, currency)}</dd>
              </div>
              <div className="flex items-center justify-between">
                <dt className="text-muted-foreground">{t().sales.deliveryFee}</dt>
                <dd className="tabular-nums">{formatMoney(shippingFee, currency)}</dd>
              </div>
              <div className="flex items-center justify-between border-t pt-2 font-semibold">
                <dt>{t().sales.total}</dt>
                <dd className="tabular-nums">{formatMoney(total, currency)}</dd>
              </div>
              <div className="flex items-center justify-between">
                <dt className="text-muted-foreground">{t().sales.paid}</dt>
                <dd className="tabular-nums">{formatMoney(data.paid, currency)}</dd>
              </div>
              <div className="flex items-center justify-between">
                <dt className="text-muted-foreground">{labels.stillOwed}</dt>
                <dd className="tabular-nums">{formatMoney(remaining, currency)}</dd>
              </div>
            </dl>
          </CardContent>
        </Card>

        {/* Sticky action bar on a phone, a plain footer card from md up. */}
        <div className="fixed inset-x-0 bottom-0 z-20 border-t bg-background/95 p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur md:static md:rounded-md md:border md:p-4 md:pb-4">
          <div className="mx-auto flex max-w-7xl items-center gap-2">
            <Button type="submit" disabled={saving || rowErrors || liveLines === 0}>
              <HugeiconsIcon icon={Tick02Icon} strokeWidth={2} className="size-4" />
              {saving ? labels.saving : labels.saveChanges}
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={cancel}
              disabled={saving}
            >
              <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} className="size-4" />
              {t().common.cancel}
            </Button>
            {CAN_CANCEL.includes(sale.status) ? (
              <Button
                type="button"
                variant="outline"
                onClick={() => setCancelReviewOpen(true)}
                disabled={saving}
              >
                {labels.cancelOrderAction}
              </Button>
            ) : null}
            <span className="ms-auto text-sm font-semibold tabular-nums">
              {formatMoney(total, currency)}
            </span>
          </div>
        </div>

        <AlertDialog open={confirmLeave} onOpenChange={setConfirmLeave}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{labels.unsavedTitle}</AlertDialogTitle>
              <AlertDialogDescription>{labels.unsavedBody}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{labels.unsavedStay}</AlertDialogCancel>
              <AlertDialogAction
                onClick={() => {
                  setConfirmLeave(false);
                  onDone();
                }}
              >
                {labels.unsavedLeave}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        {/* Held-line resolutions: mounted fresh each open, so the state always
            starts from the current line values. */}
        {resolveLine ? (
          <ResolutionDialog
            line={resolveLine}
            held={resolveLine.qtyDelivered - resolveLine.qtyReturned}
            resolvedQty={resolvedQtyByLine[resolveLine.key] ?? 0}
            refundCents={refundCents}
            onRefundChange={setRefundCents}
            paidCents={data.paid}
            currency={currency}
            userIsOwner={user?.role === "owner"}
            onConfirm={handleResolveConfirm}
            onClose={() => setResolveLine(null)}
          />
        ) : null}

        {/* Guided cancellation — every held piece needs a physical outcome
            before the order can be cancelled. */}
        {cancelReviewOpen ? (
          <CancelSaleReviewDialog
            saleId={sale._id}
            currency={currency}
            onClose={() => setCancelReviewOpen(false)}
            onCancelled={onDone}
          />
        ) : null}
      </form>
    </FormProvider>
  );
}
